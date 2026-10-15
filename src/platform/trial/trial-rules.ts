import { createHash } from 'node:crypto';
import type { TrialEligibilityClosedReason } from '@prisma/client';
import { isValidTimezone } from '../../common/business-day';
import type { EntitlementState, SubscriptionStatus } from '../../entitlement/entitlement-rules';

/**
 * The website-only seven-day free trial — its pure rules (0095; docs/76).
 *
 * A business that registered itself may use Dukan ERP for exactly 168 hours, once, from the instant its Owner
 * confirms it on the Dukan ERP website. Everything here is a fact the server computes and every client renders:
 * no client divides hours into days, adds a duration to a date, or decides which contact is missing — a client that
 * computes its own trial is a client that can be made to compute a longer one.
 *
 * Pure and clock-injected, like the entitlement rules it feeds: the instant before the end and the end itself are
 * tested without waiting a week.
 */

/** Exactly seven consecutive 24-hour periods — never calendar days, so no time zone or clock change stretches it. */
export const TRIAL_DURATION_HOURS = 168;
export const TRIAL_DURATION_MS = TRIAL_DURATION_HOURS * 60 * 60 * 1000;
/** Sent beside the hours, so no client ever divides them. */
export const TRIAL_DURATION_DAYS = 7;
/** The terms the website shows. A claim made against any other version is refused and shown the current one. */
export const TRIAL_TERMS_VERSION = '2026-10-13';
/** How long a setup link works after it is sent. */
export const TRIAL_SETUP_LINK_TTL_HOURS = 24;

/*
 * The website resend throttle: at least a minute between sends, three in fifteen minutes, ten a day — counted from
 * every attempt the company has, whatever triggered it, so the automatic send uses up a place like any other.
 */
export const RESEND_MIN_INTERVAL_MS = 60_000;
export const RESEND_WINDOW_MS = 15 * 60_000;
export const RESEND_WINDOW_MAX = 3;
export const RESEND_DAY_MS = 24 * 3600_000;
export const RESEND_DAY_MAX = 10;

/** A contact the Owner proves: the address, or the WhatsApp number. */
export type TrialContact = 'email' | 'phone';

/** Which contacts the business gave when it registered itself (`trial_eligibilities.registration_method`). */
export type TrialRegistrationMethod = 'email' | 'phone' | 'both';

/** A claim as the rules need it. `startedAt` is `claimedAt`; `endsAt` is `startedAt` + 168 hours. */
export interface TrialClaimFacts {
  claimedAt: Date;
  startedAt: Date;
  endsAt: Date;
}

/**
 * When the eligibility was closed, and by which decision: the first one that gave access (`approved`, `granted`,
 * `paid_period`) or ended it (`refused`, `cancelled`) — fenced under the subscription lock, written once.
 */
export interface TrialClosure {
  at: Date;
  reason: TrialEligibilityClosedReason;
}

/** What the entitlement reads about the trial, on every evaluation. */
export interface TrialFacts {
  /** An eligibility row exists and is not closed. */
  eligible: boolean;
  /** The claim, when one exists. There is at most one per business, ever. */
  claim: TrialClaimFacts | null;
  /**
   * The eligibility's closure, when its reader read it (C6): what proves, once the trial has ended, that the access
   * following it was decided while it ran. Absent or null: no closure to prove anything with.
   */
  closure?: TrialClosure | null;
}

/**
 * The facts, from the two rows as stored. A closed eligibility is no eligibility: the business was approved,
 * granted, paid for, refused or closed, and can never start a trial — whether or not it already ran one.
 */
export function trialFactsOf(
  eligibility: { closedAt: Date | null; closedReason?: TrialEligibilityClosedReason | null } | null | undefined,
  claim: TrialClaimFacts | null | undefined,
): TrialFacts {
  return {
    eligible: !!eligibility && eligibility.closedAt === null,
    claim: claim ? { claimedAt: claim.claimedAt, startedAt: claim.startedAt, endsAt: claim.endsAt } : null,
    closure:
      eligibility?.closedAt && eligibility.closedReason ? { at: eligibility.closedAt, reason: eligibility.closedReason } : null,
  };
}

/** When a trial started at this instant ends: the same instant plus exactly 168 hours, as the CHECK compares it. */
export function trialEndFor(startedAt: Date): Date {
  return new Date(startedAt.getTime() + TRIAL_DURATION_MS);
}

/**
 * The end of a trial still running at `now`, or null. Paid access the Super Admin gives while it runs starts here,
 * never sooner (the owner's decision of 2026-10-13): the trial is not shortened, and nothing paid runs beside it.
 * The end is exclusive — at `endsAt` itself the trial is over.
 */
export function runningTrialEnd(claim: { endsAt: Date } | null | undefined, now: Date): Date | null {
  return claim && now.getTime() < claim.endsAt.getTime() ? claim.endsAt : null;
}

export type TrialViewStatus = 'available' | 'active' | 'expired';

/**
 * Access the platform approved during the trial, starting the moment it ends (C6; the owner's Q3): a paid period, or
 * the platform's grant. `startsAt` is the trial's own end, UTC ISO.
 */
export interface AccessAfterTrial {
  kind: 'paid' | 'granted';
  startsAt: string;
}

/** The subscription row's grant and paid period — what follows a trial is read from these. `status` absent reads as `activated`. */
export interface TrialAccessFacts {
  status?: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  isComplimentary: boolean;
  complimentaryUntil: Date | null;
}

/** The closures that are an access decision: an approval, a grant, a period paid for. */
const ACCESS_CLOSURES: ReadonlySet<TrialEligibilityClosedReason> = new Set(['approved', 'granted', 'paid_period']);

/**
 * What follows the trial at its end: the grant or the paid period the record holds past it, decided while the trial
 * ran — or null, and the business turns read-only at the end (or nothing was ever claimed).
 *
 * Read from the subscription row as `stateOf` reads it at the trial's end — a grant running past it first, then a
 * paid period running past it — for a business whose access may still run: `activated`, or `suspended` (a
 * suspension blocks and is lifted, as it blocks the trial itself; reinstated, the business finds what was arranged).
 * Cancelled, refused or still pending: nothing follows.
 *
 * Decided while the trial ran:
 *  - while it runs, everything the record holds was: a claim needs an open eligibility, and every decision that gives
 *    access closes it under the subscription lock (the lifecycle's fence) — so each one came after the claim, and
 *    started at the trial's end;
 *  - once it has ended, a later approval would look the same on the row, so the eligibility's closure is the proof:
 *    an access decision (approved, granted, paid_period) fenced before the end. Refused first and approved later, it
 *    proves nothing, and nothing is claimed.
 */
export function accessAfterTrialOf(
  trial: TrialFacts | null | undefined,
  access: TrialAccessFacts | null | undefined,
  now: Date,
): AccessAfterTrial | null {
  const claim = trial?.claim ?? null;
  if (!claim || !access) return null;
  const status = access.status ?? 'activated';
  if (status !== 'activated' && status !== 'suspended') return null;
  const end = claim.endsAt.getTime();
  if (now.getTime() >= end) {
    const closure = trial?.closure ?? null;
    if (!closure || closure.at.getTime() >= end || !ACCESS_CLOSURES.has(closure.reason)) return null;
  }
  const startsAt = claim.endsAt.toISOString();
  if (access.isComplimentary && access.complimentaryUntil && access.complimentaryUntil.getTime() > end) {
    return { kind: 'granted', startsAt };
  }
  if (access.currentPeriodEnd && access.currentPeriodEnd.getTime() > end) return { kind: 'paid', startsAt };
  return null;
}

/** The trial as every client is told it, on the entitlement. Rendered, never recomputed. */
export interface TrialView {
  status: TrialViewStatus;
  durationHours: typeof TRIAL_DURATION_HOURS;
  durationDays: typeof TRIAL_DURATION_DAYS;
  /** UTC ISO instants, exactly as stored; all three null while the trial is only available. */
  claimedAt: string | null;
  startedAt: string | null;
  endsAt: string | null;
  /** The business's configured IANA time zone (`companies.timezone`), for display only. */
  timeZone: string;
  /** What starts when the trial ends (C6) — null when nothing does (it then turns read-only), and while only available. */
  accessAfterTrial: AccessAfterTrial | null;
}

/**
 * The trial's view: a claim is `active` until its end and `expired` from it, with its instants and what follows it;
 * an unclaimed trial is `available` only while the business's state says so; anything else has no trial to show.
 *
 * A claim is told whatever the state above it says — a suspended business still has a trial clock running, and an
 * approved one still shows the trial its paid access waits for. The state says what the business may do; this
 * says what happened to its trial.
 */
export function trialViewOf(
  trial: TrialFacts | null | undefined,
  state: EntitlementState,
  now: Date,
  timeZone: string,
  access: TrialAccessFacts | null,
): TrialView | null {
  const claim = trial?.claim ?? null;
  if (claim) {
    return {
      status: now.getTime() < claim.endsAt.getTime() ? 'active' : 'expired',
      durationHours: TRIAL_DURATION_HOURS,
      durationDays: TRIAL_DURATION_DAYS,
      claimedAt: claim.claimedAt.toISOString(),
      startedAt: claim.startedAt.toISOString(),
      endsAt: claim.endsAt.toISOString(),
      timeZone,
      accessAfterTrial: accessAfterTrialOf(trial, access, now),
    };
  }
  if (state !== 'trial_available') return null;
  return {
    status: 'available',
    durationHours: TRIAL_DURATION_HOURS,
    durationDays: TRIAL_DURATION_DAYS,
    claimedAt: null,
    startedAt: null,
    endsAt: null,
    timeZone,
    accessAfterTrial: null,
  };
}

/**
 * The zone a business's trial dates are shown in: its own configured IANA zone, as stored — never assumed.
 *
 * A name `Intl` does not know falls back to UTC and `onInvalid` is told, so the caller can say so. It never falls
 * back to a zone guessed from the country: Mauritania keeps GMT today, which is exactly why such a guess would look
 * right until the day it was not.
 */
export function displayTimeZone(stored: string | null | undefined, onInvalid?: (stored: string) => void): string {
  const zone = stored?.trim() ?? '';
  if (zone && isValidTimezone(zone)) return zone;
  onInvalid?.(zone);
  return 'UTC';
}

/** The contacts the Owner must have verified before claiming: the ones given at registration — both, if both. */
export function requiredContacts(method: TrialRegistrationMethod): TrialContact[] {
  return method === 'both' ? ['email', 'phone'] : [method];
}

/** The Owner's contacts as the account holds them. A contact counts only while it is set AND verified. */
export interface OwnerContacts {
  email: string | null;
  emailVerifiedAt: Date | null;
  phone: string | null;
  phoneVerifiedAt: Date | null;
}

/** The required contacts not yet verified, in a stable order (email, then phone). Empty means ready. */
export function missingContacts(method: TrialRegistrationMethod, owner: OwnerContacts): TrialContact[] {
  return requiredContacts(method).filter((contact) =>
    contact === 'email' ? !(owner.email && owner.emailVerifiedAt) : !(owner.phone && owner.phoneVerifiedAt),
  );
}

/** Why an Owner whose business could still claim cannot claim right now. Anything else that stops a claim is no offer. */
export type TrialOfferReason = 'contact_unverified' | 'business_suspended';

/**
 * The website's offer: what a claim made now would record, shown before the Owner confirms
 * (GET platform/my-subscription/trial). The start and end are the server's — the instant asked, and exactly 168 hours
 * later — so the end a website shows is the end a claim at that moment would get; it refreshes them, never computes
 * them.
 */
export interface TrialOffer {
  available: boolean;
  /** Null when available. */
  reason: TrialOfferReason | null;
  /** The terms the website must show, and send back with the claim. */
  termsVersion: string;
  durationHours: typeof TRIAL_DURATION_HOURS;
  wouldStartAt: string;
  wouldEndAt: string;
  /** The business's configured IANA time zone, for display only. */
  timeZone: string;
  requiredContacts: TrialContact[];
  missingContacts: TrialContact[];
}

/** What the offer is decided from — the trial's rows, the business and its Owner, read together. */
export interface OfferFacts {
  /** The business's eligibility, open or closed; null when it never had one (console-created, or before 0095). */
  eligibility: { registrationMethod: TrialRegistrationMethod; closedAt: Date | null } | null;
  /** A claim exists. One trial per business, ever — whether it is running or ended. */
  claimed: boolean;
  /** The company is closed or deactivated, or its subscription cancelled. */
  closed: boolean;
  /** The state computed from the same facts. */
  state: EntitlementState;
  /** The Owner asking — the only person an offer is ever made to. */
  owner: OwnerContacts;
}

/**
 * The offer, or null when there is nothing the Owner could ever claim: already claimed, closed, refused, cancelled,
 * never eligible, or eligibility closed because access was given — no control is shown for those.
 *
 * Two things keep the offer but not its availability, in the claim's own order: a suspension (it blocks, never closes:
 * a reinstated business may still claim) and a required contact not yet verified. Nothing else is asked: not whether
 * the setup instructions were delivered, not whether a link exists or was used — an Owner whose messages were lost
 * sees the same offer as one who never had any (the owner's clarification of 2026-10-13).
 */
export function trialOfferOf(facts: OfferFacts, now: Date, timeZone: string): TrialOffer | null {
  const { eligibility } = facts;
  if (facts.claimed || facts.closed || !eligibility || eligibility.closedAt !== null) return null;
  let reason: TrialOfferReason | null = null;
  if (facts.state === 'suspended') reason = 'business_suspended';
  else if (facts.state !== 'trial_available') return null;
  const missing = missingContacts(eligibility.registrationMethod, facts.owner);
  if (!reason && missing.length > 0) reason = 'contact_unverified';
  return {
    available: reason === null,
    reason,
    termsVersion: TRIAL_TERMS_VERSION,
    durationHours: TRIAL_DURATION_HOURS,
    wouldStartAt: now.toISOString(),
    wouldEndAt: trialEndFor(now).toISOString(),
    timeZone,
    requiredContacts: requiredContacts(eligibility.registrationMethod),
    missingContacts: missing,
  };
}

/**
 * A verified contact as its own Owner is shown it: enough to recognise, never the value — `a•••@example.com`,
 * `+222••••1234`. A number too short to keep a middle hidden shows its last two digits only.
 */
export function maskForOwner(contact: TrialContact, value: string): string {
  if (contact === 'email') {
    const at = value.lastIndexOf('@');
    return at > 0 ? `${value.slice(0, 1)}•••@${value.slice(at + 1)}` : '•••';
  }
  const digits = value.replace(/\D/g, '');
  if (value.length <= 8) return digits.length > 2 ? `••••${digits.slice(-2)}` : '••••';
  return `${value.slice(0, 4)}••••${digits.slice(-4)}`;
}

/** SHA-256 hex of a setup token: the only form of it ever stored (`trial_setup_links.token_hash`). */
export function setupTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * The claim's canonical request, hashed (`trial_claims.request_hash`): the terms version shown and the link's hash
 * — never the token — in this order. The same idempotency key with the same request replays the claim; with
 * another request it is refused.
 */
export function claimRequestHash(termsVersion: string, token?: string | null): string {
  const canonical = JSON.stringify({ termsVersion, linkTokenHash: token ? setupTokenHash(token) : null });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
