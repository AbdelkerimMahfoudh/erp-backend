import type { TrialSetupOutcome, TrialSetupTrigger } from '@prisma/client';
import type { EntitlementState } from '../../entitlement/entitlement-rules';
import {
  RESEND_DAY_MAX,
  RESEND_DAY_MS,
  RESEND_MIN_INTERVAL_MS,
  RESEND_WINDOW_MAX,
  RESEND_WINDOW_MS,
  maskForOwner,
  type OwnerContacts,
  type TRIAL_DURATION_DAYS,
  type TRIAL_DURATION_HOURS,
  type TrialContact,
} from './trial-rules';

/**
 * The free trial's setup instructions — their pure rules (0095; docs/76; the owner's correction of 2026-10-13).
 *
 * Once the contacts the Owner gave at registration are all verified, the server sends the instructions — what the
 * trial is, that it has not started, and a link to the Dukan ERP website — to every verified contact whose channel
 * can carry them. Automatically, once. Again only when the Owner, signed in on the website, asks (throttled), or
 * through support: the mobile app shows where things stand and offers nothing to act on.
 *
 * Delivery is never a condition for claiming. These rules decide what is shown about it and when the website may ask
 * again; they never decide whether a trial may start.
 */

/** Where the instructions go: the Owner's verified email address, or their verified WhatsApp number. */
export type SetupChannel = 'email' | 'whatsapp';

/** How many attempts the website lists, newest first. */
export const SETUP_HISTORY_SIZE = 10;

/**
 * How long a verification, or the website's resend, waits for the providers before it answers (C14). Past it the
 * delivery carries on in the background and the status says `sending` until its attempt is recorded: a slow or hung
 * provider never holds the verification the person just completed — nor the session it ends with.
 */
export const SETUP_DELIVERY_WAIT_MS = 3_000;

/**
 * How long a link issued without its attempt recorded reads as `sending` (C1): its providers are still being asked.
 * Past it, still without an attempt, the send was lost on the way — `not_sent`.
 */
export const SETUP_SENDING_WINDOW_MS = 60_000;

/** How long a process shutting down waits for the deliveries still in flight, so that their attempts are recorded. */
export const SETUP_SHUTDOWN_WAIT_MS = 15_000;

/** One attempt as stored (`trial_setup_messages`): when, what triggered it, and what each channel did. */
export interface SetupAttempt {
  at: Date;
  trigger: TrialSetupTrigger;
  email: TrialSetupOutcome;
  whatsapp: TrialSetupOutcome;
}

/**
 * Where the instructions stand, as the Owner is told it:
 *  - `waiting_for_contact` — a required contact is not verified yet, so nothing is sent, by design;
 *  - `sending` — a link was issued less than a minute ago and its providers have not all answered yet;
 *  - `not_sent` — the contacts are complete but no attempt is recorded (a send lost on the way, say);
 *  - `sent` — the last attempt was accepted by a provider on at least one channel;
 *  - `failed` — the last attempt reached providers and none accepted it;
 *  - `unavailable` — the last attempt found no channel that could carry it.
 */
export type SetupDelivery = 'waiting_for_contact' | 'sending' | 'not_sent' | 'sent' | 'failed' | 'unavailable';

/** An attempt's overall outcome: anything accepted is sent; else anything failed is failed; else it was unavailable. */
export function attemptOutcome(attempt: Pick<SetupAttempt, 'email' | 'whatsapp'>): 'sent' | 'failed' | 'unavailable' {
  const outcomes = [attempt.email, attempt.whatsapp];
  if (outcomes.includes('accepted')) return 'sent';
  if (outcomes.includes('failed')) return 'failed';
  return 'unavailable';
}

/** What the status is decided from, read together from the business's attempts and links. */
export interface DeliveryFacts {
  /** The required contacts not verified yet. */
  missing: readonly TrialContact[];
  /** The newest attempt recorded, or null. */
  last: Pick<SetupAttempt, 'at' | 'email' | 'whatsapp'> | null;
  /** The newest link issued and whether its attempt is recorded yet; null when none was ever issued. */
  newestLink: { issuedAt: Date; recorded: boolean } | null;
}

/**
 * The status, at `now`. A link newer than every attempt and without one of its own is a send still in flight — its
 * attempt is written once the providers have answered — for a minute; after that, the send was lost (C1). Otherwise
 * the last attempt says.
 */
export function deliveryOf(facts: DeliveryFacts, now: Date): SetupDelivery {
  if (facts.missing.length > 0) return 'waiting_for_contact';
  const link = facts.newestLink;
  if (link && !link.recorded && (!facts.last || link.issuedAt.getTime() >= facts.last.at.getTime())) {
    return now.getTime() - link.issuedAt.getTime() < SETUP_SENDING_WINDOW_MS ? 'sending' : 'not_sent';
  }
  if (!facts.last) return 'not_sent';
  return attemptOutcome(facts.last);
}

/** The channels a provider accepted in this attempt — the last attempt that had one — email first. */
export function sentTo(attempt: Pick<SetupAttempt, 'email' | 'whatsapp'> | null): SetupChannel[] {
  if (!attempt) return [];
  return (['email', 'whatsapp'] as const).filter((channel) => attempt[channel] === 'accepted');
}

/** A verified contact as its own Owner is shown it — masked, never the value. */
export interface SetupDestination {
  channel: SetupChannel;
  masked: string;
}

/** The Owner's verified contacts only, email first: a contact that is set but unverified is no destination. */
export function verifiedDestinations(owner: OwnerContacts): SetupDestination[] {
  const out: SetupDestination[] = [];
  if (owner.email && owner.emailVerifiedAt) out.push({ channel: 'email', masked: maskForOwner('email', owner.email) });
  if (owner.phone && owner.phoneVerifiedAt) out.push({ channel: 'whatsapp', masked: maskForOwner('phone', owner.phone) });
  return out;
}

/**
 * When the website may ask again, or null when it may now. Every attempt the business has counts, whatever triggered
 * it — the automatic one uses up a place like any other — and a link issued in the last minute is an attempt still in
 * flight, so two requests at once cannot both send:
 *
 *  - a minute after the newest attempt or link;
 *  - fewer than 3 attempts in the last 15 minutes;
 *  - fewer than 10 in the last 24 hours.
 *
 * Each instant is exact: at the one returned, every rule allows it.
 */
export function resendAvailableAt(attempts: readonly Date[], inFlight: Date | null, now: Date): Date | null {
  const times = attempts.map((at) => at.getTime()).sort((a, b) => b - a);
  const candidates: number[] = [];
  const newest = Math.max(times[0] ?? Number.NEGATIVE_INFINITY, inFlight?.getTime() ?? Number.NEGATIVE_INFINITY);
  if (Number.isFinite(newest)) candidates.push(newest + RESEND_MIN_INTERVAL_MS);
  for (const [windowMs, max] of [
    [RESEND_WINDOW_MS, RESEND_WINDOW_MAX],
    [RESEND_DAY_MS, RESEND_DAY_MAX],
  ] as const) {
    const within = times.filter((t) => t > now.getTime() - windowMs);
    // The window allows another once its max-th newest attempt has left it.
    if (within.length >= max) candidates.push(within[max - 1] + windowMs);
  }
  const at = Math.max(...candidates, Number.NEGATIVE_INFINITY);
  return at > now.getTime() ? new Date(at) : null;
}

/** A channel as the sending sees it: its name and whether it is on — read at send time, never from a boot snapshot. */
export interface ChannelState {
  readonly name: string;
  readonly isEnabled: boolean;
}

export interface DeliveryContext {
  email: ChannelState;
  whatsapp: ChannelState;
  /** The approved WhatsApp setup template is named in the configuration. */
  whatsappTemplate: boolean;
  /** The development outbox rule (`outboxAllowed`): development, or staging that opted in — never production. */
  outboxAllowed: boolean;
  /** A link can be built and bound: the website's origin is set, and there is a key to bind the link with. */
  linkable: boolean;
}

/**
 * Which channels can carry the instructions right now.
 *
 *  - email: a real provider; or the development log where the development outbox is allowed;
 *  - WhatsApp: a real channel (in production, proven — `ProvenWhatsAppChannel` says so through `isEnabled`) whose
 *    approved setup template is configured; or the development log under the same outbox rule.
 *
 * Nothing at all without a link: instructions that cannot say where to go are not instructions.
 */
export function operationalChannels(ctx: DeliveryContext): Record<SetupChannel, boolean> {
  if (!ctx.linkable) return { email: false, whatsapp: false };
  const real = (c: ChannelState) => c.isEnabled && c.name !== 'development-log';
  const developmentLog = (c: ChannelState) => c.isEnabled && c.name === 'development-log' && ctx.outboxAllowed;
  return {
    email: real(ctx.email) || developmentLog(ctx.email),
    whatsapp: (real(ctx.whatsapp) && ctx.whatsappTemplate) || developmentLog(ctx.whatsapp),
  };
}

/** What one attempt will do on each channel before any provider is asked: send, or why not. */
export type PlannedOutcome = 'send' | Extract<TrialSetupOutcome, 'unavailable' | 'not_applicable'>;

/** Not a verified contact: not applicable. Verified, but its channel cannot carry this: unavailable. Else: send. */
export function plannedOutcomes(owner: OwnerContacts, operational: Record<SetupChannel, boolean>): Record<SetupChannel, PlannedOutcome> {
  const verified = new Set(verifiedDestinations(owner).map((d) => d.channel));
  const plan = (channel: SetupChannel): PlannedOutcome =>
    !verified.has(channel) ? 'not_applicable' : operational[channel] ? 'send' : 'unavailable';
  return { email: plan('email'), whatsapp: plan('whatsapp') };
}

/**
 * The link an email carries: the website's trial page with the token in the FRAGMENT, which a browser never sends to
 * any server — so it reaches no access log, no proxy and no referrer. (WhatsApp's approved button puts it in `?t=`,
 * because a button suffix cannot be a fragment; the website reads both and removes it from the address at once.)
 */
export function setupLinkUrl(origin: string, token: string): string {
  return `${origin}/account/trial#t=${token}`;
}

/**
 * Whether the link may also be printed to the developer's console: on a development machine only — never staging,
 * never production — so a developer can follow it by hand, the way the WhatsApp development channel prints a code.
 */
export function printsDevelopmentLinks(env: NodeJS.ProcessEnv = process.env): boolean {
  const appEnv = (env.APP_ENV ?? '').trim().toLowerCase();
  if (appEnv === 'staging' || appEnv === 'production') return false;
  return (env.NODE_ENV ?? '').trim().toLowerCase() === 'development';
}

/** One attempt as the website lists it: `automatic` for the send after verification, `resend` for the Owner's. */
export interface SetupHistoryEntry {
  at: string;
  trigger: 'automatic' | 'resend';
  email: TrialSetupOutcome;
  whatsapp: TrialSetupOutcome;
}

export function historyEntry(attempt: SetupAttempt): SetupHistoryEntry {
  return {
    at: attempt.at.toISOString(),
    trigger: attempt.trigger === 'verified' ? 'automatic' : 'resend',
    email: attempt.email,
    whatsapp: attempt.whatsapp,
  };
}

/**
 * The website's `setup` object on the Owner's trial card, and the resend's answer: where the instructions stand, an
 * honest history, and when the Owner may ask again. Never a condition for claiming.
 */
export interface WebsiteSetup {
  delivery: SetupDelivery;
  sentTo: SetupChannel[];
  destinations: SetupDestination[];
  lastAttemptAt: string | null;
  /** No missing contact, a verified contact whose channel can carry it now, and the throttle allows it. */
  canResendNow: boolean;
  /** The earliest instant the throttle allows, or null when it allows now. */
  resendAvailableAt: string | null;
  history: SetupHistoryEntry[];
}

/**
 * What the mobile app may show the Owner (GET account/trial-setup) — display data only. No `canResendNow`, no
 * `resendAvailableAt`, no link, no token, no route: nothing in the app can be acted on (the owner's correction of
 * 2026-10-13). A business that is not `trial_available` is told only that, and the card is never shown.
 */
export type AppSetupStatus =
  | { state: EntitlementState; eligible: false }
  | {
      state: 'trial_available';
      eligible: true;
      durationHours: typeof TRIAL_DURATION_HOURS;
      durationDays: typeof TRIAL_DURATION_DAYS;
      requiredContacts: TrialContact[];
      missingContacts: TrialContact[];
      destinations: SetupDestination[];
      delivery: SetupDelivery;
      sentTo: SetupChannel[];
      lastAttemptAt: string | null;
      /** The business's configured IANA time zone, for display only; instants are UTC. */
      timeZone: string;
    };
