/**
 * The business day's lifecycle rules, pure (docs/50 §3.2).
 *
 *   counting ──count──► counted ──close──► locked ──reopen (same business
 *   day only)──► reopened ──fresh count + close──► locked
 *
 * A locked day may be reopened only while it is still the branch's current
 * business date. Once 06:00 has passed, a day that is not locked reads
 * "Needs review" and a locked one is final: correcting it is Milestone B's
 * append-only workflow, never a reopen.
 */

export type ClosingStatus = 'counting' | 'counted' | 'locked' | 'reopened';

/**
 * What the day is, in words the screen shows beside its colour. `inactive` is a
 * day behind the boundary on which nothing at all was recorded (docs/51 D8): it
 * is not an overdue closing, and saying so would be a false alarm.
 */
export type DayStanding = 'open' | 'counting' | 'counted' | 'closed' | 'reopened' | 'needs_review' | 'inactive';

export interface DayRow {
  status: ClosingStatus;
  businessDate: string;
}

/**
 * `hadActivity` answers "was anything recorded on this date?" (a sale, a
 * payment, a count, a close, an opening, an expense, a refund, a correction —
 * see `dayActivity`). It matters only for a day with no closing row: today
 * that is simply open; a past one needs review if something happened on it and
 * is inactive if nothing did.
 */
export function standingOf(row: DayRow | null, currentBusinessDate: string, hadActivity = true, date?: string): DayStanding {
  if (!row) {
    if (date !== undefined && date < currentBusinessDate) return hadActivity ? 'needs_review' : 'inactive';
    return 'open';
  }
  const past = row.businessDate < currentBusinessDate;
  switch (row.status) {
    case 'locked':
      return 'closed';
    case 'reopened':
      return past ? 'needs_review' : 'reopened';
    case 'counted':
      return past ? 'needs_review' : 'counted';
    default:
      return past ? 'needs_review' : 'counting';
  }
}

/**
 * A day behind us needs review when it was not closed — but only if something
 * was recorded on it. A day on which nothing happened has nothing to review.
 */
export function previousDayNeedsReview(row: DayRow | null, hadActivity = true): boolean {
  return row ? row.status !== 'locked' : hadActivity;
}

export type ReopenRefusal = 'not_closed' | 'past_day' | 'future_day';

export function canReopen(row: DayRow | null, currentBusinessDate: string): { ok: true } | { ok: false; why: ReopenRefusal } {
  if (!row || row.status !== 'locked') return { ok: false, why: 'not_closed' };
  if (row.businessDate < currentBusinessDate) return { ok: false, why: 'past_day' };
  if (row.businessDate > currentBusinessDate) return { ok: false, why: 'future_day' };
  return { ok: true };
}

// ── The door ────────────────────────────────────────────────────────────

/**
 * Whether the boutique is physically open on a business date, read from the
 * day's events in time order: an explicit opening or a reopen opens it, a
 * close closes it. The 06:00 boundary is a reporting boundary and says nothing
 * here — a day nobody opened stays "never opened", however many sales it has.
 */
export type DoorState = 'never_opened' | 'open' | 'closed';

export const DOOR_OPENS: readonly string[] = ['opened', 'reopened', 'auto_reopened'];
export const DOOR_CLOSES: readonly string[] = ['closed', 'reclosed'];

export function doorState(events: readonly { kind: string }[]): DoorState {
  let state: DoorState = 'never_opened';
  for (const e of events) {
    if (DOOR_OPENS.includes(e.kind)) state = 'open';
    else if (DOOR_CLOSES.includes(e.kind)) state = 'closed';
  }
  return state;
}

/** The day's latest opening — an explicit open or a reopen — or null when none was recorded. */
export function openingOf<T extends { kind: string }>(events: readonly T[]): T | null {
  let last: T | null = null;
  for (const e of events) if (DOOR_OPENS.includes(e.kind)) last = e;
  return last;
}

export type OpenRefusal = 'past_day' | 'future_day' | 'day_closed' | 'already_open';

/**
 * Whether "Open the boutique" applies: only the current business date; never a
 * closed day (that is a reopen, with the closing authority); and not twice.
 */
export function canOpen(
  row: DayRow | null,
  door: DoorState,
  businessDate: string,
  currentBusinessDate: string,
): { ok: true } | { ok: false; why: OpenRefusal } {
  if (businessDate < currentBusinessDate) return { ok: false, why: 'past_day' };
  if (businessDate > currentBusinessDate) return { ok: false, why: 'future_day' };
  if (row?.status === 'locked') return { ok: false, why: 'day_closed' };
  if (door === 'open') return { ok: false, why: 'already_open' };
  return { ok: true };
}

export type CloseKind = 'first' | 'reclose';

export function closeKindOf(row: { status: ClosingStatus } | null): CloseKind | 'already_locked' {
  if (!row) return 'first';
  if (row.status === 'locked') return 'already_locked';
  return row.status === 'reopened' ? 'reclose' : 'first';
}

export interface CountableChannel {
  key: string;
  countable: boolean;
  counted: number | null;
  isSkipped: boolean;
  countedAt: Date | null;
}

/**
 * Whether every countable channel has a count (or a recorded skip) that was
 * taken AFTER the reopen. A count saved before the reopen describes a drawer
 * that has since changed, so it is stale and does not complete the day.
 */
export function freshCounts(
  channels: CountableChannel[],
  reopenedAt: Date | null,
): { complete: boolean; stale: string[]; outstanding: string[] } {
  const stale: string[] = [];
  const outstanding: string[] = [];
  for (const c of channels) {
    if (!c.countable) continue;
    const recorded = c.counted !== null || c.isSkipped;
    if (!recorded) {
      outstanding.push(c.key);
      continue;
    }
    if (reopenedAt && (!c.countedAt || c.countedAt.getTime() < reopenedAt.getTime())) stale.push(c.key);
  }
  return { complete: stale.length === 0 && outstanding.length === 0, stale, outstanding };
}

export type ReopenMode = 'continue' | 'start_new';

/**
 * The choices a reopen offers. "Start the next day now" exists only after
 * local midnight and before 06:00, and only for somebody holding
 * `closing.start_early` — the Owner.
 */
export function reopenChoices(beforeDayStart: boolean, mayStartEarly: boolean): ReopenMode[] {
  return beforeDayStart && mayStartEarly ? ['continue', 'start_new'] : ['continue'];
}

/**
 * The choices "Open the boutique" offers — the same two, under the same rule:
 * before 06:00 the business date is still yesterday's, so the Owner is asked
 * whether to continue it or start today early BEFORE the opening is recorded.
 * Anybody else opens the previous business day, and is told so.
 */
export function openChoices(beforeDayStart: boolean, mayStartEarly: boolean): ReopenMode[] {
  return reopenChoices(beforeDayStart, mayStartEarly);
}

export interface ExistingDiscrepancy {
  status: 'pending_investigation' | 'resolved';
  amount: number;
}

export type DiscrepancyAction =
  | { kind: 'none' }
  | { kind: 'open'; amount: number }
  | { kind: 'update'; amount: number }
  | { kind: 'resolve_no_difference' };

/**
 * What a close does to a channel's discrepancies, given EVERY discrepancy row the
 * channel already has and the difference it shows now.
 *
 * - `difference === null` means nobody claimed a figure at this close (the channel
 *   was not verified, or was skipped): **nothing happens**. An earlier question
 *   stays exactly as it was — it came from a real count, and a close that did not
 *   look at the drawer cannot answer it (docs/51 D2).
 * - Otherwise the difference still unexplained is `difference − Σ decided`. An
 *   undecided question follows it (or closes as "no difference remains"); if there
 *   is none, a new one opens for any remainder.
 *
 * Comparing against the sum of decided rows, not only the newest row, is what
 * stops repeated recloses from counting the same shortage twice (docs/51 §4).
 * Nothing financial is ever deleted; a decided question is never rewritten.
 */
export function reconcileDiscrepancy(existing: ExistingDiscrepancy[] | null, difference: number | null): DiscrepancyAction {
  if (difference === null) return { kind: 'none' };
  const rows = existing ?? [];
  const decided = round2(rows.filter((r) => r.status === 'resolved').reduce((n, r) => n + r.amount, 0));
  const pending = rows.find((r) => r.status === 'pending_investigation') ?? null;
  const remainder = round2(round2(difference) - decided);
  if (pending) {
    if (remainder === 0) return { kind: 'resolve_no_difference' };
    return round2(pending.amount) === remainder ? { kind: 'none' } : { kind: 'update', amount: remainder };
  }
  return remainder !== 0 ? { kind: 'open', amount: remainder } : { kind: 'none' };
}

// ── Physical verification at a close (docs/51 D2) ────────────────────────────

/**
 * The machine key a channel carries when the person closing did not check it.
 * Stored in `skip_reason` (like `CASH` in `label_snapshot`), so it is never
 * mistaken for a person's own skip reason and never displayed as copy.
 */
export const NOT_VERIFIED_AT_CLOSE = 'NOT_VERIFIED_AT_CLOSE';

/**
 * How one channel stands against its expected figure:
 *
 * - `counted` — a person counted it, after any reopen;
 * - `skipped` — a person recorded that it could not be counted, with their reason;
 * - `not_verified` — closed without anybody checking it (acknowledged at the close);
 * - `stale` — counted before the day was reopened, so it describes a drawer that has
 *   since changed and proves nothing about it now;
 * - `not_counted` — nothing recorded yet.
 *
 * Only `counted` is a physical verification. The others are never shown as matched.
 */
export type Verification = 'counted' | 'skipped' | 'not_verified' | 'stale' | 'not_counted';

export function verificationOf(
  row: { counted: number | null; isSkipped: boolean; skipReason: string | null; countedAt: Date | null } | null,
  reopenedAt: Date | null,
): Verification {
  if (!row) return 'not_counted';
  if (reopenedAt && row.countedAt && row.countedAt.getTime() < reopenedAt.getTime()) return 'stale';
  if (reopenedAt && !row.countedAt && (row.counted !== null || row.isSkipped)) return 'stale';
  if (row.isSkipped) return row.skipReason === NOT_VERIFIED_AT_CLOSE ? 'not_verified' : 'skipped';
  return row.counted === null ? 'not_counted' : 'counted';
}

/**
 * What a close needs from the person confirming it. Every countable channel that
 * is not freshly counted is closed as NOT VERIFIED — which requires an explicit
 * acknowledgement and a reason. A day on which every channel was counted needs
 * neither: the counts are the verification.
 */
export function closeVerification(channels: { key: string; countable: boolean; verification: Verification }[]): {
  verified: string[];
  unverified: string[];
  requiresAcknowledgement: boolean;
} {
  const verified: string[] = [];
  const unverified: string[] = [];
  for (const c of channels) {
    if (!c.countable) continue;
    (c.verification === 'counted' ? verified : unverified).push(c.key);
  }
  return { verified, unverified, requiresAcknowledgement: unverified.length > 0 };
}

/** The Owner plus at most this many named delegates per branch (docs/50 §3.3). */
export const CLOSING_DELEGATES_MAX = 2;

export function delegationAllowed(
  currentDelegates: number,
  alreadyGranted: boolean,
): { ok: true } | { ok: false; why: 'limit' } {
  if (alreadyGranted) return { ok: true };
  return currentDelegates >= CLOSING_DELEGATES_MAX ? { ok: false, why: 'limit' } : { ok: true };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
