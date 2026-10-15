import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Prisma, TrialSetupOutcome, TrialSetupTrigger } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfigService } from '../../common/config/app-config.service';
import { actorRef } from '../../common/privacy/audit-contact';
import { binToUuid, newUuidV7Bin } from '../../common/utils/uuid.util';
import { CLOCK, type Clock } from '../../entitlement/clock';
import { EntitlementService } from '../../entitlement/entitlement.service';
import { stateOf } from '../../entitlement/entitlement-rules';
import { lockSubscription } from '../../billing/renewal';
import { WHATSAPP_CHANNEL, type DeliveryResult, type WhatsAppChannel } from '../../messaging/whatsapp-channel';
import { EMAIL_CHANNEL, type EmailChannel } from '../../messaging/email-channel';
import { TRIAL_SETUP_TEMPLATE, type MessageLanguage } from '../../messaging/templates';
import { outboxAllowed, sendWithOneRetry } from '../contact-delivery';
import { PlatformAuditService } from '../platform-audit.service';
import { mayClaimNow, readFacts, readOwner, subscriptionRecordOf, type TrialFactsRow, type TrialPrincipal } from './trial-facts';
import { bindingKey, linkBindingOf, revokeUsableLinks } from './trial-link';
import { TrialRefusal } from './trial-refusal';
import {
  RESEND_DAY_MS,
  RESEND_MIN_INTERVAL_MS,
  TRIAL_DURATION_DAYS,
  TRIAL_DURATION_HOURS,
  TRIAL_SETUP_LINK_TTL_HOURS,
  missingContacts,
  requiredContacts,
  setupTokenHash,
  type OwnerContacts,
  type TrialRegistrationMethod,
} from './trial-rules';
import {
  SETUP_HISTORY_SIZE,
  deliveryOf,
  historyEntry,
  operationalChannels,
  plannedOutcomes,
  printsDevelopmentLinks,
  resendAvailableAt,
  sentTo,
  setupLinkUrl,
  verifiedDestinations,
  type AppSetupStatus,
  type PlannedOutcome,
  type SetupAttempt,
  type SetupChannel,
  type WebsiteSetup,
} from './trial-setup-rules';

/**
 * The free trial's setup instructions (0095; docs/76; the owner's correction of 2026-10-13).
 *
 * **Sent automatically, once.** The moment every contact the Owner gave at registration is verified — at the end of
 * the registration, or when the WhatsApp number is verified later in the app — the instructions go to each verified
 * contact whose channel can carry them: the business is eligible for a 7-day free trial that has not started, with a
 * single-purpose link to the Dukan ERP website. Never retried automatically: a business whose send found nothing
 * that could carry it gets its instructions when its Owner signs in on the website (where the trial can be started
 * without any link) or through support.
 *
 * **Sent again only from the website.** `resend` is the website's action, after the Owner signed in, throttled by the
 * attempts the business already has. The app has no trial action of any kind: what it reads here (`appStatus`) is
 * display data — where things stand — and nothing it could act on.
 *
 * **Never a condition for claiming.** Delivery is reported honestly — sent, failed, unavailable, not sent, waiting for
 * a contact — and none of it changes what the Owner may do on the website.
 *
 * Each send is serialised per business on the subscription row lock, and no provider is called inside a
 * transaction: the link is issued and committed first (tx A), the providers are called, and the attempt is recorded
 * with what each channel did (tx B). Which channels can carry it is decided at that moment — never from a snapshot
 * taken at boot. The token exists in the messages and nowhere else: the database keeps its hash, and no log, audit
 * or answer ever holds it, or a contact, or a code.
 */

/** What one send did. `skipped`: nothing to do (automatic only) — not eligible, not the Owner, or already done. */
type SendOutcome = 'skipped' | 'unavailable' | 'sent' | 'failed';

/** The business and its Owner when the instructions may go to them now. */
interface Ready {
  owner: OwnerContacts;
  row: TrialFactsRow;
}

/** A link issued under the lock, and everything the messages need — carried out of the transaction, never stored. */
interface Issued {
  linkId: Buffer;
  /** The server's instant under the lock: the link's, and its attempt's when that is recorded. */
  issuedAt: Date;
  token: string;
  plan: Record<SetupChannel, PlannedOutcome>;
  email: string | null;
  phone: string | null;
  business: string;
  language: MessageLanguage;
}

const LANGUAGES: readonly MessageLanguage[] = ['en', 'fr', 'ar'];

@Injectable()
export class TrialSetupService {
  private readonly logger = new Logger(TrialSetupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlement: EntitlementService,
    private readonly audit: PlatformAuditService,
    private readonly config: AppConfigService,
    @Inject(WHATSAPP_CHANNEL) private readonly whatsapp: WhatsAppChannel,
    @Inject(EMAIL_CHANNEL) private readonly email: EmailChannel,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ── What the Owner is shown ──────────────────────────────────────────────

  /**
   * The app's status (GET account/trial-setup): whether the business may claim its trial on the website, that it has
   * not started, how long it lasts, which contacts are verified (masked) and whether the instructions reached them.
   * The Owner alone (403 `owner_only` for everyone else, before anything is read about the trial); readable in every
   * state. A business that is not `trial_available` is told only that, and the app shows no card.
   */
  async appStatus(who: TrialPrincipal): Promise<AppSetupStatus> {
    const now = this.clock.now();
    const owner = await readOwner(this.prisma, who);
    const row = owner ? await readFacts(this.prisma, who.companyId) : null;
    if (!owner || !row) throw new TrialRefusal('owner_only');
    const state = stateOf(subscriptionRecordOf(row), now);
    const eligibility = row.trialEligibility;
    if (state !== 'trial_available' || !eligibility || !mayClaimNow(row, now)) return { state, eligible: false };

    const missing = missingContacts(eligibility.registrationMethod, owner);
    const [last, lastAccepted] = await Promise.all([this.attempts(who.companyId, 1), this.lastAccepted(who.companyId)]);
    return {
      state,
      eligible: true,
      durationHours: TRIAL_DURATION_HOURS,
      durationDays: TRIAL_DURATION_DAYS,
      requiredContacts: requiredContacts(eligibility.registrationMethod),
      missingContacts: missing,
      destinations: verifiedDestinations(owner),
      delivery: deliveryOf(missing, last[0] ?? null),
      sentTo: sentTo(lastAccepted),
      lastAttemptAt: last[0]?.at.toISOString() ?? null,
      timeZone: this.entitlement.trialZone(who.companyId, row.timezone),
    };
  }

  /**
   * The website's `setup` object, for a business that is `trial_available`: the same status, an honest history of the
   * last attempts, and when the Owner may ask again. Read by the website's trial card and answered by the resend.
   */
  async websiteSetup(companyId: Buffer, owner: OwnerContacts, method: TrialRegistrationMethod, now: Date): Promise<WebsiteSetup> {
    const missing = missingContacts(method, owner);
    const [history, lastAccepted, recent, inFlight] = await Promise.all([
      this.attempts(companyId, SETUP_HISTORY_SIZE),
      this.lastAccepted(companyId),
      this.recentAttempts(this.prisma, companyId, now),
      this.linkInFlight(this.prisma, companyId, now),
    ]);
    const last = history[0] ?? null;
    const availableAt = resendAvailableAt(recent, inFlight, now);
    const operational = this.operational();
    const destinations = verifiedDestinations(owner);
    return {
      delivery: deliveryOf(missing, last),
      sentTo: sentTo(lastAccepted),
      destinations,
      lastAttemptAt: last?.at.toISOString() ?? null,
      canResendNow: missing.length === 0 && destinations.some((d) => operational[d.channel]) && availableAt === null,
      resendAvailableAt: availableAt?.toISOString() ?? null,
      history: history.map(historyEntry),
    };
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  /**
   * The website's resend (POST platform/my-subscription/trial/setup/resend), for the signed-in Owner: always to the
   * Owner's own verified contacts. Refused, in order: not the Owner (403 `owner_only`), the business cannot claim
   * (409 `trial_not_available`), a required contact unverified (409 `contact_unverified`), too soon (429
   * `too_many_requests` with `resendAvailableAt`), nothing can carry it (503 `setup_delivery_unavailable` — the
   * attempt is recorded). Otherwise the website's `setup` object after the attempt, `sent` or `failed`.
   */
  async resend(who: TrialPrincipal): Promise<WebsiteSetup> {
    const outcome = await this.send(who, 'resend');
    if (outcome === 'unavailable') throw new TrialRefusal('setup_delivery_unavailable');
    const now = this.clock.now();
    const owner = await readOwner(this.prisma, who);
    const row = owner ? await readFacts(this.prisma, who.companyId) : null;
    if (!owner || !row?.trialEligibility) throw new TrialRefusal('owner_only');
    return this.websiteSetup(who.companyId, owner, row.trialEligibility.registrationMethod, now);
  }

  /**
   * After a contact of this person was verified and committed — the registration's own contact, or a WhatsApp number
   * verified later in the app: if the business may claim its trial, the person is its Owner and every required
   * contact is now verified, the instructions are sent, once (`verified`). Awaited by the caller and never thrown into
   * it: whatever happens here, the verification the person just completed stands.
   */
  async onContactsVerified(companyId: Buffer, userId: Buffer): Promise<void> {
    try {
      // Most verifications are of businesses with no open eligibility — staff, approved shops — and need no lock.
      const eligibility = await this.prisma.trialEligibility.findUnique({ where: { companyId }, select: { closedAt: true } });
      if (!eligibility || eligibility.closedAt) return;
      const outcome = await this.send({ companyId, userId }, 'verified');
      if (outcome !== 'skipped') {
        this.logger.log(`Free trial setup instructions after verification for company ${binToUuid(companyId)}: ${outcome}`);
      }
    } catch (e) {
      this.logger.warn(`Free trial setup instructions not sent for company ${binToUuid(companyId)}: ${(e as Error).message}`);
    }
  }

  /**
   * One attempt, in three steps:
   *
   *  1. tx A, under the subscription lock: the state, the Owner and the required contacts are re-read; the automatic
   *     send goes once (no earlier `verified` attempt, none in flight), the resend is throttled. Nothing can carry it:
   *     the attempt is recorded as it is, and nothing is issued. Otherwise every link still usable is retired
   *     (`reissued`) and a new one is issued and committed — 256 random bits, only their hash stored, bound to the
   *     Owner's credentials and contacts as they are, for 24 hours;
   *  2. the providers, outside any transaction, one per verified contact whose channel can carry it;
   *  3. tx B, under the lock again: the attempt with what each channel did, and the audit — last. Both carry the
   *     instant the link was issued, so the throttle's minute and the `resendAvailableAt` it promises are measured
   *     from one time, however long the providers took (C5; review finding R3-4).
   */
  private async send(who: TrialPrincipal, trigger: TrialSetupTrigger): Promise<SendOutcome> {
    const issued = await this.prisma.$transaction(async (tx) => {
      await lockSubscription(tx, who.companyId);
      const now = this.clock.now();
      const ready = await this.readiness(tx, who, now);
      if (ready instanceof TrialRefusal) {
        if (trigger === 'resend') throw ready;
        return 'skipped' as const;
      }
      const { owner, row } = ready;

      const inFlight = await this.linkInFlight(tx, who.companyId, now);
      if (trigger === 'verified') {
        const sentBefore = await tx.trialSetupMessage.findFirst({
          where: { companyId: who.companyId, trigger: 'verified' },
          select: { id: true },
        });
        if (sentBefore || inFlight) return 'skipped' as const;
      } else {
        const availableAt = resendAvailableAt(await this.recentAttempts(tx, who.companyId, now), inFlight, now);
        if (availableAt) throw new TrialRefusal('too_many_requests', { resendAvailableAt: availableAt.toISOString() });
      }

      const plan = plannedOutcomes(owner, this.operational());
      if (plan.email !== 'send' && plan.whatsapp !== 'send') {
        await this.record(tx, who, trigger, row.name, null, { email: plan.email, whatsapp: plan.whatsapp }, now);
        return 'unavailable' as const;
      }

      const binding = await tx.user.findUnique({
        where: { id: who.userId },
        select: { passwordHash: true, email: true, phone: true, emailVerifiedAt: true, phoneVerifiedAt: true },
      });
      // `operational()` already required a key, so a binding exists for a person read a moment ago.
      const digest = binding ? linkBindingOf(this.config.otpPepper, binding) : null;
      if (!digest) throw new Error('the setup link could not be bound to its Owner');

      await tx.trialSetupLink.updateMany(revokeUsableLinks({ companyId: who.companyId }, 'reissued', now));
      const token = randomBytes(32).toString('base64url');
      const linkId = newUuidV7Bin();
      await tx.trialSetupLink.create({
        data: {
          id: linkId,
          companyId: who.companyId,
          userId: who.userId,
          tokenHash: setupTokenHash(token),
          bindingDigest: digest,
          expiresAt: new Date(now.getTime() + TRIAL_SETUP_LINK_TTL_HOURS * 3600_000),
          createdAt: now,
        },
      });
      return {
        linkId,
        issuedAt: now,
        token,
        plan,
        email: owner.email,
        phone: owner.phone,
        business: row.name,
        language: await this.languageOf(tx, who.companyId),
      } satisfies Issued;
    });
    if (issued === 'skipped' || issued === 'unavailable') return issued;

    const outcomes = await this.deliver(who.companyId, issued);
    if (printsDevelopmentLinks()) {
      // The local-development sink, as the development WhatsApp channel prints a code: never the application logger.
      // eslint-disable-next-line no-console
      console.warn(
        `\n=== LOCAL DEV ONLY — NOT A REAL MESSAGE ===\n` +
          `  free trial setup link for company ${binToUuid(who.companyId)}:\n` +
          `  ${setupLinkUrl(this.config.publicSiteOrigin, issued.token)}\n` +
          `===========================================\n`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await lockSubscription(tx, who.companyId);
      await this.record(tx, who, trigger, issued.business, issued.linkId, outcomes, issued.issuedAt);
    });
    return outcomes.email === 'accepted' || outcomes.whatsapp === 'accepted' ? 'sent' : 'failed';
  }

  /**
   * Whether the instructions may go to this person now, read on the connection given — or why not, as the resend's
   * refusals in their order: not the Owner, the business cannot claim, a required contact unverified. The automatic
   * send treats any of them as nothing to do.
   */
  private async readiness(db: Prisma.TransactionClient, who: TrialPrincipal, now: Date): Promise<Ready | TrialRefusal> {
    const owner = await readOwner(db, who);
    const row = owner ? await readFacts(db, who.companyId) : null;
    if (!owner || !row) return new TrialRefusal('owner_only');
    const eligibility = row.trialEligibility;
    if (!eligibility || !mayClaimNow(row, now)) return new TrialRefusal('trial_not_available');
    const missing = missingContacts(eligibility.registrationMethod, owner);
    if (missing.length > 0) return new TrialRefusal('contact_unverified', { missingContacts: missing });
    return { owner, row };
  }

  /** Step 2: each planned channel's provider, together; a channel not planned keeps the reason it was not. */
  private async deliver(companyId: Buffer, issued: Issued): Promise<Record<SetupChannel, TrialSetupOutcome>> {
    const link = setupLinkUrl(this.config.publicSiteOrigin, issued.token);
    const [email, whatsapp] = await Promise.all([
      issued.plan.email === 'send'
        ? this.outcomeOf(companyId, 'email', (idempotencyKey) =>
            this.email.send({
              to: issued.email!,
              template: 'trial.setup',
              language: issued.language,
              variables: { business: issued.business, link },
              idempotencyKey,
            }),
          )
        : issued.plan.email,
      issued.plan.whatsapp === 'send'
        ? this.outcomeOf(companyId, 'whatsapp', (idempotencyKey) =>
            this.whatsapp.send({
              to: issued.phone!,
              template: TRIAL_SETUP_TEMPLATE.key,
              language: issued.language,
              variables: { business: issued.business, token: issued.token },
              idempotencyKey,
            }),
          )
        : issued.plan.whatsapp,
    ]);
    return { email, whatsapp };
  }

  /**
   * One provider call, with the one retry a temporary failure earns (under the same idempotency key). Accepted is
   * accepted; a channel that turned out to be closed is `unavailable`; anything else — a refusal, an error, an
   * exception — is `failed`. Logged by class, never with the destination or the link.
   */
  private async outcomeOf(
    companyId: Buffer,
    channel: SetupChannel,
    send: (idempotencyKey: string) => Promise<DeliveryResult>,
  ): Promise<TrialSetupOutcome> {
    try {
      const result = await sendWithOneRetry(send);
      if (result.status === 'accepted') return 'accepted';
      this.logger.warn(`Free trial setup ${channel} not accepted for company ${binToUuid(companyId)}: ${result.reason}`);
      return result.reason === 'channel_unavailable' ? 'unavailable' : 'failed';
    } catch {
      this.logger.warn(`Free trial setup ${channel} failed for company ${binToUuid(companyId)}`);
      return 'failed';
    }
  }

  /**
   * The attempt and its audit, on the transaction given — the audit last. Channels and outcomes only: never a
   * destination, a token or a code. `trial.setup_sent` when a link went to providers, `trial.setup_unavailable` when
   * nothing could carry it and nothing was sent.
   */
  private async record(
    tx: Prisma.TransactionClient,
    who: TrialPrincipal,
    trigger: TrialSetupTrigger,
    label: string,
    linkId: Buffer | null,
    outcomes: Record<SetupChannel, TrialSetupOutcome>,
    at: Date,
  ): Promise<void> {
    await tx.trialSetupMessage.create({
      data: {
        id: newUuidV7Bin(),
        companyId: who.companyId,
        requestedByUserId: trigger === 'resend' ? who.userId : null,
        trigger,
        linkId,
        emailOutcome: outcomes.email,
        whatsappOutcome: outcomes.whatsapp,
        createdAt: at,
      },
    });
    await this.audit.record(
      {
        admin: null,
        actor: trigger === 'resend' ? actorRef(binToUuid(who.userId)) : 'system',
        action: linkId ? 'trial.setup_sent' : 'trial.setup_unavailable',
        targetType: 'Company',
        targetId: who.companyId,
        targetLabel: label,
        after: { trigger, email: outcomes.email, whatsapp: outcomes.whatsapp },
        at,
      },
      tx,
    );
  }

  // ── Readings ─────────────────────────────────────────────────────────────

  /**
   * Which channels can carry the instructions now — asked at the moment of use: a WhatsApp channel in production
   * opens when its delivery proofs load, and the configuration is read as it stands.
   */
  private operational(): Record<SetupChannel, boolean> {
    return operationalChannels({
      email: this.email,
      whatsapp: this.whatsapp,
      whatsappTemplate: this.config.whatsappTemplateName(TRIAL_SETUP_TEMPLATE.configKey) !== '',
      outboxAllowed: outboxAllowed(),
      linkable: this.config.publicSiteOrigin !== '' && bindingKey(this.config.otpPepper) !== null,
    });
  }

  /** The business's newest attempts, newest first. */
  private async attempts(companyId: Buffer, take: number): Promise<SetupAttempt[]> {
    const rows = await this.prisma.trialSetupMessage.findMany({
      where: { companyId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      select: { createdAt: true, trigger: true, emailOutcome: true, whatsappOutcome: true },
    });
    return rows.map((r) => ({ at: r.createdAt, trigger: r.trigger, email: r.emailOutcome, whatsapp: r.whatsappOutcome }));
  }

  /** The newest attempt a provider accepted on some channel — what `sentTo` names — or null. */
  private async lastAccepted(companyId: Buffer): Promise<SetupAttempt | null> {
    const row = await this.prisma.trialSetupMessage.findFirst({
      where: { companyId, OR: [{ emailOutcome: 'accepted' }, { whatsappOutcome: 'accepted' }] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true, trigger: true, emailOutcome: true, whatsappOutcome: true },
    });
    return row ? { at: row.createdAt, trigger: row.trigger, email: row.emailOutcome, whatsapp: row.whatsappOutcome } : null;
  }

  /** Every attempt of the last 24 hours, whatever triggered it: what the throttle counts. */
  private async recentAttempts(db: Prisma.TransactionClient, companyId: Buffer, now: Date): Promise<Date[]> {
    const rows = await db.trialSetupMessage.findMany({
      where: { companyId, createdAt: { gt: new Date(now.getTime() - RESEND_DAY_MS) } },
      select: { createdAt: true },
    });
    return rows.map((r) => r.createdAt);
  }

  /** A link issued in the last minute: an attempt still in flight, whose own record may not be written yet. */
  private async linkInFlight(db: Prisma.TransactionClient, companyId: Buffer, now: Date): Promise<Date | null> {
    const row = await db.trialSetupLink.findFirst({
      where: { companyId, createdAt: { gt: new Date(now.getTime() - RESEND_MIN_INTERVAL_MS) } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return row?.createdAt ?? null;
  }

  /** The language the business registered in — what its Owner chose to read — or English. */
  private async languageOf(db: Prisma.TransactionClient, companyId: Buffer): Promise<MessageLanguage> {
    const attempt = await db.registrationAttempt.findFirst({ where: { companyId }, select: { language: true } });
    const language = attempt?.language as MessageLanguage | undefined;
    return language && LANGUAGES.includes(language) ? language : 'en';
  }
}
