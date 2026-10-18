import type { EntitlementState } from '../../entitlement/entitlement-rules';
import type { InstructionsHistoryEntry, InstructionsStatus } from '../../notices/notice.service';
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
 * The portal instructions — their pure rules (0095, 0099; docs/76, docs/101 §5; the owner's brief of 2026-10-18).
 *
 * Once the Owner's WhatsApp number is verified, the server sends ONE message: the business is eligible for a 7-day
 * free trial that has not started, and the portal's address — https://dukan.tsxmr.com/subscription, the same for
 * everyone, with no token in it — where the Owner signs in with the same account and starts it. WhatsApp first; email
 * only for a recorded reason (`notices/notice-rules.ts`). Again only when the Owner, signed in on the portal, asks
 * (throttled, audited): the mobile app shows where things stand and offers nothing to act on.
 *
 * Delivery is never a condition for claiming. These rules decide what is shown about it and when the portal may ask
 * again; they never decide whether a trial may start.
 */

/** How many requests the portal lists, newest first. */
export const SETUP_HISTORY_SIZE = 10;

/**
 * How long the portal's resend waits for its message to be handed to a provider before it answers (C14): past it the
 * delivery carries on and the status says `sending` — a slow provider never holds the request.
 */
export const SETUP_DELIVERY_WAIT_MS = 3_000;

/** A verified contact as its own Owner is shown it — masked, never the value. */
export interface SetupDestination {
  channel: 'whatsapp' | 'email';
  masked: string;
}

/** The Owner's verified contacts only, WhatsApp first — the order they are tried in: a contact set but unverified is no destination. */
export function verifiedDestinations(owner: OwnerContacts): SetupDestination[] {
  const out: SetupDestination[] = [];
  if (owner.phone && owner.phoneVerifiedAt) out.push({ channel: 'whatsapp', masked: maskForOwner('phone', owner.phone) });
  if (owner.email && owner.emailVerifiedAt) out.push({ channel: 'email', masked: maskForOwner('email', owner.email) });
  return out;
}

/**
 * When the portal may ask again, or null when it may now. Every request the business has counts, whatever made it —
 * the automatic one uses up a place like any other:
 *
 *  - a minute after the newest request;
 *  - fewer than 3 requests in the last 15 minutes;
 *  - fewer than 10 in the last 24 hours.
 *
 * Each instant is exact: at the one returned, every rule allows it. The requests are rows written under the
 * subscription lock, so two requests at once cannot both pass.
 */
export function resendAvailableAt(requests: readonly Date[], now: Date): Date | null {
  const times = requests.map((at) => at.getTime()).sort((a, b) => b - a);
  const candidates: number[] = [];
  if (times.length > 0) candidates.push(times[0] + RESEND_MIN_INTERVAL_MS);
  for (const [windowMs, max] of [
    [RESEND_WINDOW_MS, RESEND_WINDOW_MAX],
    [RESEND_DAY_MS, RESEND_DAY_MAX],
  ] as const) {
    const within = times.filter((t) => t > now.getTime() - windowMs);
    // The window allows another once its max-th newest request has left it.
    if (within.length >= max) candidates.push(within[max - 1] + windowMs);
  }
  const at = Math.max(...candidates, Number.NEGATIVE_INFINITY);
  return at > now.getTime() ? new Date(at) : null;
}

/**
 * Why the portal may not ask again now (C4), the first that applies:
 *  - `contact_unverified` — a required contact is not verified;
 *  - `unavailable` — neither WhatsApp nor, for a recorded reason, email can carry the instructions now: there is
 *    nothing to count down to, and the button says they cannot be sent right now;
 *  - `throttle` — only the throttle stands in the way, until `resendAvailableAt`.
 */
export type ResendBlock = 'contact_unverified' | 'unavailable' | 'throttle';

export function resendBlockOf(missing: readonly TrialContact[], carriable: boolean, throttledUntil: Date | null): ResendBlock | null {
  if (missing.length > 0) return 'contact_unverified';
  if (!carriable) return 'unavailable';
  return throttledUntil ? 'throttle' : null;
}

/**
 * The portal's `setup` object on the Owner's trial card, and the resend's answer: where the instructions stand, an
 * honest history, and when the Owner may ask again. Never a condition for claiming.
 */
export interface WebsiteSetup extends InstructionsStatus {
  destinations: SetupDestination[];
  /** No missing contact, a channel that can carry it now, and the throttle allows it. */
  canResendNow: boolean;
  /** Why not, when `canResendNow` is false; null exactly when it is true. */
  resendBlockedBy: ResendBlock | null;
  /** The earliest instant the throttle allows, or null when it allows now — whatever else may also stand in the way. */
  resendAvailableAt: string | null;
  history: InstructionsHistoryEntry[];
}

/**
 * What the mobile app may show the Owner (GET account/trial-setup) — display data only. No resend, no throttle, no
 * address, no link, no token, no route: nothing in the app can be acted on (the owner's brief of 2026-10-18). A
 * business that is not `trial_available` is told only that, and the card is never shown.
 */
export type AppSetupStatus =
  | { state: EntitlementState; eligible: false }
  | ({
      state: 'trial_available';
      eligible: true;
      durationHours: typeof TRIAL_DURATION_HOURS;
      durationDays: typeof TRIAL_DURATION_DAYS;
      requiredContacts: TrialContact[];
      missingContacts: TrialContact[];
      destinations: SetupDestination[];
      /** The business's configured IANA time zone, for display only; instants are UTC. */
      timeZone: string;
    } & InstructionsStatus);
