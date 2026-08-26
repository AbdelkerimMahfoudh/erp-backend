import { Injectable, Logger } from '@nestjs/common';
import { OtpPurpose } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../auth/sessions.service';
import { TokensService } from '../auth/tokens.service';
import { VerificationIntentService } from '../auth/otp/verification-intent.service';
import { binToUuid } from '../common/utils/uuid.util';
export { PORTAL_SESSION_COOKIE } from '../common/http/cookies';

/**
 * Opening the website subscription portal already signed in as this Owner.
 *
 * The shopkeeper finishes creating an account in the app, and the app opens the
 * portal in their browser. Asking them to type the password they invented
 * ninety seconds ago, on a phone keyboard, into a second surface, is exactly
 * the friction the product exists to remove.
 *
 * ## What is handed over, and what is not
 *
 * **Not the mobile token.** The app's bearer token never reaches the browser,
 * and nothing reusable ever appears in a URL. What travels is a ticket that:
 *
 *  - is 256 bits of randomness, stored only as a SHA-256;
 *  - is bound to one company and one user;
 *  - lives {@link HANDOFF_TTL_SECONDS} seconds;
 *  - is consumed exactly once, atomically, so two taps cannot both spend it;
 *  - buys exactly one thing — a customer-portal session for that Owner.
 *
 * It is not an API token. The tenant guard does not accept it, the
 * administration guard does not accept it, and it authorises no request of any
 * kind. It can be exchanged, once, for a session cookie and nothing else.
 *
 * ## Why it reuses `verification_intents`
 *
 * Because the part that must not be got wrong — single-use consumption under
 * concurrency — is already implemented and already tested there. A second table
 * of the same shape would mean a second chance to get it wrong.
 */

/**
 * Ninety seconds: long enough to survive a cold browser launch on a phone,
 * short enough that a ticket captured in transit is almost always already dead.
 */
export const HANDOFF_TTL_SECONDS = 90;

/** How long the portal session the exchange creates is good for. */
export const PORTAL_SESSION_TTL_HOURS = 12;

export type ExchangeFailure =
  | 'not_found'
  | 'expired'
  | 'consumed'
  | 'mismatch'
  | 'user_unavailable';

export type ExchangeResult =
  | { ok: true; accessToken: string; expiresIn: number; companyId: string; userId: string }
  | { ok: false; reason: ExchangeFailure };

@Injectable()
export class PortalHandoffService {
  private readonly log = new Logger('PortalHandoff');

  constructor(
    private readonly prisma: PrismaService,
    private readonly intents: VerificationIntentService,
    private readonly sessions: SessionsService,
    private readonly tokens: TokensService,
  ) {}

  /**
   * Mint a ticket for an already-authenticated Owner.
   *
   * The caller has already proved who they are with a normal mobile session;
   * this adds no authority, it only moves the authority the caller already has
   * onto one other surface.
   */
  async issue(companyId: Buffer, userId: Buffer): Promise<{ token: string; expiresAt: string }> {
    const issued = await this.intents.issue({
      companyId,
      userId,
      purpose: OtpPurpose.portal_handoff,
      ttlSeconds: HANDOFF_TTL_SECONDS,
    });

    // The destination and the actor, never the ticket.
    this.log.log(`portal handoff issued for company ${binToUuid(companyId)}`);
    return { token: issued.token, expiresAt: issued.expiresAt };
  }

  /**
   * Spend a ticket for a portal session.
   *
   * Every rejection collapses to a reason that says nothing about which part
   * was wrong, so this cannot be used to probe for live tickets.
   */
  async exchange(
    token: string,
    context: { ip?: string; userAgent?: string } = {},
  ): Promise<ExchangeResult> {
    const resolution = await this.intents.resolve(token, { purpose: OtpPurpose.portal_handoff });
    if (!resolution.ok) return { ok: false, reason: resolution.reason };

    /*
     * Re-checked at spend time, not trusted from when the ticket was minted.
     *
     * Somebody can be disabled, or their whole company suspended, in the ninety
     * seconds between tapping and the browser opening. The ticket must not
     * outlive the account it belongs to.
     */
    const user = await this.prisma.user.findUnique({
      where: { id: resolution.userId },
      select: { id: true, companyId: true, isActive: true },
    });
    if (!user || !user.isActive) return { ok: false, reason: 'user_unavailable' };
    if (!user.companyId.equals(resolution.companyId)) return { ok: false, reason: 'mismatch' };

    /*
     * Consumed inside the transaction that creates the session, so a ticket can
     * never buy two sessions. `consume` updates conditionally on
     * `consumed_at IS NULL`: of two concurrent taps exactly one wins, and the
     * loser is told the ticket is spent.
     */
    const consumed = await this.intents.consume(resolution.intentId, async () => {
      const secret = this.tokens.generateRefreshSecret();
      const sessionId = await this.sessions.create({
        companyId: user.companyId,
        userId: user.id,
        secret,
        userAgent: context.userAgent,
        ip: context.ip,
      });
      return sessionId;
    });

    if (!consumed.ok) return { ok: false, reason: 'consumed' };

    const access = this.tokens.signAccessToken(
      binToUuid(user.id),
      binToUuid(user.companyId),
      binToUuid(consumed.result),
    );

    this.log.log(`portal handoff exchanged for company ${binToUuid(user.companyId)}`);
    return {
      ok: true,
      accessToken: access.token,
      expiresIn: access.expiresIn,
      companyId: binToUuid(user.companyId),
      userId: binToUuid(user.id),
    };
  }
}
