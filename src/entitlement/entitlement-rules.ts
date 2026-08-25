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

/**
 * The lifecycle position a platform administrator has PUT this subscription in.
 *
 * Distinct from {@link EntitlementState}, which is mostly derived from dates.
 * These are decisions somebody made, and no arithmetic can reproduce them: a
 * suspension is not a date passing, and a business that has never been
 * activated is not the same thing as one whose period ran out.
 *
 * `activated` means "the dates decide" — which is exactly how every
 * subscription behaved before this existed, so every pre-existing row carries
 * it and nothing about their behaviour changes.
 */
export type SubscriptionStatus = 'pending_activation' | 'activated' | 'suspended' | 'cancelled';

export type EntitlementState =
  | 'pending'
  | 'active'
  | 'grace'
  | 'expired'
  | 'complimentary'
  | 'suspended'
  | 'cancelled';

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
  /**
   * Optional so that callers written before the lifecycle existed keep
   * compiling and keep behaving identically — absent reads as `activated`.
   */
  status?: SubscriptionStatus;
}

export interface SeatUsage {
  /** Active users holding a seat-consuming (non-Owner) role. */
  seatsUsed: number;
  activeBranchCount: number;
}

/**
 * The state, from the server's clock.
 *
 * Order of precedence: an administrator's explicit decision, then a
 * complimentary grant, then the paid period.
 *
 * Complimentary is checked before the dates and independently: a platform grant
 * is a decision about this shop that outranks whatever the paid period says,
 * and a grant that has run out falls back to the paid period rather than to
 * `expired`, because the two are separate facts.
 */
export function stateOf(sub: SubscriptionRecord, now: Date): EntitlementState {
  /*
   * A deliberate decision outranks the calendar.
   *
   * Checked before everything, including a complimentary grant: suspending a
   * business that also holds a grant must actually suspend it, or suspension
   * would be unreliable in exactly the case somebody reaches for it.
   *
   * `pending_activation` is checked here rather than derived, because the
   * alternative is telling a shop that registered five minutes ago that its
   * subscription has **expired** — which is both confusing and untrue.
   */
  const status = sub.status ?? 'activated';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'suspended') return 'suspended';
  if (status === 'pending_activation') return 'pending';

  /*
   * A value that is none of the four.
   *
   * Not hypothetical: this MySQL server runs with an EMPTY `sql_mode`, so a
   * bad ENUM written outside Prisma is silently coerced to `''` rather than
   * refused. Falling through to the date logic would make a corrupted row
   * behave as `activated` — the most permissive state there is, reached by
   * accident.
   *
   * `expired` instead: writes are refused, and the shop can still read
   * everything it owns. Not silently permissive, and nobody is locked out of
   * their own records while somebody works out what happened.
   */
  if (status !== 'activated') return 'expired';

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
  return state === 'active' || state === 'grace' || state === 'complimentary';
}

/**
 * Whether the operational app may be read at all.
 *
 * **Expiry never hides anything, and that rule is unchanged.** A shop locked
 * out of yesterday's sales reaches for the notebook immediately, and would be
 * right to. Expiry stops new business truth being written; it never takes away
 * what the shop already owns.
 *
 * The two new states are genuinely different, and the difference is worth
 * stating because it looks like an inconsistency until you say it out loud:
 *
 *  - **`pending`** — a business that has never been activated. There is no
 *    operational history to withhold; the shop has never sold anything. Opening
 *    the till to it would be handing out the product before activation, which
 *    is the whole point of there being no free trial.
 *  - **`suspended`** / **`cancelled`** — somebody deliberately did this, with a
 *    recorded reason. Expiry is administrative drift, and treating a decision
 *    the same as drift would make suspension useless in exactly the case
 *    anybody reaches for it.
 *
 * In every one of those states the Owner keeps the customer portal, so nobody
 * is ever locked out of finding out *why* — see `docs/37`.
 */
export function canRead(state: EntitlementState = 'active'): boolean {
  return state !== 'pending' && state !== 'suspended' && state !== 'cancelled';
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
  /** The lifecycle position an administrator put this in. */
  status: SubscriptionStatus;
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
    canRead: canRead(state),
    canWrite: canWrite(state),
    isComplimentary: state === 'complimentary',
    status: sub.status ?? 'activated',
    calculatedAt: now.toISOString(),
  };
}
