import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, type SubscriptionNotice, type SubscriptionNoticeKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../common/config/app-config.service';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { CLOCK, type Clock } from '../entitlement/clock';
import { EntitlementService } from '../entitlement/entitlement.service';
import { GRACE_ALLOWANCE, GRACE_MS } from '../entitlement/grace-rules';
import { WHATSAPP_CHANNEL, type DeliveryResult, type WhatsAppChannel } from '../messaging/whatsapp-channel';
import { EMAIL_CHANNEL, type EmailChannel } from '../messaging/email-channel';
import { RecipientHasher } from '../messaging/recipient-hash';
import { WhatsAppRecords } from '../messaging/whatsapp-records';
import {
  GRACE_ENDED_TEMPLATE,
  GRACE_REMINDER_TEMPLATE,
  GRACE_STARTED_TEMPLATE,
  NO_GRACE_TEMPLATE,
  PAID_REMINDER_TEMPLATE,
  PORTAL_INSTRUCTIONS_TEMPLATE,
  TRIAL_EXPIRED_TEMPLATE,
  TRIAL_REMINDER_TEMPLATE,
  type MessageLanguage,
  type TemplateDefinition,
} from '../messaging/templates';
import type { SubscriptionEmailKey } from '../messaging/email-channel';
import { isRealChannel, outboxAllowed } from '../platform/contact-delivery';
import { mayClaimNow, readFacts } from '../platform/trial/trial-facts';
import { maskForOwner } from '../platform/trial/trial-rules';
import { daysLeftText, formatNoticeInstant, graceHoursLeftText, type ReminderThreshold } from './notice-copy';
import {
  ASYNC_FAILURE_WATCH_MS,
  AUTOMATIC_INSTRUCTIONS,
  afterEmail,
  afterWhatsApp,
  currentSlot,
  eligibilityPeriodKey,
  emailKeyOf,
  isCurrent,
  nextSlot,
  noticeBackoffMs,
  whatsappKeyOf,
  whatsappPlan,
  type FailureReason,
  type FallbackReason,
  type NoticeSlot,
  type NoticeSubject,
} from './notice-rules';

/**
 * The subscription messages' outbox (0099; the owner's brief of 2026-10-18; docs/101 §6) — `subscription_notices`, one
 * row per message identity, worked like the other outboxes (`whatsapp-webhook.worker.ts`):
 *
 *  - **Scheduled from the facts.** `refresh` computes the one message that applies to a company now
 *    (`notice-rules.currentSlot`), creates it if it does not exist, and retires what no longer applies — superseded
 *    by a later slot, or cancelled because the business was renewed, suspended, cancelled, closed or granted. A
 *    message stopped by a suspension applies again on reinstatement, while its slot lasts.
 *  - **Leased, never lost.** A worker claims a row with a lease; one that dies lets it expire, and the next pass takes
 *    it again. Every send is re-validated against the facts at that moment — a message whose slot passed while it
 *    waited is superseded, not sent late.
 *  - **One message, once.** The identity is UNIQUE; each channel's provider call carries the same idempotency key on
 *    every attempt (`notice:<id>:wa`, `notice:<id>:email`), which the WhatsApp and email records collapse on.
 *  - **WhatsApp first, email only for a recorded reason** (`notice-rules.whatsappPlan`, `afterWhatsApp`): the
 *    reason is stored with the message, and a message WhatsApp accepted and then reported failed falls back once.
 *  - **Honest.** A message nothing could carry is `failed` with its reason, its destination masked, never `sent`.
 *
 * No message carries a token, an identifier or a link built per person: the WhatsApp copy holds the portal's address
 * in its approved text, and the email's `{link}` is always `<PORTAL_ORIGIN>/subscription`.
 */

/** How long a worker holds a message it is sending. */
const LEASE_MS = 2 * 60_000;
/** Messages claimed per batch. */
const BATCH_SIZE = 50;
/** Unexpected errors before a message is parked as failed (`internal_error`). */
const MAX_ERRORS = 10;
const LANGUAGES: readonly MessageLanguage[] = ['en', 'fr', 'ar'];

/** The business as a message needs it: the timeline's facts, its name and zone, and the decision recorded at its end. */
interface SubjectRow {
  name: string;
  timezone: string;
  subscriptionId: Buffer;
  subject: NoticeSubject;
  /** Granted activations counted against the current period end, when its decision is recorded. */
  usesBefore: number | null;
}

/** The person a message goes to: an active Owner of the business. */
interface Recipient {
  id: Buffer;
  phone: string | null;
  phoneVerifiedAt: Date | null;
  email: string | null;
  emailVerifiedAt: Date | null;
}

/** What a send ends with, written in one conditional update under the lease. */
type Transition = Prisma.SubscriptionNoticeUpdateManyMutationInput;

/** Where the newest portal instructions stand, as the Owner is told it — display only, never a condition for claiming. */
export type InstructionsDelivery = 'waiting_for_contact' | 'sending' | 'not_sent' | 'sent' | 'failed';

export interface InstructionsStatus {
  delivery: InstructionsDelivery;
  /** The channel the newest instructions went, or were to go, by. */
  channel: 'whatsapp' | 'email' | null;
  /** That channel's destination, masked; null when none was chosen. */
  destination: string | null;
  fallbackReason: FallbackReason | null;
  failureReason: FailureReason | null;
  /** UTC ISO: when the newest instructions were asked for; null when never. */
  lastAttemptAt: string | null;
  /** UTC ISO: when instructions were last accepted by a provider, whatever happened since; null when never. */
  lastSentAt: string | null;
}

/** One request for the instructions, as the portal lists it. */
export interface InstructionsHistoryEntry {
  at: string;
  trigger: 'automatic' | 'resend';
  delivery: Exclude<InstructionsDelivery, 'waiting_for_contact'>;
  channel: 'whatsapp' | 'email' | null;
  fallbackReason: FallbackReason | null;
  failureReason: FailureReason | null;
}

/** The timeline's messages, as the portal and the console show them. */
export interface NoticeTimeline {
  /** The next message the timeline will send as things stand; null when none is coming. */
  next: { kind: SubscriptionNoticeKind; threshold: string; dueAt: string } | null;
  /** The newest message of the timeline, whatever became of it. */
  last: {
    kind: SubscriptionNoticeKind;
    threshold: string;
    state: SubscriptionNotice['state'];
    channel: 'whatsapp' | 'email' | null;
    destination: string | null;
    fallbackReason: FallbackReason | null;
    failureReason: FailureReason | null;
    at: string;
  } | null;
}

const TEMPLATES: Record<Exclude<SubscriptionNoticeKind, 'paid_expired'>, TemplateDefinition> = {
  portal_instructions: PORTAL_INSTRUCTIONS_TEMPLATE,
  trial_reminder: TRIAL_REMINDER_TEMPLATE,
  trial_expired: TRIAL_EXPIRED_TEMPLATE,
  paid_reminder: PAID_REMINDER_TEMPLATE,
  grace_reminder: GRACE_REMINDER_TEMPLATE,
  grace_ended: GRACE_ENDED_TEMPLATE,
};

/** The approved template a message is sent with; a paid period end says which it was. */
export function templateOf(kind: SubscriptionNoticeKind, variant: string | null): TemplateDefinition {
  if (kind === 'paid_expired') return variant === 'no_grace' ? NO_GRACE_TEMPLATE : GRACE_STARTED_TEMPLATE;
  return TEMPLATES[kind];
}

/** Why the timeline has nothing for a business: what a waiting message is cancelled with. */
function quietReason(s: NoticeSubject | null): string {
  if (!s) return 'no_subscription';
  if (!s.open) return 'closed';
  if (s.status === 'suspended') return 'suspended';
  if (s.status === 'cancelled') return 'cancelled';
  if (s.status === 'rejected') return 'refused';
  return 'period_changed';
}

const reasonOf = <T extends string>(value: string | null): T | null => (value as T | null) ?? null;

@Injectable()
export class NoticeService {
  private readonly log = new Logger(NoticeService.name);
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly entitlement: EntitlementService,
    private readonly records: WhatsAppRecords,
    private readonly hasher: RecipientHasher,
    @Inject(WHATSAPP_CHANNEL) private readonly whatsapp: WhatsAppChannel,
    @Inject(EMAIL_CHANNEL) private readonly email: EmailChannel,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ── Scheduling ───────────────────────────────────────────────────────────

  /**
   * Bring the company's timeline up to date: the message that applies now exists, and nothing else of the timeline is
   * waiting. Called by the minute's pass and after every lifecycle decision. Never throws.
   */
  async refresh(companyId: Buffer): Promise<void> {
    try {
      const now = this.clock.now();
      const row = await this.readSubject(companyId);
      const slot = row ? currentSlot(row.subject, now) : null;
      if (row && slot) await this.ensure(companyId, row, slot, now);
      await this.prisma.subscriptionNotice.updateMany({
        where: {
          companyId,
          kind: { not: 'portal_instructions' },
          state: 'pending',
          ...(slot ? { NOT: { kind: slot.kind, periodKey: slot.periodKey, threshold: slot.threshold } } : {}),
        },
        data: slot
          ? { state: 'superseded', completedAt: now }
          : { state: 'cancelled', cancelReason: quietReason(row?.subject ?? null), completedAt: now },
      });
    } catch (e) {
      this.log.warn(`Subscription messages not brought up to date for company ${binToUuid(companyId)}: ${describe(e)}`);
    }
  }

  /** The slot's message, created once; one stopped by a suspension waits again once the business is reinstated. */
  private async ensure(companyId: Buffer, row: SubjectRow, slot: NoticeSlot, now: Date): Promise<void> {
    const identity = { companyId, periodKey: slot.periodKey, kind: slot.kind, threshold: slot.threshold };
    const existing = await this.prisma.subscriptionNotice.findFirst({ where: identity, select: { id: true, state: true, cancelReason: true } });
    if (existing) {
      if (existing.state === 'cancelled' && existing.cancelReason === 'suspended') {
        await this.prisma.subscriptionNotice.updateMany({
          where: { id: existing.id, state: 'cancelled' },
          data: { state: 'pending', cancelReason: null, completedAt: null, attempts: 0, nextAttemptAt: now },
        });
      }
      return;
    }
    try {
      await this.prisma.subscriptionNotice.create({
        data: {
          id: newUuidV7Bin(),
          ...identity,
          subscriptionId: row.subscriptionId,
          variant: slot.variant,
          dueAt: slot.dueAt,
          language: await this.languageOf(this.prisma, companyId),
          nextAttemptAt: now,
          createdAt: now,
        },
      });
    } catch (e) {
      // Another pass created it a moment ago: that row is the message.
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    }
  }

  /**
   * The portal instructions, asked for on the transaction given (which holds the subscription row): automatically,
   * once per eligibility — null when they were already asked for — or as the Owner's resend from the portal. The
   * worker sends them; `deliverNow` is the caller's to start once the transaction committed.
   */
  async requestInstructions(
    tx: Prisma.TransactionClient,
    p: { companyId: Buffer; subscriptionId: Buffer; eligibilityId: Buffer; requestedBy: Buffer | null; now: Date },
  ): Promise<Buffer | null> {
    const periodKey = eligibilityPeriodKey(binToUuid(p.eligibilityId));
    const threshold = p.requestedBy ? `resend:${binToUuid(newUuidV7Bin())}` : AUTOMATIC_INSTRUCTIONS;
    if (!p.requestedBy) {
      const sent = await tx.subscriptionNotice.findFirst({
        where: { companyId: p.companyId, kind: 'portal_instructions', periodKey, threshold },
        select: { id: true },
      });
      if (sent) return null;
    }
    const id = newUuidV7Bin();
    await tx.subscriptionNotice.create({
      data: {
        id,
        companyId: p.companyId,
        subscriptionId: p.subscriptionId,
        kind: 'portal_instructions',
        periodKey,
        threshold,
        dueAt: p.now,
        language: await this.languageOf(tx, p.companyId),
        requestedByUserId: p.requestedBy,
        nextAttemptAt: p.now,
        createdAt: p.now,
      },
    });
    return id;
  }

  // ── Delivery ─────────────────────────────────────────────────────────────

  /** One delivery pass at a time in this process; a call during a pass gets one more after it. Never rejects. */
  deliverNow(): Promise<void> {
    this.again = true;
    if (!this.running) {
      this.running = (async () => {
        try {
          while (this.again) {
            this.again = false;
            try {
              await this.deliverDue();
            } catch (e) {
              this.log.error(`Subscription message pass failed; the messages stay queued: ${describe(e)}`);
            }
          }
        } finally {
          this.running = null;
        }
      })();
    }
    return this.running;
  }

  /** Every message due, or whose lease expired, in batches. */
  private async deliverDue(): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      const due = await this.prisma.subscriptionNotice.findMany({
        where: { OR: [{ state: 'pending', nextAttemptAt: { lte: now } }, { state: 'sending', claimedUntil: { lt: now } }] },
        orderBy: { nextAttemptAt: 'asc' },
        take: BATCH_SIZE,
        select: { id: true },
      });
      if (due.length === 0) return;
      let progressed = false;
      for (const { id } of due) if (await this.deliverOne(id)) progressed = true;
      if (due.length < BATCH_SIZE || !progressed) return;
    }
  }

  /** Claim one message and send it. True when this call held it. */
  async deliverOne(id: Buffer): Promise<boolean> {
    const now = this.clock.now();
    const token = newUuidV7Bin();
    const claimed = await this.prisma.subscriptionNotice.updateMany({
      where: { id, OR: [{ state: 'pending', nextAttemptAt: { lte: now } }, { state: 'sending', claimedUntil: { lt: now } }] },
      data: { state: 'sending', claimToken: token, claimedUntil: new Date(now.getTime() + LEASE_MS), attempts: { increment: 1 } },
    });
    if (claimed.count === 0) return false;
    const notice = await this.prisma.subscriptionNotice.findUnique({ where: { id } });
    if (!notice) return false;
    let transition: Transition;
    try {
      transition = await this.work(notice);
    } catch (e) {
      const parked = notice.attempts >= MAX_ERRORS;
      this.log.warn(`Subscription message ${binToUuid(id)} (${notice.kind}) hit an error, attempt ${notice.attempts}${parked ? ', parked' : ''}: ${describe(e)}`);
      transition = parked
        ? { state: 'failed', failureReason: 'internal_error', completedAt: this.clock.now() }
        : { state: 'pending', nextAttemptAt: new Date(this.clock.now().getTime() + noticeBackoffMs(notice.attempts)) };
    }
    await this.prisma.subscriptionNotice.updateMany({
      where: { id, claimToken: token, state: 'sending' },
      data: { ...transition, claimToken: null, claimedUntil: null },
    });
    return true;
  }

  /**
   * One attempt: re-validated against the facts as they are now, then WhatsApp — or email, for a recorded reason.
   * Returns how the message's row ends this attempt.
   */
  private async work(n: SubscriptionNotice): Promise<Transition> {
    const now = this.clock.now();
    const row = await this.readSubject(n.companyId);
    let slot: NoticeSlot | null = null;
    if (n.kind === 'portal_instructions') {
      const facts = await readFacts(this.prisma, n.companyId);
      if (!facts || !mayClaimNow(facts, now)) return { state: 'cancelled', cancelReason: 'trial_not_available', completedAt: now };
    } else {
      slot = row ? currentSlot(row.subject, now) : null;
      if (!isCurrent(n, slot)) {
        return slot ? { state: 'superseded', completedAt: now } : { state: 'cancelled', cancelReason: quietReason(row?.subject ?? null), completedAt: now };
      }
    }
    if (!row) return { state: 'cancelled', cancelReason: 'no_subscription', completedAt: now };

    const recipient = await this.recipientOf(n);
    if (!recipient) return { state: 'failed', failureReason: 'no_recipient', completedAt: now };
    const template = templateOf(n.kind, n.variant);
    const language = (LANGUAGES as readonly string[]).includes(n.language) ? (n.language as MessageLanguage) : 'en';
    const variables = this.variablesOf(n, row, slot, language);

    if (n.fallbackReason === null) {
      const step = await this.tryWhatsApp(n, recipient, template, language, variables);
      if (step.done) return step.transition;
      return this.tryEmail(n, recipient, template, language, variables, step.reason, step.whatsappOutcome, 1);
    }
    return this.tryEmail(n, recipient, template, language, variables, n.fallbackReason as FallbackReason, n.whatsappOutcome, n.attempts);
  }

  /** WhatsApp's attempt: a final transition, or the reason email is tried now. */
  private async tryWhatsApp(
    n: SubscriptionNotice,
    to: Recipient,
    template: TemplateDefinition,
    language: MessageLanguage,
    variables: Record<string, string>,
  ): Promise<{ done: true; transition: Transition } | { done: false; reason: FallbackReason; whatsappOutcome: string }> {
    const now = this.clock.now();
    const phone = to.phone && to.phoneVerifiedAt ? to.phone : null;
    const contact = phone ? await this.records.contactState(phone) : null;
    const real = isRealChannel(this.whatsapp);
    const plan = whatsappPlan({
      channelOpen: phone !== null && this.whatsappOpen() && (this.whatsapp.accepts ? this.whatsapp.accepts(phone) : true),
      templateApproved: !real || this.config.whatsappTemplateName(template.configKey) !== '',
      numberVerified: phone !== null,
      undeliverable: contact?.undeliverableAt != null,
      optOut: contact?.consent === 'withdrawn' ? 'all' : contact?.optOutScope ?? 'none',
      consented: contact?.consented ?? false,
    });
    // Masked as its Owner is shown it everywhere — the portal, the app's list of verified contacts — so one number reads the same.
    const destination = phone ? { destinationMasked: maskForOwner('phone', phone), destinationHash: this.hasher.hash(phone) } : {};
    if (plan.action === 'stop') {
      return { done: true, transition: { state: 'failed', whatsappOutcome: 'refused', failureReason: plan.reason, ...destination, completedAt: now } };
    }
    if (plan.action === 'fallback') return { done: false, reason: plan.reason, whatsappOutcome: 'unavailable' };

    let result: DeliveryResult;
    try {
      result = await this.whatsapp.send({ to: phone!, template: template.key, language, variables, idempotencyKey: whatsappKeyOf(binToUuid(n.id)) });
    } catch {
      result = { status: 'failed', reason: 'temporary', detail: 'The channel raised an unexpected error', provider: this.whatsapp.name };
    }
    const optedOutNow = result.status === 'failed' && result.reason !== 'temporary' ? (await this.records.contactState(phone!)).optOutScope !== 'none' : false;
    const step = afterWhatsApp(result, n.attempts, optedOutNow);
    switch (step.next) {
      case 'accepted':
        return {
          done: true,
          transition: { state: 'accepted', channel: 'whatsapp', whatsappOutcome: 'accepted', ...destination, acceptedAt: this.clock.now(), failureReason: null },
        };
      case 'retry':
        return {
          done: true,
          transition: { state: 'pending', whatsappOutcome: 'temporary', ...destination, nextAttemptAt: new Date(now.getTime() + noticeBackoffMs(n.attempts)) },
        };
      case 'stop':
        return { done: true, transition: { state: 'failed', whatsappOutcome: 'refused', failureReason: step.reason, ...destination, completedAt: this.clock.now() } };
      case 'fallback':
        return { done: false, reason: step.reason, whatsappOutcome: step.reason === 'whatsapp_disabled' ? 'unavailable' : 'failed' };
    }
  }

  /** Email's attempt, for the recorded reason: to a verified address only. */
  private async tryEmail(
    n: SubscriptionNotice,
    to: Recipient,
    template: TemplateDefinition,
    language: MessageLanguage,
    variables: Record<string, string>,
    reason: FallbackReason,
    whatsappOutcome: string | null,
    attempts: number,
  ): Promise<Transition> {
    const now = this.clock.now();
    const base: Transition = { fallbackReason: reason, whatsappOutcome };
    const address = to.email && to.emailVerifiedAt ? to.email : null;
    if (!address) return { ...base, state: 'failed', emailOutcome: 'not_applicable', failureReason: 'no_email', completedAt: now };
    const destination = { destinationMasked: maskForOwner('email', address), destinationHash: this.hasher.hash(address) };
    const link = this.config.portalSubscriptionUrl;
    if (!this.emailOpen() || !link) {
      return { ...base, ...destination, state: 'failed', emailOutcome: 'unavailable', failureReason: 'email_unavailable', completedAt: now };
    }
    let result: DeliveryResult;
    try {
      result = await this.email.send({
        to: address,
        template: template.key as SubscriptionEmailKey,
        language,
        variables: { ...variables, link },
        idempotencyKey: emailKeyOf(binToUuid(n.id)),
      });
    } catch {
      result = { status: 'failed', reason: 'temporary', detail: 'The channel raised an unexpected error', provider: this.email.name };
    }
    const step = afterEmail(result, attempts);
    if (step.next === 'accepted') {
      return { ...base, ...destination, state: 'accepted', channel: 'email', emailOutcome: 'accepted', acceptedAt: this.clock.now(), completedAt: this.clock.now(), failureReason: null };
    }
    if (step.next === 'retry') {
      return { ...base, ...destination, state: 'pending', emailOutcome: 'temporary', attempts, nextAttemptAt: new Date(now.getTime() + noticeBackoffMs(attempts)) };
    }
    return { ...base, ...destination, state: 'failed', emailOutcome: step.reason === 'email_unavailable' ? 'unavailable' : 'failed', failureReason: step.reason, completedAt: this.clock.now() };
  }

  /**
   * The messages WhatsApp accepted, watched for the one receipt that changes anything: a terminal failure sends the
   * email instead, once; a delivery or a read completes them. A receipt not yet arrived never does anything, and after
   * `ASYNC_FAILURE_WATCH_MS` the acceptance stands.
   */
  async watchAccepted(): Promise<void> {
    const now = this.clock.now();
    const watched = await this.prisma.subscriptionNotice.findMany({
      where: { state: 'accepted', channel: 'whatsapp', fallbackReason: null, completedAt: null },
      select: { id: true, acceptedAt: true },
      take: 200,
    });
    if (watched.length === 0) return;
    const keys = watched.map((w) => whatsappKeyOf(binToUuid(w.id)));
    const records = await this.prisma.whatsAppMessage.findMany({ where: { idempotencyKey: { in: keys } }, select: { idempotencyKey: true, status: true } });
    const statusOf = new Map(records.map((r) => [r.idempotencyKey, r.status]));
    let failed = 0;
    for (const w of watched) {
      const status = statusOf.get(whatsappKeyOf(binToUuid(w.id)));
      const guard = { id: w.id, state: 'accepted' as const, channel: 'whatsapp' as const, fallbackReason: null };
      if (status === 'failed') {
        const moved = await this.prisma.subscriptionNotice.updateMany({
          where: guard,
          data: { state: 'pending', whatsappOutcome: 'failed_async', fallbackReason: 'async_failed', attempts: 0, nextAttemptAt: now },
        });
        failed += moved.count;
      } else if (status === 'delivered' || status === 'read') {
        await this.prisma.subscriptionNotice.updateMany({ where: guard, data: { state: 'delivered', whatsappOutcome: 'delivered', completedAt: now } });
      } else if (!w.acceptedAt || now.getTime() - w.acceptedAt.getTime() >= ASYNC_FAILURE_WATCH_MS) {
        await this.prisma.subscriptionNotice.updateMany({ where: guard, data: { completedAt: now } });
      }
    }
    if (failed > 0) void this.deliverNow();
  }

  // ── Readings ─────────────────────────────────────────────────────────────

  /** Where the newest portal instructions stand, for the Owner given — display only. */
  async instructionsStatus(companyId: Buffer, owner: Omit<Recipient, 'id'>): Promise<InstructionsStatus> {
    const [newest, accepted] = await Promise.all([
      this.prisma.subscriptionNotice.findFirst({ where: { companyId, kind: 'portal_instructions' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
      this.prisma.subscriptionNotice.findFirst({
        where: { companyId, kind: 'portal_instructions', state: { in: ['accepted', 'delivered'] } },
        orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }],
        select: { acceptedAt: true },
      }),
    ]);
    const base = { lastSentAt: accepted?.acceptedAt?.toISOString() ?? null };
    if (!newest) {
      const waiting = !(owner.phone && owner.phoneVerifiedAt) && !(owner.email && owner.emailVerifiedAt);
      return { ...base, delivery: waiting ? 'waiting_for_contact' : 'not_sent', channel: null, destination: null, fallbackReason: null, failureReason: null, lastAttemptAt: null };
    }
    return {
      ...base,
      delivery: this.deliveryOf(newest, owner),
      channel: newest.channel ?? (newest.fallbackReason ? 'email' : newest.destinationMasked ? 'whatsapp' : null),
      destination: newest.destinationMasked,
      fallbackReason: reasonOf<FallbackReason>(newest.fallbackReason),
      failureReason: reasonOf<FailureReason>(newest.failureReason),
      lastAttemptAt: newest.createdAt.toISOString(),
    };
  }

  /** The newest instruction requests, newest first. */
  async instructionsHistory(companyId: Buffer, owner: Omit<Recipient, 'id'>, take: number): Promise<InstructionsHistoryEntry[]> {
    const rows = await this.prisma.subscriptionNotice.findMany({
      where: { companyId, kind: 'portal_instructions' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });
    return rows.map((r) => ({
      at: r.createdAt.toISOString(),
      trigger: r.threshold === AUTOMATIC_INSTRUCTIONS ? 'automatic' : 'resend',
      delivery: this.deliveryOf(r, owner) as InstructionsHistoryEntry['delivery'],
      channel: r.channel,
      fallbackReason: reasonOf<FallbackReason>(r.fallbackReason),
      failureReason: reasonOf<FailureReason>(r.failureReason),
    }));
  }

  /** When the instructions were asked for in the last `sinceMs` — what the portal's resend throttle counts. */
  async instructionRequestsSince(db: Prisma.TransactionClient, companyId: Buffer, since: Date): Promise<Date[]> {
    const rows = await db.subscriptionNotice.findMany({
      where: { companyId, kind: 'portal_instructions', createdAt: { gt: since } },
      select: { createdAt: true },
    });
    return rows.map((r) => r.createdAt);
  }

  /**
   * Whether the instructions could go to this Owner now, by some channel: WhatsApp, or email for a recorded reason.
   * The portal's resend button says it cannot when neither can.
   */
  async canCarryInstructions(owner: Omit<Recipient, 'id'>): Promise<boolean> {
    const phone = owner.phone && owner.phoneVerifiedAt ? owner.phone : null;
    const contact = phone ? await this.records.contactState(phone) : null;
    const real = isRealChannel(this.whatsapp);
    const plan = whatsappPlan({
      channelOpen: phone !== null && this.whatsappOpen() && (this.whatsapp.accepts ? this.whatsapp.accepts(phone) : true),
      templateApproved: !real || this.config.whatsappTemplateName(PORTAL_INSTRUCTIONS_TEMPLATE.configKey) !== '',
      numberVerified: phone !== null,
      undeliverable: contact?.undeliverableAt != null,
      optOut: contact?.consent === 'withdrawn' ? 'all' : contact?.optOutScope ?? 'none',
      consented: contact?.consented ?? false,
    });
    if (plan.action === 'send') return true;
    if (plan.action === 'stop') return false;
    return Boolean(owner.email && owner.emailVerifiedAt && this.emailOpen() && this.config.portalSubscriptionUrl);
  }

  /** The timeline's next message and its newest one, for the portal and the console. */
  async timelineOf(companyId: Buffer): Promise<NoticeTimeline> {
    const now = this.clock.now();
    const [row, last] = await Promise.all([
      this.readSubject(companyId),
      this.prisma.subscriptionNotice.findFirst({
        where: { companyId, kind: { not: 'portal_instructions' } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    const next = row ? nextSlot(row.subject, now) : null;
    return {
      next: next ? { kind: next.kind, threshold: next.threshold, dueAt: next.dueAt.toISOString() } : null,
      last: last
        ? {
            kind: last.kind,
            threshold: last.threshold,
            state: last.state,
            channel: last.channel,
            destination: last.destinationMasked,
            fallbackReason: reasonOf<FallbackReason>(last.fallbackReason),
            failureReason: reasonOf<FailureReason>(last.failureReason),
            at: (last.acceptedAt ?? last.createdAt).toISOString(),
          }
        : null,
    };
  }

  /**
   * A message as the Owner is told it. `sent` only while the destination it went to is still the Owner's contact on
   * that channel: a message to a number since replaced was not sent to this Owner.
   */
  private deliveryOf(n: SubscriptionNotice, owner: Omit<Recipient, 'id'>): InstructionsDelivery {
    switch (n.state) {
      case 'pending':
      case 'sending':
        return 'sending';
      case 'failed':
        return 'failed';
      case 'cancelled':
      case 'superseded':
        return 'not_sent';
      case 'accepted':
      case 'delivered': {
        const current = n.channel === 'email' ? owner.email : owner.phone;
        return current && n.destinationHash === this.hasher.hash(current) ? 'sent' : 'not_sent';
      }
    }
  }

  /** The business, its timeline's facts and the decision recorded at its current period end. */
  private async readSubject(companyId: Buffer): Promise<SubjectRow | null> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        name: true,
        timezone: true,
        isActive: true,
        closedAt: true,
        subscription: { select: { id: true, status: true, currentPeriodEnd: true, isComplimentary: true, complimentaryUntil: true } },
        trialClaim: { select: { id: true, endsAt: true } },
      },
    });
    const sub = company?.subscription;
    if (!company || !sub) return null;
    const episode = sub.currentPeriodEnd
      ? await this.prisma.graceEpisode.findFirst({ where: { companyId, periodEnd: sub.currentPeriodEnd }, select: { decision: true, usesBefore: true } })
      : null;
    return {
      name: company.name,
      timezone: company.timezone,
      subscriptionId: sub.id,
      usesBefore: episode?.usesBefore ?? null,
      subject: {
        status: sub.status,
        currentPeriodEnd: sub.currentPeriodEnd,
        isComplimentary: sub.isComplimentary,
        complimentaryUntil: sub.complimentaryUntil,
        open: company.isActive && company.closedAt === null,
        trial: company.trialClaim ? { claimId: binToUuid(company.trialClaim.id), endsAt: company.trialClaim.endsAt } : null,
        grace: episode ? { decision: episode.decision } : null,
      },
    };
  }

  /** The Owner who asked for a resend; otherwise the business's first active Owner. */
  private recipientOf(n: SubscriptionNotice): Promise<Recipient | null> {
    return this.prisma.user.findFirst({
      where: {
        companyId: n.companyId,
        ...(n.requestedByUserId ? { id: n.requestedByUserId } : {}),
        isActive: true,
        deletedAt: null,
        userBranches: { some: { role: { key: 'owner' } } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, phone: true, phoneVerifiedAt: true, email: true, emailVerifiedAt: true },
    });
  }

  /** The template's variables, composed here in the message's language from the facts re-read for this attempt. */
  private variablesOf(n: SubscriptionNotice, row: SubjectRow, slot: NoticeSlot | null, language: MessageLanguage): Record<string, string> {
    const business = row.name.trim().replace(/\s+/g, ' ').slice(0, 100);
    if (n.kind === 'portal_instructions' || !slot) return { business };
    const zone = this.entitlement.trialZone(n.companyId, row.timezone);
    const instant = (d: Date) => formatNoticeInstant(d, zone, language);
    switch (slot.kind) {
      case 'trial_reminder':
      case 'paid_reminder':
        return { business, remaining: daysLeftText(slot.threshold as ReminderThreshold, language), ends: instant(slot.about) };
      case 'grace_reminder':
        return { business, remaining: graceHoursLeftText(slot.threshold as 'h48' | 'h24', language), graceEnds: instant(slot.about) };
      case 'paid_expired':
        return slot.variant === 'grace_started'
          ? {
              business,
              ended: instant(slot.about),
              graceEnds: instant(new Date(slot.about.getTime() + GRACE_MS)),
              usesLeft: String(Math.max(0, GRACE_ALLOWANCE - 1 - (row.usesBefore ?? 0))),
            }
          : { business, ended: instant(slot.about) };
      case 'trial_expired':
      case 'grace_ended':
        return { business, ended: instant(slot.about) };
    }
  }

  /** WhatsApp can be asked at all now: a real channel that is open, or the development log where the outbox is allowed. */
  private whatsappOpen(): boolean {
    return isRealChannel(this.whatsapp) || (this.whatsapp.isEnabled && this.whatsapp.name === 'development-log' && outboxAllowed());
  }

  /** Email can be asked at all now, under the same rule. */
  private emailOpen(): boolean {
    return isRealChannel(this.email) || (this.email.isEnabled && this.email.name === 'development-log' && outboxAllowed());
  }

  /** The language the business registered in — what its Owner chose to read — or English. */
  private async languageOf(db: Prisma.TransactionClient, companyId: Buffer): Promise<MessageLanguage> {
    const attempt = await db.registrationAttempt.findFirst({ where: { companyId }, select: { language: true } });
    const language = attempt?.language as MessageLanguage | undefined;
    return language && LANGUAGES.includes(language) ? language : 'en';
  }
}

/** The error's class and Prisma code only — never a message that could carry data. */
function describe(e: unknown): string {
  const err = e as { name?: string; code?: string } | null;
  return [err?.name ?? 'Error', err?.code].filter(Boolean).join(' ');
}
