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

/** What the day is, in words the screen shows beside its colour. */
export type DayStanding = 'open' | 'counting' | 'counted' | 'closed' | 'reopened' | 'needs_review';

export interface DayRow {
  status: ClosingStatus;
  businessDate: string;
}

export function standingOf(row: DayRow | null, currentBusinessDate: string): DayStanding {
  if (!row) return 'open';
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

/** A day with no row that is already behind us was never closed either. */
export function previousDayNeedsReview(row: DayRow | null): boolean {
  return !row || row.status !== 'locked';
}

export type ReopenRefusal = 'not_closed' | 'past_day' | 'future_day';

export function canReopen(row: DayRow | null, currentBusinessDate: string): { ok: true } | { ok: false; why: ReopenRefusal } {
  if (!row || row.status !== 'locked') return { ok: false, why: 'not_closed' };
  if (row.businessDate < currentBusinessDate) return { ok: false, why: 'past_day' };
  if (row.businessDate > currentBusinessDate) return { ok: false, why: 'future_day' };
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

export interface ExistingDiscrepancy {
  status: 'pending_investigation' | 'resolved';
  amount: number;
}

export type DiscrepancyAction =
  | { kind: 'none' }
  | { kind: 'open'; amount: number }
  | { kind: 'update'; amount: number }
  | { kind: 'resolve_no_difference' }
  | { kind: 'open_delta'; amount: number };

/**
 * What a reclose does to a channel's discrepancy. Nothing financial is ever
 * deleted: an unresolved question is updated to the new difference or closed
 * as "no difference remains"; a question somebody already decided stays as
 * decided, and any remaining delta becomes a new question.
 */
export function reconcileDiscrepancy(existing: ExistingDiscrepancy | null, difference: number | null): DiscrepancyAction {
  const diff = difference === null ? 0 : round2(difference);
  if (!existing) return diff !== 0 ? { kind: 'open', amount: diff } : { kind: 'none' };
  if (existing.status === 'pending_investigation') {
    if (diff === 0) return { kind: 'resolve_no_difference' };
    return round2(existing.amount) === diff ? { kind: 'none' } : { kind: 'update', amount: diff };
  }
  const delta = round2(diff - existing.amount);
  return delta !== 0 ? { kind: 'open_delta', amount: delta } : { kind: 'none' };
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
