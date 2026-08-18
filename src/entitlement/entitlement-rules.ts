/**
 * What a shop is entitled to (Milestone K).
 *
 * Pure and clock-injected, so every boundary — the instant before a period ends,
 * the instant after grace runs out — is testable without touching the host
 * clock or waiting three days.
 *
 * The product decision underneath: there is **one functional plan**. A shop
 * either has a live subscription or it does not. Nothing here is a feature tier,
 * and no business service asks about features — the only thing that changes when
 * a subscription lapses is whether the server accepts writes.
 */

export type EntitlementState = 'active' | 'grace' | 'expired' | 'complimentary';

/** Exactly 72 hours. Derived from the period, never stored beside it. */
export const GRACE_HOURS = 72;
export const GRACE_MS = GRACE_HOURS * 60 * 60 * 1000;

/** Included staff seats per subscribed branch. Pooled across the company. */
export const SEATS_PER_BRANCH = 2;

export interface SubscriptionRecord {
  subscribedBranchCount: number;
  additionalSeats: number;
  /** Null means never paid — a company that exists but has no subscription. */
  currentPeriodEnd: Date | null;
  isComplimentary: boolean;
  complimentaryUntil: Date | null;
}

export interface SeatUsage {
  /** Active users holding a seat-consuming (non-Owner) role. */
  seatsUsed: number;
  activeBranchCount: number;
}

/**
 * The state, from the server's clock.
 *
 * Complimentary is checked first and independently: a platform grant is a
 * decision about this shop that outranks whatever the paid period says, and
 * a grant that has run out falls back to the paid period rather than to
 * `expired`, because the two are separate facts.
 */
export function stateOf(sub: SubscriptionRecord, now: Date): EntitlementState {
  if (sub.isComplimentary && sub.complimentaryUntil && sub.complimentaryUntil.getTime() > now.getTime()) {
    return 'complimentary';
  }

  const end = sub.currentPeriodEnd?.getTime() ?? null;
  // Never subscribed and not granted anything. Reads still work; writes do not.
  if (end === null) return 'expired';

  if (now.getTime() < end) return 'active';
  if (now.getTime() < end + GRACE_MS) return 'grace';
  return 'expired';
}

/**
 * Whether business writes are accepted.
 *
 * Grace deliberately writes: a shop three hours past renewal is still open, and
 * refusing its sales would cost it real money over an administrative boundary.
 * The warning is loud; the till keeps working.
 */
export function canWrite(state: EntitlementState): boolean {
  return state !== 'expired';
}

/**
 * Reading is never blocked.
 *
 * A shop locked out of yesterday's sales reaches for the notebook immediately,
 * and would be right to. Expiry stops new business truth being written; it never
 * hides or deletes what the shop already owns.
 */
export function canRead(): boolean {
  return true;
}

export function graceEndsAt(sub: SubscriptionRecord): Date | null {
  return sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd.getTime() + GRACE_MS) : null;
}

/** Whole days remaining, floored. Negative once the period has passed. */
export function daysRemaining(sub: SubscriptionRecord, now: Date): number | null {
  if (!sub.currentPeriodEnd) return null;
  return Math.floor((sub.currentPeriodEnd.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
}

/** Hours left in grace, floored at zero. Used for the urgent wording. */
export function graceHoursRemaining(sub: SubscriptionRecord, now: Date): number {
  const ends = graceEndsAt(sub);
  if (!ends) return 0;
  return Math.max(0, Math.ceil((ends.getTime() - now.getTime()) / (60 * 60 * 1000)));
}

export interface SeatMath {
  includedSeats: number;
  additionalSeats: number;
  seatLimit: number;
  seatsUsed: number;
  overLimit: boolean;
  seatsAvailable: number;
}

/**
 * Seat arithmetic.
 *
 * Included seats come from the number of SUBSCRIBED branches and are pooled
 * freely across the company — a shop that hires its second person at the quieter
 * branch has not changed what it owes. The Owner is excluded entirely: charging
 * for the account that pays the bill would be absurd.
 */
export function seatMath(sub: SubscriptionRecord, usage: SeatUsage): SeatMath {
  const includedSeats = Math.max(0, sub.subscribedBranchCount) * SEATS_PER_BRANCH;
  const seatLimit = includedSeats + Math.max(0, sub.additionalSeats);
  const seatsUsed = Math.max(0, usage.seatsUsed);
  return {
    includedSeats,
    additionalSeats: Math.max(0, sub.additionalSeats),
    seatLimit,
    seatsUsed,
    overLimit: seatsUsed > seatLimit,
    seatsAvailable: Math.max(0, seatLimit - seatsUsed),
  };
}

/**
 * Whether one more seat-consuming person may be activated.
 *
 * Note what this does NOT do: nothing here deactivates anybody. A company that
 * drops a branch and lands over its limit keeps every employee it has, and is
 * simply blocked from adding more until the Owner rearranges. An app that fires
 * somebody to balance an invoice is not a tool anybody should trust.
 */
export function mayConsumeSeat(math: SeatMath): boolean {
  return math.seatsUsed < math.seatLimit;
}

/** The stable code the client keys on. It never parses English. */
export const ENTITLEMENT_WRITE_BLOCKED = 'ENTITLEMENT_WRITE_BLOCKED';
export const SEAT_LIMIT_REACHED = 'SEAT_LIMIT_REACHED';

export interface Entitlement {
  state: EntitlementState;
  periodEnd: string | null;
  graceEnd: string | null;
  daysRemaining: number | null;
  graceHoursRemaining: number;
  subscribedBranchCount: number;
  activeBranchCount: number;
  includedSeats: number;
  additionalSeats: number;
  seatLimit: number;
  seatsUsed: number;
  overLimit: boolean;
  canRead: boolean;
  canWrite: boolean;
  isComplimentary: boolean;
  /** When the server computed this, so a cached copy can be shown as stale. */
  calculatedAt: string;
}

/**
 * The whole answer, calculated once on the server.
 *
 * The client renders this and derives none of it — not the state, not the
 * remaining grace, not seat availability, not whether writes are allowed. A
 * client that decides its own entitlement is a client that can be made to
 * decide wrongly.
 */
export function buildEntitlement(
  sub: SubscriptionRecord,
  usage: SeatUsage,
  now: Date,
): Entitlement {
  const state = stateOf(sub, now);
  const seats = seatMath(sub, usage);
  return {
    state,
    periodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
    graceEnd: graceEndsAt(sub)?.toISOString() ?? null,
    daysRemaining: daysRemaining(sub, now),
    graceHoursRemaining: state === 'grace' ? graceHoursRemaining(sub, now) : 0,
    subscribedBranchCount: sub.subscribedBranchCount,
    activeBranchCount: usage.activeBranchCount,
    includedSeats: seats.includedSeats,
    additionalSeats: seats.additionalSeats,
    seatLimit: seats.seatLimit,
    seatsUsed: seats.seatsUsed,
    overLimit: seats.overLimit,
    canRead: canRead(),
    canWrite: canWrite(state),
    isComplimentary: state === 'complimentary',
    calculatedAt: now.toISOString(),
  };
}
