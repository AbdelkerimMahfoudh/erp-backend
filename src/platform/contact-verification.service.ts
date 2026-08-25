import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash, randomInt } from 'node:crypto';
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
 * attempt-limited, and stored only as a hash. A leaked database must not hand
 * somebody a working code.
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
  ) {}

  private hash(destination: string, code: string): string {
    // The destination is folded in, so a code stolen for one contact cannot be
    // replayed against another.
    return createHash('sha256').update(`${destination}:${code}`).digest('hex');
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

    await this.prisma.contactVerification.create({
      data: {
        id: newUuidV7Bin(),
        channel,
        destination,
        codeHash: this.hash(destination, code),
        expiresAt: new Date(Date.now() + TTL_MINUTES * 60 * 1000),
      },
    });

    const result = await this.delivery.send({ channel, destination, code, language });

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
    if (row.attempts >= MAX_ATTEMPTS) return false;

    if (row.codeHash !== this.hash(destination, code.trim())) {
      await this.prisma.contactVerification.update({
        where: { id: row.id },
        data: { attempts: { increment: 1 } },
      });
      return false;
    }

    await this.prisma.contactVerification.update({
      where: { id: row.id },
      data: { consumedAt: new Date() },
    });
    return true;
  }

  /** Whether this contact has been proven, for the registration to consult. */
  async isVerified(rawDestination: string): Promise<boolean> {
    const { destination } = this.classify(rawDestination);
    const consumed = await this.prisma.contactVerification.findFirst({
      where: { destination, consumedAt: { not: null } },
      orderBy: { consumedAt: 'desc' },
    });
    return consumed !== null;
  }
}
