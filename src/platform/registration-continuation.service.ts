import { Injectable, Logger } from '@nestjs/common';
import { OtpPurpose } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../auth/sessions.service';
import { TokensService } from '../auth/tokens.service';
import { VerificationIntentService } from '../auth/otp/verification-intent.service';
import { ContactVerificationService } from './contact-verification.service';
import { binToUuid } from '../common/utils/uuid.util';

/**
 * Finishing a registration, and only that.
 *
 * Creating an account on the phone ends with the Owner signed in. Registration
 * returns no session, and the password they just invented is deliberately never
 * replayed to simulate a login — so something has to carry authority from
 * "this person just created this company" to "this person is now signed in".
 *
 * ## Why a fact about a contact address cannot be that something
 *
 * The obvious shortcut is `isVerified(destination)`. It is wrong, and wrong in
 * a way that is easy to miss: it answers for the **most recent consumed
 * verification of a destination, ever**, with no bound on when, by whom, or in
 * which attempt. An endpoint trusting it would issue an Owner session to
 * anyone who could reach it and name an address somebody had once verified —
 * no password anywhere in the story. That is not a weaker login; it is not a
 * login at all.
 *
 * ## The chain this implements instead
 *
 *     one registration attempt
 *   + one short-lived continuation credential
 *   + one verification challenge bound to that attempt
 *   + successful consumption of that exact challenge
 *   = one normal Owner session
 *
 * Every link is checked, and the last two are consumed together in one
 * transaction so neither can be spent without the other.
 *
 * ## What the continuation is not
 *
 * Not an access token. The tenant guard does not accept it, the administration
 * guard does not accept it, and it authorises no request. It buys exactly one
 * thing, once: the completion of the registration that minted it.
 */

/**
 * Fifteen minutes: long enough to read a code from an email on the same phone,
 * short enough that a captured continuation is almost always already dead. It
 * must never outlive the challenge it is bound to, and the challenge's own
 * expiry is checked independently at completion.
 */
export const CONTINUATION_TTL_SECONDS = 15 * 60;

export type CompletionFailure =
  | 'not_found'
  | 'expired'
  | 'consumed'
  | 'mismatch'
  | 'no_challenge'
  | 'wrong_code'
  | 'challenge_gone'
  | 'user_unavailable';

export type CompletionResult =
  | {
      ok: true;
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      companyId: string;
      userId: string;
    }
  | { ok: false; reason: CompletionFailure };

@Injectable()
export class RegistrationContinuationService {
  private readonly log = new Logger('RegistrationContinuation');

  constructor(
    private readonly prisma: PrismaService,
    private readonly intents: VerificationIntentService,
    private readonly verification: ContactVerificationService,
    private readonly sessions: SessionsService,
    private readonly tokens: TokensService,
  ) {}

  /**
   * Mint a continuation for the Owner a registration transaction just created.
   *
   * Called by the registration flow itself, never by a client — a public
   * idempotency key must not be able to ask for one.
   */
  async issue(companyId: Buffer, userId: Buffer): Promise<{ token: string; expiresAt: string }> {
    const issued = await this.intents.issue({
      companyId,
      userId,
      purpose: OtpPurpose.registration_continuation,
      ttlSeconds: CONTINUATION_TTL_SECONDS,
    });

    // The company, never the credential.
    this.log.log(`registration continuation issued for company ${binToUuid(companyId)}`);
    return { token: issued.token, expiresAt: issued.expiresAt };
  }

  /**
   * Send a code, and bind the challenge it creates to this continuation.
   *
   * The binding is the point. Without it, completion would have to find a
   * challenge by destination, which is the destination lookup this whole design
   * exists to avoid.
   */
  async startChallenge(
    token: string,
    language: 'en' | 'ar' | 'fr',
  ): Promise<
    | { ok: true; destination: string; delivery: 'sent' | 'outbox' }
    | { ok: false; reason: CompletionFailure }
  > {
    const resolution = await this.intents.resolve(token, {
      purpose: OtpPurpose.registration_continuation,
    });
    if (!resolution.ok) return { ok: false, reason: resolution.reason };

    const user = await this.prisma.user.findUnique({
      where: { id: resolution.userId },
      select: { id: true, companyId: true, email: true, phone: true, isActive: true, deletedAt: true },
    });
    // Re-checked at send time rather than trusted from when the ticket was
    // minted: an account disabled in between must not receive a code.
    if (!user || !user.isActive || user.deletedAt) return { ok: false, reason: 'user_unavailable' };
    if (!user.companyId.equals(resolution.companyId)) return { ok: false, reason: 'mismatch' };

    /*
     * The destination comes from the OWNER RECORD, never from the request. A
     * caller holding a continuation must not be able to redirect the code to an
     * address of their choosing — that would turn a stolen continuation into a
     * way to take over the account.
     */
    const destination = user.email ?? user.phone;
    if (!destination) return { ok: false, reason: 'user_unavailable' };

    const started = await this.verification.start(destination, language);
    const challengeId = await this.verification.latestChallengeFor(destination);
    if (!challengeId) return { ok: false, reason: 'no_challenge' };

    // Rebinding on resend is deliberate: the newest challenge is the only one
    // that can complete, so an older code stops working the moment a new one is
    // sent.
    await this.prisma.verificationIntent.update({
      where: { id: resolution.intentId },
      data: { challengeId },
    });

    return { ok: true, destination, delivery: started.delivery };
  }

  /**
   * Spend the continuation and its bound challenge, and issue one normal
   * session.
   *
   * Everything is re-checked here rather than trusted from earlier steps,
   * because "earlier" can be fifteen minutes ago and an account can be disabled
   * in between.
   */
  async complete(
    token: string,
    code: string,
    context: { ip?: string; userAgent?: string } = {},
  ): Promise<CompletionResult> {
    const resolution = await this.intents.resolve(token, {
      purpose: OtpPurpose.registration_continuation,
    });
    if (!resolution.ok) return { ok: false, reason: resolution.reason };

    // No challenge bound means nothing was ever sent for THIS attempt. There is
    // no fallback to "some challenge for this address" — that is the hole.
    if (!resolution.challengeId) return { ok: false, reason: 'no_challenge' };

    const user = await this.prisma.user.findUnique({
      where: { id: resolution.userId },
      select: { id: true, companyId: true, email: true, isActive: true, deletedAt: true },
    });
    if (!user || !user.isActive || user.deletedAt) return { ok: false, reason: 'user_unavailable' };
    if (!user.companyId.equals(resolution.companyId)) return { ok: false, reason: 'mismatch' };

    const channel: 'email' | 'phone' = user.email ? 'email' : 'phone';

    const checked = await this.verification.confirmChallenge(resolution.challengeId, code);
    if (checked === 'wrong') return { ok: false, reason: 'wrong_code' };
    if (checked === 'gone') return { ok: false, reason: 'challenge_gone' };

    const challengeId = resolution.challengeId;
    const secret = this.tokens.generateRefreshSecret();

    /*
     * One transaction, three things: the challenge is consumed, the
     * continuation is consumed, and the session is created. `consume` updates
     * conditionally on `consumed_at IS NULL`, so of two concurrent completions
     * exactly one wins and the loser is told the ticket is spent — it cannot
     * end with two sessions, or a spent ticket and no session.
     */
    const consumed = await this.intents.consume(resolution.intentId, async (tx) => {
      const { count } = await tx.contactVerification.updateMany({
        where: { id: challengeId, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      // Lost the race for the challenge itself. Refusing here rolls the whole
      // transaction back, including the continuation.
      if (count !== 1) throw new Error('challenge already consumed');

      /*
       * Mark the contact proved on the Owner record itself, in the same
       * transaction. This is also what makes the continuation un-reissuable:
       * `pendingOwnerFor` returns null once either timestamp is set, so a
       * replayed registration cannot mint a second credential for an account
       * that now has a working password.
       */
      const now = new Date();
      await tx.user.update({
        where: { id: user.id },
        data: channel === 'email' ? { emailVerifiedAt: now } : { phoneVerifiedAt: now },
      });

      return this.sessions.create({
        companyId: user.companyId,
        userId: user.id,
        secret,
        userAgent: context.userAgent,
        ip: context.ip,
      });
    });

    if (!consumed.ok) return { ok: false, reason: 'consumed' };

    const access = this.tokens.signAccessToken(
      binToUuid(user.id),
      binToUuid(user.companyId),
      binToUuid(consumed.result),
    );

    this.log.log(`registration completed for company ${binToUuid(user.companyId)}`);
    return {
      ok: true,
      accessToken: access.token,
      refreshToken: this.tokens.buildRefreshToken(binToUuid(consumed.result), secret),
      expiresIn: access.expiresIn,
      companyId: binToUuid(user.companyId),
      userId: binToUuid(user.id),
    };
  }
}
