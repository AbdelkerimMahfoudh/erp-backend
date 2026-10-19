import type { SubscriptionNoticeKind } from '@prisma/client';
import { GRACE_MS, grantCovers, type GraceDecision } from '../entitlement/grace-rules';
import type { DeliveryResult } from '../messaging/whatsapp-channel';
import type { ReminderThreshold } from './notice-copy';

/**
 * The subscription messages — their pure rules (0099; the owner's brief of 2026-10-18; docs/101 §6).
 *
 * **What is due.** A company's timeline is a short list of slots: 72, 48 and 24 hours before its free trial ends and
 * the end itself; or 72, 48 and 24 hours before its paid period ends, the end (which says whether grace started), 48
 * and 24 hours of grace left, and the grace's end. Each slot applies from its instant until the next one's, so at any
 * moment at most ONE is current, and only the current one is ever sent: a message that could not go out before the
 * next took its place is superseded, never sent late — no burst of stale reminders after a pause. An end is announced
 * for seven days at most. Nothing applies while the business is suspended, cancelled, refused or closed, to a period a
 * platform grant covers, or to a trial that paid access follows.
 *
 * **Who carries it.** WhatsApp first, and alone whenever it can carry the message: configured and open, the approved
 * template named, the Owner's number verified and not known to be undeliverable, and not blocked by the Owner's own
 * opt-out or a missing consent. Email — to a verified address only — is the fallback, and only for the recorded
 * reasons: WhatsApp disabled or not configured, the template unavailable, the number unverified or undeliverable, an
 * immediate refusal by the provider, retries exhausted, or a message the provider accepted and then reported failed.
 * A receipt not yet arrived is never a reason. An opt-out or a missing consent stops the message: it is reported as
 * not sent, never carried another way.
 *
 * The identity of a message — company, period, kind, threshold — is the database's UNIQUE key, so a retry, a webhook
 * replay, a restart or two workers can never send one twice.
 */

const HOUR_MS = 3_600_000;

/** How long before an end each reminder falls. */
export const REMINDER_LEAD_HOURS: Record<ReminderThreshold, number> = { h72: 72, h48: 48, h24: 24 };

/** How long after an end its message may still go out. Older ends are not announced. */
export const END_NOTICE_WINDOW_MS = 7 * 24 * HOUR_MS;

/** The messages the timeline produces — every kind but the portal instructions, which the Owner's own steps produce. */
export type LifecycleKind = Exclude<SubscriptionNoticeKind, 'portal_instructions'>;

export type SlotThreshold = ReminderThreshold | 'end';

/** A paid period end's message says which it was. */
export type ExpiryVariant = 'grace_started' | 'no_grace';

/** What the timeline is computed from: the business as the server holds it now — never a client's value. */
export interface NoticeSubject {
  /** The subscription's status; null when there is no subscription. */
  status: string | null;
  currentPeriodEnd: Date | null;
  isComplimentary: boolean;
  complimentaryUntil: Date | null;
  /** The company is open: active and not closed. */
  open: boolean;
  /** The trial's claim, when there is one. */
  trial: { claimId: string; endsAt: Date } | null;
  /** The decision recorded for the current period end; null when none is recorded (yet). */
  grace: { decision: GraceDecision } | null;
}

/** One message of the timeline, while it applies. */
export interface NoticeSlot {
  kind: LifecycleKind;
  threshold: SlotThreshold;
  periodKey: string;
  variant: ExpiryVariant | null;
  /** From when it applies. */
  dueAt: Date;
  /** Until when it applies: the next slot's instant, or the end of the announcement window. */
  until: Date;
  /** The instant it is about: the end counted down to, or the end announced. */
  about: Date;
}

/** The trial's period key: its claim, which exists once per company. */
export const trialPeriodKey = (claimId: string): string => `trial:${claimId}`;
/** A paid period's key: its end, to the millisecond — a renewal is a new key, and an edit back to an old end is the old one. */
export const paidPeriodKey = (end: Date): string => `paid:${end.getTime()}`;
/** The grace after a paid period end: one decision per end (`grace_episodes`), so the end keys it. */
export const gracePeriodKey = (end: Date): string => `grace:${end.getTime()}`;
/** The portal instructions' key: the eligibility they announce. */
export const eligibilityPeriodKey = (eligibilityId: string): string => `eligibility:${eligibilityId}`;

/** The automatic portal instructions' threshold — at most one per eligibility. A resend is `resend:<uuid>`. */
export const AUTOMATIC_INSTRUCTIONS = 'auto';

const at = (ms: number) => new Date(ms);

function countdown(kind: 'trial_reminder' | 'paid_reminder' | 'grace_reminder', periodKey: string, end: number, thresholds: readonly ReminderThreshold[]): NoticeSlot[] {
  return thresholds.map((threshold, i) => {
    const next = thresholds[i + 1];
    return {
      kind,
      threshold,
      periodKey,
      variant: null,
      dueAt: at(end - REMINDER_LEAD_HOURS[threshold] * HOUR_MS),
      until: at(next ? end - REMINDER_LEAD_HOURS[next] * HOUR_MS : end),
      about: at(end),
    };
  });
}

/** Whether a platform grant keeps the business open at `instant`. */
const granted = (s: NoticeSubject, instant: Date): boolean =>
  grantCovers({ currentPeriodEnd: s.currentPeriodEnd, isComplimentary: s.isComplimentary, complimentaryUntil: s.complimentaryUntil }, instant);

/** Whether paid access, or a platform grant, takes over at the trial's end: then nothing about the trial's end is sent. */
function accessFollowsTrial(s: NoticeSubject, trialEnd: Date): boolean {
  if (granted(s, trialEnd)) return true;
  return s.status === 'activated' && s.currentPeriodEnd !== null && s.currentPeriodEnd.getTime() > trialEnd.getTime();
}

/**
 * The company's timeline as it stands: the slots of its trial's end, or of its current paid period's end — in order,
 * each applying until the next. Empty when nothing is owed (see the file's comment).
 */
export function slotsOf(s: NoticeSubject): NoticeSlot[] {
  if (!s.open) return [];
  if (s.status !== 'activated' && s.status !== 'pending_activation') return [];

  const slots: NoticeSlot[] = [];
  const trial = s.trial;
  if (trial && !accessFollowsTrial(s, trial.endsAt)) {
    const key = trialPeriodKey(trial.claimId);
    const end = trial.endsAt.getTime();
    slots.push(...countdown('trial_reminder', key, end, ['h72', 'h48', 'h24']));
    slots.push({ kind: 'trial_expired', threshold: 'end', periodKey: key, variant: null, dueAt: at(end), until: at(end + END_NOTICE_WINDOW_MS), about: at(end) });
    return slots;
  }

  const periodEnd = s.currentPeriodEnd;
  if (s.status !== 'activated' || !periodEnd) return [];
  // A paid end inside the trial cannot happen (the lifecycle's fence starts paid access at the trial's end); and a
  // grant covering the end keeps the business open past it — neither is announced.
  if (trial && periodEnd.getTime() <= trial.endsAt.getTime()) return [];
  if (granted(s, periodEnd)) return [];

  const end = periodEnd.getTime();
  const paid = paidPeriodKey(periodEnd);
  slots.push(...countdown('paid_reminder', paid, end, ['h72', 'h48', 'h24']));
  const decision = s.grace?.decision ?? null;
  const graceEnd = end + GRACE_MS;
  slots.push({
    kind: 'paid_expired',
    threshold: 'end',
    periodKey: paid,
    variant: decision === null ? null : decision === 'granted' ? 'grace_started' : 'no_grace',
    dueAt: at(end),
    // With grace, the 48-hours-left reminder takes over a day later; without, the end is announced for the window.
    until: at(decision === 'refused' ? end + END_NOTICE_WINDOW_MS : end + 24 * HOUR_MS),
    about: at(end),
  });
  if (decision === 'granted') {
    const grace = gracePeriodKey(periodEnd);
    slots.push(...countdown('grace_reminder', grace, graceEnd, ['h48', 'h24']));
    slots.push({ kind: 'grace_ended', threshold: 'end', periodKey: grace, variant: null, dueAt: at(graceEnd), until: at(graceEnd + END_NOTICE_WINDOW_MS), about: at(graceEnd) });
  }
  return slots;
}

/**
 * The one message that applies now, or null. A paid end whose grace decision is not recorded yet is not ready: its
 * message waits for the decision (the sweeper writes it within the minute), so what it says is what was recorded.
 */
export function currentSlot(s: NoticeSubject, now: Date): NoticeSlot | null {
  const t = now.getTime();
  const slot = slotsOf(s).find((x) => x.dueAt.getTime() <= t && t < x.until.getTime()) ?? null;
  if (slot && slot.kind === 'paid_expired' && slot.variant === null) return null;
  return slot;
}

/** The next message the timeline will send, as things stand — for display; null when none is coming. */
export function nextSlot(s: NoticeSubject, now: Date): NoticeSlot | null {
  return slotsOf(s).find((x) => x.dueAt.getTime() > now.getTime()) ?? null;
}

/** Whether a stored message is the one that applies now: same period, kind and threshold. */
export function isCurrent(stored: { kind: string; periodKey: string; threshold: string }, slot: NoticeSlot | null): boolean {
  return slot !== null && stored.kind === slot.kind && stored.periodKey === slot.periodKey && stored.threshold === slot.threshold;
}

// ── Who carries it ───────────────────────────────────────────────────────────

/** Why email carried a message (`subscription_notices.fallback_reason`). */
export type FallbackReason =
  /** The Owner's number has no operational WhatsApp consent in force (never agreed, or to an earlier copy; D213). */
  | 'consent_missing'
  /** The Owner withdrew the operational WhatsApp consent, in the app or by STOP — WhatsApp only; email is a separate channel. */
  | 'consent_withdrawn'
  | 'whatsapp_disabled'
  | 'template_unavailable'
  | 'number_unverified'
  | 'number_undeliverable'
  | 'provider_refused'
  | 'retries_exhausted'
  | 'async_failed';

/** Why nothing carried it (`subscription_notices.failure_reason`). */
export type FailureReason =
  /** Before D213's correction: the Owner had withdrawn WhatsApp and nothing carried the message. Kept for old rows. */
  | 'opted_out'
  /** Before D213's correction: no consent, and nothing carried the message. Kept for old rows. */
  | 'no_consent'
  /** WhatsApp could not carry it, and the Owner has no verified email address. */
  | 'no_email'
  /** WhatsApp could not carry it, and no email provider is configured. */
  | 'email_unavailable'
  /** The email provider refused it, or kept failing. */
  | 'email_failed'
  /** The business has no active Owner to write to. */
  | 'no_recipient'
  /** The message kept failing inside this server; parked after its retries (logged by class, never by content). */
  | 'internal_error';

/** What the policy knows about WhatsApp for this message, at the moment it would be sent. */
export interface WhatsAppFacts {
  /** A channel that sends to this number: configured, open (in production, proven) and, in test mode, allowlisted. */
  channelOpen: boolean;
  /** The approved template's provider name is configured (always true of the development log). */
  templateApproved: boolean;
  /** The Owner's number is set and verified. */
  numberVerified: boolean;
  /** The provider said this number cannot receive messages. */
  undeliverable: boolean;
  /** The Owner's own choice: a withdrawal (`all`), or a STOP recorded before D213 (`optional`). */
  optOut: 'none' | 'optional' | 'all';
  /** The number's operational consent is the copy in force (D213), in every mode. */
  consented: boolean;
}

export type WhatsAppPlan = { action: 'send' } | { action: 'fallback'; reason: FallbackReason } | { action: 'stop'; reason: FailureReason };

/**
 * Before WhatsApp is asked: send, or fall back to email with the reason — in the routing order of D213: a verified
 * number, the consent in force, a deliverable number, the approved template, the channel. These messages are
 * informational (the portal instructions, the trial and paid reminders, grace and read-only notices), so whatever keeps
 * WhatsApp from carrying one — a missing or withdrawn consent included — lets a verified email carry it instead: a
 * withdrawal from WhatsApp is not a withdrawal from operational email, and email never stands in for a WhatsApp consent.
 * No code, recovery, deletion confirmation, employee verification or financial report is ever routed here.
 */
export function whatsappPlan(f: WhatsAppFacts): WhatsAppPlan {
  if (!f.numberVerified) return { action: 'fallback', reason: 'number_unverified' };
  if (f.optOut !== 'none') return { action: 'fallback', reason: 'consent_withdrawn' };
  if (!f.consented) return { action: 'fallback', reason: 'consent_missing' };
  if (f.undeliverable) return { action: 'fallback', reason: 'number_undeliverable' };
  if (!f.templateApproved) return { action: 'fallback', reason: 'template_unavailable' };
  if (!f.channelOpen) return { action: 'fallback', reason: 'whatsapp_disabled' };
  return { action: 'send' };
}

/** WhatsApp attempts before its temporary failures count as exhausted. */
export const MAX_WHATSAPP_ATTEMPTS = 5;
/** Email attempts before its temporary failures count as a failure. */
export const MAX_EMAIL_ATTEMPTS = 5;

/** The provider said the number cannot receive messages (Meta 131026). */
const UNDELIVERABLE_CODE = 131026;

export type WhatsAppStep =
  | { next: 'accepted'; providerMessageId: string | null }
  | { next: 'retry' }
  | { next: 'fallback'; reason: FallbackReason }
  | { next: 'stop'; reason: FailureReason };

/**
 * After WhatsApp answered: accepted; a temporary failure retried until the attempts run out, then the fallback; an
 * immediate refusal falls back — named as a withdrawal when the Owner's own choice refused it (`optedOutNow`, read
 * again after a refusal).
 */
export function afterWhatsApp(result: DeliveryResult, attempts: number, optedOutNow: boolean): WhatsAppStep {
  if (result.status === 'accepted') return { next: 'accepted', providerMessageId: result.providerMessageId };
  if (result.reason === 'temporary') return attempts < MAX_WHATSAPP_ATTEMPTS ? { next: 'retry' } : { next: 'fallback', reason: 'retries_exhausted' };
  if (result.reason === 'channel_unavailable') return { next: 'fallback', reason: 'whatsapp_disabled' };
  if (optedOutNow) return { next: 'fallback', reason: 'consent_withdrawn' };
  if (result.providerCode === UNDELIVERABLE_CODE) return { next: 'fallback', reason: 'number_undeliverable' };
  return { next: 'fallback', reason: 'provider_refused' };
}

export type EmailStep = { next: 'accepted' } | { next: 'retry' } | { next: 'stop'; reason: FailureReason };

/** After email answered: accepted; a temporary failure retried until the attempts run out; anything else, failed. */
export function afterEmail(result: DeliveryResult, attempts: number): EmailStep {
  if (result.status === 'accepted') return { next: 'accepted' };
  if (result.reason === 'temporary') return attempts < MAX_EMAIL_ATTEMPTS ? { next: 'retry' } : { next: 'stop', reason: 'email_failed' };
  return { next: 'stop', reason: result.reason === 'channel_unavailable' ? 'email_unavailable' : 'email_failed' };
}

/** 30 s after the first attempt, doubling, at most 15 minutes. */
export function noticeBackoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 15 * 60_000);
}

/**
 * How long a message WhatsApp accepted is watched for a terminal failure — the only receipt that sends the email
 * instead. Past it, the acceptance stands.
 */
export const ASYNC_FAILURE_WATCH_MS = 3 * 24 * HOUR_MS;

/** The idempotency keys a message is sent under: the same on every attempt, so a provider never delivers it twice. */
export const whatsappKeyOf = (noticeId: string): string => `notice:${noticeId}:wa`;
export const emailKeyOf = (noticeId: string): string => `notice:${noticeId}:email`;
