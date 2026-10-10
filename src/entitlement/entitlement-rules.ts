import type { Activity } from './activity';

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
export type SubscriptionStatus =
  | 'pending_activation'
  | 'activated'
  | 'suspended'
  | 'cancelled'
  /** Refused before it ever ran (0075). Not an ended subscription: nothing was granted. */
  | 'rejected';

export type EntitlementState =
  | 'pending'
  | 'active'
  | 'grace'
  | 'expired'
  | 'complimentary'
  | 'suspended'
  | 'cancelled'
  | 'rejected';

/** Exactly 72 hours. Derived from the period, never stored beside it. */
export const GRACE_HOURS = 72;
export const GRACE_MS = GRACE_HOURS * 60 * 60 * 1000;

/**
 * Included staff seats per store (docs/21, 2026-10-05). One, and it belongs to
 * the store: a person working at two stores holds a seat at each, and within
 * one store they are counted once. This replaced two pooled seats per branch.
 */
export const INCLUDED_SEATS_PER_STORE = 1;

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

/** One store's seats: who works there, and what the shop holds for it. */
export interface BranchSeatUsage {
  branchId: string;
  name: string;
  /** What the branch is subscribed to (D154). Absent reads as `electronics` — what every branch before 0088 is. */
  activity?: Activity;
  /** A downgrade waiting for the next renewal, when one is scheduled. */
  activityNext?: Activity | null;
  /** Distinct active non-Owner people assigned to this store. */
  seatsUsed: number;
  /** Seats bought and confirmed for this store. */
  paidSeats: number;
  /** Seats held without a charge — the transition, or a platform grant. */
  grantedSeats: number;
}

export interface SeatUsage {
  /**
   * Active non-Owner assignments, counted per store. Without `branches` it is
   * read as a company-wide figure against the company-wide pool, which is how
   * callers written before seats belonged to stores still read it.
   */
  seatsUsed: number;
  activeBranchCount: number;
  /** Per-store detail. Present whenever the server computed it. */
  branches?: BranchSeatUsage[];
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
  // Refused. Its own state, so a shop told "no" is not told "your
  // subscription ended" — it never had one.
  if (status === 'rejected') return 'rejected';

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
  return state !== 'pending' && state !== 'suspended' && state !== 'cancelled' && state !== 'rejected';
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

export interface BranchSeatMath extends BranchSeatUsage {
  /**
   * Said explicitly on every line (D156): the app learns from this which money
   * routes the branch may write — a flag, never a price. An older server that
   * omits it reads as `electronics`, which keeps today's app exactly as it is.
   */
  activity: Activity;
  activityNext: Activity | null;
  includedSeats: number;
  /** Included + paid + granted: how many people may work at this store. */
  seatLimit: number;
  seatsAvailable: number;
  /** More people than seats. Only staff who predate the rule can be here; nobody is deactivated for it. */
  overLimit: boolean;
}

export interface SeatMath {
  includedSeats: number;
  additionalSeats: number;
  seatLimit: number;
  seatsUsed: number;
  overLimit: boolean;
  seatsAvailable: number;
  /** One line per store. Empty when the usage carried no per-store detail. */
  branches: BranchSeatMath[];
  /**
   * Seats bought under the pooled rule and not yet converted to a store by the
   * transition. Usable at any store until then, so nobody who paid loses a seat.
   */
  pooledSeats: number;
}

/**
 * Seat arithmetic (docs/21, 2026-10-05).
 *
 * Each store includes ONE seat; the Owner never counts. A shop holds further
 * seats store by store — bought, or granted — and a person is seated at every
 * store they work in. Nothing pools across stores any more, with one honest
 * exception: seats a shop bought under the earlier pooled rule stay usable
 * anywhere until the transition assigns them to a store.
 */
export function seatMath(sub: SubscriptionRecord, usage: SeatUsage): SeatMath {
  const pooledSeats = Math.max(0, sub.additionalSeats);
  const used = (n: number) => Math.max(0, Math.trunc(n));

  if (usage.branches === undefined) {
    // No per-store detail: the company-wide reading, one included seat per store.
    const includedSeats = Math.max(0, sub.subscribedBranchCount) * INCLUDED_SEATS_PER_STORE;
    const seatLimit = includedSeats + pooledSeats;
    const seatsUsed = used(usage.seatsUsed);
    return {
      includedSeats,
      additionalSeats: pooledSeats,
      seatLimit,
      seatsUsed,
      overLimit: seatsUsed > seatLimit,
      seatsAvailable: Math.max(0, seatLimit - seatsUsed),
      branches: [],
      pooledSeats,
    };
  }

  const branches: BranchSeatMath[] = usage.branches.map((b) => {
    const seatsUsed = used(b.seatsUsed);
    const paidSeats = used(b.paidSeats);
    const grantedSeats = used(b.grantedSeats);
    const seatLimit = INCLUDED_SEATS_PER_STORE + paidSeats + grantedSeats;
    return {
      branchId: b.branchId,
      name: b.name,
      activity: b.activity ?? 'electronics',
      activityNext: b.activityNext ?? null,
      seatsUsed,
      paidSeats,
      grantedSeats,
      includedSeats: INCLUDED_SEATS_PER_STORE,
      seatLimit,
      seatsAvailable: Math.max(0, seatLimit - seatsUsed),
      overLimit: seatsUsed > seatLimit,
    };
  });

  const includedSeats = branches.length * INCLUDED_SEATS_PER_STORE;
  const heldSeats = branches.reduce((n, b) => n + b.paidSeats + b.grantedSeats, 0);
  const additionalSeats = heldSeats + pooledSeats;
  const seatLimit = includedSeats + additionalSeats;
  const seatsUsed = branches.reduce((n, b) => n + b.seatsUsed, 0);
  // People seated beyond their own store's seats, store by store. The pool may
  // still cover them; past that the company is over its limit.
  const overflow = branches.reduce((n, b) => n + Math.max(0, b.seatsUsed - b.seatLimit), 0);

  return {
    includedSeats,
    additionalSeats,
    seatLimit,
    seatsUsed,
    overLimit: overflow > pooledSeats,
    seatsAvailable: Math.max(0, seatLimit - seatsUsed),
    branches,
    pooledSeats,
  };
}

/**
 * Whether one more seat-consuming person may be activated, company-wide.
 *
 * Kept for the callers that have no store in hand. When the maths carries
 * per-store detail, prefer {@link mayConsumeSeatIn}: a free seat at the quiet
 * store does not seat somebody at the busy one.
 *
 * Note what this does NOT do: nothing here deactivates anybody. A company that
 * drops a store and lands over its limit keeps every employee it has, and is
 * simply blocked from adding more until the Owner rearranges. An app that fires
 * somebody to balance an invoice is not a tool anybody should trust.
 */
export function mayConsumeSeat(math: SeatMath): boolean {
  return math.seatsUsed < math.seatLimit;
}

/**
 * Whether one more person may be seated at THIS store.
 *
 * The store's own seats first — included, paid, granted — then the unconverted
 * pool bought under the earlier rule. An unknown store seats nobody: failing
 * closed is the right way round for a billing boundary.
 */
export function mayConsumeSeatIn(math: SeatMath, branchId: string): boolean {
  const line = math.branches.find((b) => b.branchId === branchId);
  if (!line) return false;
  if (line.seatsUsed < line.seatLimit) return true;
  const overflow = math.branches.reduce((n, b) => n + Math.max(0, b.seatsUsed - b.seatLimit), 0);
  return overflow < math.pooledSeats;
}

/** The stable code the client keys on. It never parses English. */
export const ENTITLEMENT_WRITE_BLOCKED = 'ENTITLEMENT_WRITE_BLOCKED';
/// Registered, never activated. The client shows an activation-pending screen.
export const ENTITLEMENT_PENDING = 'ENTITLEMENT_PENDING';
/// Deliberately stopped. Distinct from pending so the client can say which.
export const ENTITLEMENT_SUSPENDED = 'ENTITLEMENT_SUSPENDED';
/// Refused at registration. Its own code, so the client never calls it "ended".
export const ENTITLEMENT_REJECTED = 'ENTITLEMENT_REJECTED';
export const SEAT_LIMIT_REACHED = 'SEAT_LIMIT_REACHED';

/**
 * A platform grant, as the shop is told about it (docs/73 §11.5, 2026-10-10).
 *
 * The grant has its own end, and it is never the paid period's: the website
 * once said "granted until" beside the latest billing period's START, because
 * the grant's own date never reached it.
 *
 *  - `active` — a grant runs to `until`;
 *  - `ended` — a grant ran out on `until` and nothing paid runs past it: access
 *    follows the paid period (often `expired`);
 *  - `superseded` — a grant ran out on `until` and a paid period now runs to
 *    `paidUntil`: the paid month took over;
 *  - `indefinite` — the grant flag with no end recorded. The database refuses
 *    that shape today (`ck_subscriptions_complimentary`); a row that ever holds
 *    it is shown as a grant with no date, never given someone else's;
 *  - `none` — no grant.
 */
export type ComplimentaryStatus = 'none' | 'active' | 'ended' | 'superseded' | 'indefinite';

export interface ComplimentaryView {
  status: ComplimentaryStatus;
  /** The grant's own end. Null when there is no grant, or no end is recorded. */
  until: string | null;
  /** `superseded` only: the end of the paid period that took over. */
  paidUntil: string | null;
}

export function complimentaryOf(sub: SubscriptionRecord, now: Date): ComplimentaryView {
  if (!sub.isComplimentary) return { status: 'none', until: null, paidUntil: null };
  const until = sub.complimentaryUntil;
  if (!until) return { status: 'indefinite', until: null, paidUntil: null };
  if (until.getTime() > now.getTime()) return { status: 'active', until: until.toISOString(), paidUntil: null };
  const paid = sub.currentPeriodEnd;
  if (paid && paid.getTime() > until.getTime() && paid.getTime() > now.getTime()) {
    return { status: 'superseded', until: until.toISOString(), paidUntil: paid.toISOString() };
  }
  return { status: 'ended', until: until.toISOString(), paidUntil: null };
}

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
  /** Seats store by store (docs/21, 2026-10-05). Empty when not computed. */
  seatsByStore: BranchSeatMath[];
  canRead: boolean;
  canWrite: boolean;
  isComplimentary: boolean;
  /** The platform's grant with its own dates — what the shop reads instead of a paid period's. */
  complimentary: ComplimentaryView;
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
    seatsByStore: seats.branches,
    canRead: canRead(state),
    canWrite: canWrite(state),
    isComplimentary: state === 'complimentary',
    complimentary: complimentaryOf(sub, now),
    status: sub.status ?? 'activated',
    calculatedAt: now.toISOString(),
  };
}
