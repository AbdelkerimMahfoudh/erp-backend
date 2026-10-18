import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { actorRef } from '../../common/privacy/audit-contact';
import { binToUuid } from '../../common/utils/uuid.util';
import { CLOCK, type Clock } from '../../entitlement/clock';
import { EntitlementService } from '../../entitlement/entitlement.service';
import { stateOf } from '../../entitlement/entitlement-rules';
import { lockSubscription } from '../../billing/renewal';
import { NoticeService } from '../../notices/notice.service';
import { PlatformAuditService } from '../platform-audit.service';
import { mayClaimNow, readFacts, readOwner, subscriptionRecordOf, type TrialFactsRow, type TrialPrincipal } from './trial-facts';
import { TrialRefusal } from './trial-refusal';
import {
  RESEND_DAY_MS,
  TRIAL_DURATION_DAYS,
  TRIAL_DURATION_HOURS,
  missingContacts,
  requiredContacts,
  type OwnerContacts,
  type TrialRegistrationMethod,
} from './trial-rules';
import {
  SETUP_DELIVERY_WAIT_MS,
  SETUP_HISTORY_SIZE,
  resendAvailableAt,
  resendBlockOf,
  verifiedDestinations,
  type AppSetupStatus,
  type WebsiteSetup,
} from './trial-setup-rules';

/**
 * The portal instructions (0095, 0099; docs/76, docs/101 §5; the owner's brief of 2026-10-18).
 *
 * **Sent automatically, once.** The moment the Owner's required contact is verified — the WhatsApp number, at the end
 * of the registration or later in the app — ONE message is queued: the business is eligible for a 7-day free trial
 * that has not started, and the portal's address, where the Owner signs in with the same account and starts it. At
 * most once per eligibility, by the UNIQUE identity of the message (`notices/notice.service.ts`), whatever retries,
 * restarts or concurrent verifications happen.
 *
 * **Sent again only from the portal.** `resend` is the portal's action, after the Owner signed in, throttled by the
 * requests the business already has, and audited. The app has no trial action of any kind: what it reads here
 * (`appStatus`) is display data — where things stand — and nothing it could act on.
 *
 * **Never a condition for claiming.** Delivery is reported honestly — sending, sent (with the channel and the masked
 * destination), failed (with the reason), not sent, waiting for a contact — and none of it changes what the Owner may
 * do on the portal.
 *
 * Every request is written under the subscription row lock, after the state, the Owner and the contacts were re-read
 * there; the message itself is sent by the outbox's worker, never inside the transaction, and never holding a
 * verification (C14).
 */

@Injectable()
export class TrialSetupService {
  private readonly logger = new Logger(TrialSetupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlement: EntitlementService,
    private readonly audit: PlatformAuditService,
    private readonly notices: NoticeService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ── What the Owner is shown ──────────────────────────────────────────────

  /**
   * The app's status (GET account/trial-setup): whether the business may claim its trial on the portal, that it has
   * not started, how long it lasts, which contacts are verified (masked) and whether the instructions reached the
   * Owner — by which channel, to which masked destination, or why not. The Owner alone (403 `owner_only` for
   * everyone else, before anything is read about the trial); readable in every state. A business that is not
   * `trial_available` is told only that, and the app shows no card.
   */
  async appStatus(who: TrialPrincipal): Promise<AppSetupStatus> {
    const now = this.clock.now();
    const owner = await readOwner(this.prisma, who);
    const row = owner ? await readFacts(this.prisma, who.companyId) : null;
    if (!owner || !row) throw new TrialRefusal('owner_only');
    const state = stateOf(subscriptionRecordOf(row), now);
    const eligibility = row.trialEligibility;
    if (state !== 'trial_available' || !eligibility || !mayClaimNow(row, now)) return { state, eligible: false };

    return {
      state,
      eligible: true,
      durationHours: TRIAL_DURATION_HOURS,
      durationDays: TRIAL_DURATION_DAYS,
      requiredContacts: requiredContacts(eligibility.registrationMethod),
      missingContacts: missingContacts(eligibility.registrationMethod, owner),
      destinations: verifiedDestinations(owner),
      ...(await this.notices.instructionsStatus(who.companyId, owner)),
      timeZone: this.entitlement.trialZone(who.companyId, row.timezone),
    };
  }

  /**
   * The portal's `setup` object, for a business that is `trial_available`: the same status, an honest history of the
   * last requests, and when the Owner may ask again. Read by the portal's trial card and answered by the resend.
   */
  async websiteSetup(who: TrialPrincipal, owner: OwnerContacts, method: TrialRegistrationMethod, now: Date): Promise<WebsiteSetup> {
    const missing = missingContacts(method, owner);
    const [status, history, recent, carriable] = await Promise.all([
      this.notices.instructionsStatus(who.companyId, owner),
      this.notices.instructionsHistory(who.companyId, owner, SETUP_HISTORY_SIZE),
      this.notices.instructionRequestsSince(this.prisma, who.companyId, new Date(now.getTime() - RESEND_DAY_MS)),
      this.notices.canCarryInstructions(owner),
    ]);
    const availableAt = resendAvailableAt(recent, now);
    const blockedBy = resendBlockOf(missing, carriable, availableAt);
    return {
      ...status,
      destinations: verifiedDestinations(owner),
      canResendNow: blockedBy === null,
      resendBlockedBy: blockedBy,
      resendAvailableAt: availableAt?.toISOString() ?? null,
      history,
    };
  }

  // ── Asking ───────────────────────────────────────────────────────────────

  /**
   * The portal's resend (POST platform/my-subscription/trial/setup/resend), for the signed-in Owner: always to the
   * Owner's own verified contacts. Refused, in order: not the Owner (403 `owner_only`), the business cannot claim
   * (409 `trial_not_available`), a required contact unverified (409 `contact_unverified`), too soon (429
   * `too_many_requests` with `resendAvailableAt`), nothing can carry it now (503 `setup_delivery_unavailable` —
   * nothing is queued). Otherwise the request is queued and audited, and the answer is the `setup` object once the
   * message was handed to a provider — or `sending`, when that took longer than `SETUP_DELIVERY_WAIT_MS`.
   */
  async resend(who: TrialPrincipal): Promise<WebsiteSetup> {
    const now = this.clock.now();
    const owner = await readOwner(this.prisma, who);
    // Read before the lock — the providers' state and the person's own WhatsApp records — so the lock holds no lookup.
    const carriable = owner ? await this.notices.canCarryInstructions(owner) : false;
    await this.prisma.$transaction(async (tx) => {
      await lockSubscription(tx, who.companyId);
      const at = this.clock.now();
      const ready = await this.readiness(tx, who, at);
      if (ready instanceof TrialRefusal) throw ready;
      const availableAt = resendAvailableAt(await this.notices.instructionRequestsSince(tx, who.companyId, new Date(at.getTime() - RESEND_DAY_MS)), at);
      if (availableAt) throw new TrialRefusal('too_many_requests', { resendAvailableAt: availableAt.toISOString() });
      if (!carriable) throw new TrialRefusal('setup_delivery_unavailable');
      await this.notices.requestInstructions(tx, {
        companyId: who.companyId,
        subscriptionId: ready.row.subscription!.id,
        eligibilityId: ready.row.trialEligibility!.id,
        requestedBy: who.userId,
        now: at,
      });
      await this.audit.record(
        {
          admin: null,
          actor: actorRef(binToUuid(who.userId)),
          action: 'trial.instructions_resend',
          targetType: 'Company',
          targetId: who.companyId,
          targetLabel: ready.row.name,
          after: { trigger: 'resend' },
          at,
        },
        tx,
      );
    });
    await this.waitBriefly(this.notices.deliverNow());
    const after = await readOwner(this.prisma, who);
    const row = after ? await readFacts(this.prisma, who.companyId) : null;
    if (!after || !row?.trialEligibility) throw new TrialRefusal('owner_only');
    return this.websiteSetup(who, after, row.trialEligibility.registrationMethod, now);
  }

  /**
   * After a contact of this person was verified and committed — the registration's own WhatsApp number, or one
   * verified later in the app: if the business may claim its trial, the person is its Owner and every required contact
   * is now verified, the instructions are queued, once, and the worker is started. Never thrown into the caller and
   * never waited for (C14): whatever happens here, the verification the person just completed stands, and is answered.
   */
  async onContactsVerified(companyId: Buffer, userId: Buffer): Promise<void> {
    try {
      // Most verifications are of businesses with no open eligibility — staff, approved shops — and need no lock.
      const eligibility = await this.prisma.trialEligibility.findUnique({ where: { companyId }, select: { closedAt: true } });
      if (!eligibility || eligibility.closedAt) return;
      const queued = await this.prisma.$transaction(async (tx) => {
        await lockSubscription(tx, companyId);
        const now = this.clock.now();
        const ready = await this.readiness(tx, { companyId, userId }, now);
        if (ready instanceof TrialRefusal) return null;
        return this.notices.requestInstructions(tx, {
          companyId,
          subscriptionId: ready.row.subscription!.id,
          eligibilityId: ready.row.trialEligibility!.id,
          requestedBy: null,
          now,
        });
      });
      if (queued) {
        this.logger.log(`Portal instructions queued after verification for company ${binToUuid(companyId)}`);
        void this.notices.deliverNow();
      }
    } catch (e) {
      this.logger.warn(`Portal instructions not queued for company ${binToUuid(companyId)}: ${(e as Error).name}`);
    }
  }

  /**
   * Whether the instructions may go to this person now, read on the connection given — or why not, as the resend's
   * refusals in their order: not the Owner, the business cannot claim, a required contact unverified. The automatic
   * request treats any of them as nothing to do.
   */
  private async readiness(db: Prisma.TransactionClient, who: TrialPrincipal, now: Date): Promise<{ owner: OwnerContacts; row: TrialFactsRow } | TrialRefusal> {
    const owner = await readOwner(db, who);
    const row = owner ? await readFacts(db, who.companyId) : null;
    if (!owner || !row) return new TrialRefusal('owner_only');
    const eligibility = row.trialEligibility;
    if (!eligibility || !row.subscription || !mayClaimNow(row, now)) return new TrialRefusal('trial_not_available');
    const missing = missingContacts(eligibility.registrationMethod, owner);
    if (missing.length > 0) return new TrialRefusal('contact_unverified', { missingContacts: missing });
    return { owner, row };
  }

  /** The delivery pass, waited for at most `SETUP_DELIVERY_WAIT_MS`; it carries on without the request past that. */
  private async waitBriefly(pass: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([pass, new Promise<void>((resolve) => (timer = setTimeout(resolve, SETUP_DELIVERY_WAIT_MS)))]);
    clearTimeout(timer);
  }
}
