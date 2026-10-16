import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { AppConfigService } from '../common/config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import { isEmail, normaliseEmail, normalisePhone } from '../auth/identifier';
import {
  codeMayBeReturned,
  ContactDeliveryProvider,
  OutboxDeliveryProvider,
} from './contact-delivery';

/**
 * Proving somebody holds a contact.
 *
 * **This is not two-step login verification.** It answers "is this really your
 * address" once, during registration. Optional login 2FA is a different feature
 * and still does not exist.
 *
 * Every property the brief asks for is a property of the row, not of a
 * convention: the code is bound to one destination, short-lived, single-use,
 * attempt-limited, and stored only as a hash — keyed with the server's pepper
 * since 0093, so a leaked database alone cannot be searched for the code (a
 * six-digit code under an unkeyed hash is a million guesses away). What
 * delivery did with each code is recorded on its row; a code that could not be
 * sent is dead at once, and is never shown instead.
 */

/** Long enough to resist guessing at six attempts, short enough to read aloud. */
const CODE_DIGITS = 6;
const TTL_MINUTES = 10;
const MAX_ATTEMPTS = 6;
/** How many codes one destination may be sent in the window. */
const MAX_SENDS_PER_HOUR = 5;

@Injectable()
export class ContactVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly delivery: ContactDeliveryProvider,
    private readonly outbox: OutboxDeliveryProvider,
    @Optional() private readonly config?: AppConfigService,
  ) {}

  /**
   * The code's hash, by version: 2 = HMAC-SHA256 under OTP_PEPPER; 1 = the earlier unkeyed SHA-256, kept only to
   * check a code issued before 0093 (or on a development machine without a pepper). The destination is folded in,
   * so a code stolen for one contact cannot be replayed against another.
   */
  private hash(destination: string, code: string, version: number): string {
    const pepper = this.config?.otpPepper ?? null;
    if (version === 2 && pepper) return createHmac('sha256', pepper).update(`${destination}:${code}`).digest('hex');
    return createHash('sha256').update(`${destination}:${code}`).digest('hex');
  }

  /** The version a new code is hashed with: keyed whenever a pepper exists. */
  private get hashVersion(): number {
    return this.config?.otpPepper ? 2 : 1;
  }

  /** Constant time, and false for a row whose version cannot be checked (a v2 row with the pepper gone). */
  private matches(row: { codeHash: string; hashVersion: number; destination: string }, code: string): boolean {
    if (row.hashVersion === 2 && !this.config?.otpPepper) return false;
    const expected = Buffer.from(row.codeHash, 'utf8');
    const given = Buffer.from(this.hash(row.destination, code.trim(), row.hashVersion), 'utf8');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  /** Normalise, and say which channel this is. Refuses anything else. */
  private classify(raw: string): { channel: 'email' | 'phone'; destination: string } {
    const trimmed = (raw ?? '').trim();
    if (trimmed.includes('@')) {
      if (!isEmail(trimmed)) throw new BadRequestException('That does not look like an email address.');
      return { channel: 'email', destination: normaliseEmail(trimmed) };
    }
    const phone = normalisePhone(trimmed);
    if (!phone) throw new BadRequestException('That does not look like a WhatsApp number.');
    return { channel: 'phone', destination: phone };
  }

  async start(
    rawDestination: string,
    language: 'en' | 'ar' | 'fr',
  ): Promise<{ delivery: 'sent' | 'outbox'; devCode?: string }> {
    const { channel, destination } = this.classify(rawDestination);

    const since = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await this.prisma.contactVerification.count({
      where: { destination, createdAt: { gt: since } },
    });
    if (recent >= MAX_SENDS_PER_HOUR) {
      throw new BadRequestException('Too many codes requested. Try again in a little while.');
    }

    // Any code still outstanding for this destination is dead the moment a new
    // one is issued, so two live codes never exist at once.
    await this.prisma.contactVerification.updateMany({
      where: { destination, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const code = String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
    const id = newUuidV7Bin();
    const hashVersion = this.hashVersion;

    await this.prisma.contactVerification.create({
      data: {
        id,
        channel,
        destination,
        codeHash: this.hash(destination, code, hashVersion),
        hashVersion,
        expiresAt: new Date(Date.now() + TTL_MINUTES * 60 * 1000),
      },
    });

    let result: Awaited<ReturnType<ContactDeliveryProvider['send']>>;
    try {
      result = await this.delivery.send({ channel, destination, code, language });
    } catch (e) {
      // Not sent: the code is dead at once — nobody can be waiting for it — and the refusal goes back as it is.
      const detail = (e as { response?: { delivery?: unknown; code?: unknown } }).response;
      await this.prisma.contactVerification.update({
        where: { id },
        data: {
          consumedAt: new Date(),
          deliveryState: 'failed',
          deliveryProvider: this.delivery.name,
          deliveryDetail: String(detail?.delivery ?? detail?.code ?? 'not sent').slice(0, 200),
        },
      });
      throw e;
    }
    await this.prisma.contactVerification.update({
      where: { id },
      data: {
        deliveryState: result.delivery === 'outbox' ? 'outbox' : 'accepted',
        deliveryProvider: result.provider.slice(0, 40),
        providerMessageId: result.providerMessageId ?? null,
      },
    });

    /*
     * The code comes back in the RESPONSE only during ordinary local
     * development.
     *
     * Never in staging, even though staging uses the outbox: a code in a
     * response body makes the whole verification meaningless, because
     * anybody could then "verify" any address they liked. A staging tester
     * uses the server-side retrieval command instead, which needs shell
     * access to the box.
     */
    const devCode =
      codeMayBeReturned() && result.delivery === 'outbox'
        ? (this.outbox.peek(destination) ?? undefined)
        : undefined;

    return { delivery: result.delivery, devCode };
  }

  /**
   * Check a code.
   *
   * Single-use: a successful check consumes the row, so the same code cannot
   * verify a second contact or be replayed. A wrong guess costs an attempt, and
   * a code with too many is dead whatever it is.
   */
  async confirm(rawDestination: string, code: string): Promise<boolean> {
    const { destination } = this.classify(rawDestination);

    const row = await this.prisma.contactVerification.findFirst({
      where: { destination, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    if (!row) return false;
    if (!(await this.claimAttempt(row.id))) return false;
    if (!this.matches(row, code)) return false;

    // Conditional, so of two right guesses racing exactly one consumes the code.
    const { count } = await this.prisma.contactVerification.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return count === 1;
  }

  /**
   * Spend one attempt BEFORE comparing, atomically: the count is checked and
   * raised in one statement, so of any number of concurrent guesses only the
   * attempts left are ever compared. Checking a value read earlier let every
   * request in a burst pass the check before any of them was counted.
   */
  private async claimAttempt(id: Buffer): Promise<boolean> {
    const { count } = await this.prisma.contactVerification.updateMany({
      where: { id, consumedAt: null, expiresAt: { gt: new Date() }, attempts: { lt: MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    return count === 1;
  }

  /**
   * The challenge a `start()` just created for this destination.
   *
   * Returned so a caller can BIND it — see `confirmChallenge`. Without the
   * binding there is nothing to distinguish this attempt's challenge from any
   * other challenge that happens to share the destination.
   */
  async latestChallengeFor(rawDestination: string): Promise<Buffer | null> {
    const { destination } = this.classify(rawDestination);
    const row = await this.prisma.contactVerification.findFirst({
      where: { destination, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /**
   * Check a code against **one specific challenge**, never against a
   * destination.
   *
   * This is the difference between "somebody proved this address at some point"
   * and "this person proved this address, in this attempt, just now". Only the
   * second can carry authority, so registration completion uses this and never
   * {@link confirm}.
   *
   * Does not consume: the caller consumes it inside the same transaction that
   * spends the continuation, so the two cannot fall out of step.
   */
  async confirmChallenge(
    challengeId: Buffer,
    code: string,
  ): Promise<'ok' | 'wrong' | 'gone'> {
    const row = await this.prisma.contactVerification.findUnique({ where: { id: challengeId } });
    if (!row) return 'gone';
    if (row.consumedAt) return 'gone';
    if (row.expiresAt <= new Date()) return 'gone';
    if (!(await this.claimAttempt(row.id))) return 'gone';

    if (!this.matches(row, code)) return 'wrong';
    // Only a wrong guess costs an attempt: the right one is given its back, so a
    // person told to add a password still has every attempt they had.
    await this.prisma.contactVerification.update({
      where: { id: row.id },
      data: { attempts: { decrement: 1 } },
    });
    return 'ok';
  }

  /**
   * Whether this contact has been proven, for the registration to consult.
   *
   * ⚠️ **This is not authentication, and must never be used as it.** It answers
   * for the most recent consumed verification of a destination, with no bound
   * on when, by whom, or in which attempt. An endpoint that issued a session on
   * the strength of it would let anyone who ever verified an address mint a
   * session for whoever owns that address now — with no password. Registration
   * completion binds to a specific challenge instead; see `confirmChallenge`.
   */
  async isVerified(rawDestination: string): Promise<boolean> {
    const { destination } = this.classify(rawDestination);
    const consumed = await this.prisma.contactVerification.findFirst({
      where: { destination, consumedAt: { not: null } },
      orderBy: { consumedAt: 'desc' },
    });
    return consumed !== null;
  }
}
