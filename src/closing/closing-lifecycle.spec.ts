import {
  CLOSING_DELEGATES_MAX,
  canReopen,
  closeKindOf,
  delegationAllowed,
  freshCounts,
  previousDayNeedsReview,
  reconcileDiscrepancy,
  reopenChoices,
  openChoices,
  standingOf,
  canOpen,
  doorState,
  openingOf,
  closeVerification,
  NOT_VERIFIED_AT_CLOSE,
  verificationOf,
} from './closing-lifecycle';

const today = '2026-09-23';

describe('standingOf', () => {
  it('names the day in words, and a day behind us that is not locked needs review', () => {
    expect(standingOf(null, today)).toBe('open');
    expect(standingOf({ status: 'counting', businessDate: today }, today)).toBe('counting');
    expect(standingOf({ status: 'counted', businessDate: today }, today)).toBe('counted');
    expect(standingOf({ status: 'locked', businessDate: today }, today)).toBe('closed');
    expect(standingOf({ status: 'reopened', businessDate: today }, today)).toBe('reopened');
    expect(standingOf({ status: 'reopened', businessDate: '2026-09-22' }, today)).toBe('needs_review');
    expect(standingOf({ status: 'counting', businessDate: '2026-09-22' }, today)).toBe('needs_review');
    expect(standingOf({ status: 'locked', businessDate: '2026-09-22' }, today)).toBe('closed');
    expect(previousDayNeedsReview(null)).toBe(true);
    expect(previousDayNeedsReview({ status: 'locked', businessDate: '2026-09-22' })).toBe(false);
    expect(previousDayNeedsReview({ status: 'reopened', businessDate: '2026-09-22' })).toBe(true);
  });

  it('a past day with no closing row needs review only if something was recorded on it (docs/51 D8)', () => {
    // Real unclosed activity — a sale, a payment, a count, an opening — still needs review.
    expect(standingOf(null, today, true, '2026-09-22')).toBe('needs_review');
    // Nothing recorded at all: an honest "no activity", never an overdue closing.
    expect(standingOf(null, today, false, '2026-09-22')).toBe('inactive');
    // Today is simply open, activity or not.
    expect(standingOf(null, today, false, today)).toBe('open');
    expect(standingOf(null, today, true, today)).toBe('open');
    // A closing row is itself activity: its status decides, whatever the flag says.
    expect(standingOf({ status: 'counting', businessDate: '2026-09-22' }, today, false, '2026-09-22')).toBe('needs_review');
    expect(standingOf({ status: 'locked', businessDate: '2026-09-22' }, today, false, '2026-09-22')).toBe('closed');
    expect(previousDayNeedsReview(null, false)).toBe(false);
    expect(previousDayNeedsReview(null, true)).toBe(true);
    expect(previousDayNeedsReview({ status: 'reopened', businessDate: '2026-09-22' }, false)).toBe(true);
  });
});

describe('canReopen', () => {
  it('only a locked day, and only while it is still the current business date', () => {
    expect(canReopen({ status: 'locked', businessDate: today }, today)).toEqual({ ok: true });
    expect(canReopen({ status: 'counted', businessDate: today }, today)).toEqual({ ok: false, why: 'not_closed' });
    expect(canReopen({ status: 'reopened', businessDate: today }, today)).toEqual({ ok: false, why: 'not_closed' });
    expect(canReopen(null, today)).toEqual({ ok: false, why: 'not_closed' });
    // After 06:00 the day is behind us: final, corrected only through Milestone B.
    expect(canReopen({ status: 'locked', businessDate: '2026-09-22' }, today)).toEqual({ ok: false, why: 'past_day' });
    expect(canReopen({ status: 'locked', businessDate: '2026-09-24' }, today)).toEqual({ ok: false, why: 'future_day' });
  });

  it('a reopened day closes again as a reclose; a locked one cannot close twice', () => {
    expect(closeKindOf(null)).toBe('first');
    expect(closeKindOf({ status: 'counted' })).toBe('first');
    expect(closeKindOf({ status: 'reopened' })).toBe('reclose');
    expect(closeKindOf({ status: 'locked' })).toBe('already_locked');
  });
});

describe('freshCounts', () => {
  const t0 = new Date('2026-09-23T18:00:00Z');
  const reopen = new Date('2026-09-23T18:30:00Z');
  const t1 = new Date('2026-09-23T19:00:00Z');

  it('a count taken before the reopen is stale and does not complete the day', () => {
    const r = freshCounts(
      [
        { key: 'cash', countable: true, counted: 20000, isSkipped: false, countedAt: t0 },
        { key: 'account:a', countable: true, counted: null, isSkipped: true, countedAt: t0 },
        { key: 'account:none', countable: false, counted: null, isSkipped: false, countedAt: null },
      ],
      reopen,
    );
    expect(r).toEqual({ complete: false, stale: ['cash', 'account:a'], outstanding: [] });
  });

  it('a fresh count after the reopen completes it; a missing one is outstanding, not stale', () => {
    expect(
      freshCounts(
        [
          { key: 'cash', countable: true, counted: 22500, isSkipped: false, countedAt: t1 },
          { key: 'account:a', countable: true, counted: null, isSkipped: false, countedAt: null },
        ],
        reopen,
      ),
    ).toEqual({ complete: false, stale: [], outstanding: ['account:a'] });
    expect(
      freshCounts([{ key: 'cash', countable: true, counted: 22500, isSkipped: false, countedAt: t1 }], reopen),
    ).toEqual({ complete: true, stale: [], outstanding: [] });
  });

  it('with no reopen, any recorded count is fresh', () => {
    expect(freshCounts([{ key: 'cash', countable: true, counted: 1, isSkipped: false, countedAt: t0 }], null).complete).toBe(
      true,
    );
  });
});

describe('the door (0077)', () => {
  const ev = (...kinds: string[]) => kinds.map((kind, i) => ({ kind, at: new Date(2026, 8, 24, 7, i) }));

  it('is never opened until somebody opens it — sales and the 06:00 boundary do not count', () => {
    expect(doorState([])).toBe('never_opened');
    expect(doorState(ev('count_saved', 'day_started_early'))).toBe('never_opened');
    expect(doorState(ev('opened'))).toBe('open');
    expect(doorState(ev('opened', 'closed'))).toBe('closed');
    expect(doorState(ev('opened', 'closed', 'reopened'))).toBe('open');
    expect(doorState(ev('closed', 'auto_reopened', 'reclosed'))).toBe('closed');
  });

  it('names the latest opening, or nothing when none was recorded', () => {
    expect(openingOf(ev('count_saved', 'closed'))).toBeNull();
    expect(openingOf(ev('opened', 'closed'))?.kind).toBe('opened');
    expect(openingOf(ev('opened', 'closed', 'reopened', 'reclosed'))?.kind).toBe('reopened');
  });

  it('opens only the current business date, never a closed day, and never twice', () => {
    const day = '2026-09-24';
    expect(canOpen(null, 'never_opened', day, day)).toEqual({ ok: true });
    expect(canOpen({ status: 'counted', businessDate: day }, 'closed', day, day)).toEqual({ ok: true });
    expect(canOpen(null, 'open', day, day)).toEqual({ ok: false, why: 'already_open' });
    expect(canOpen({ status: 'reopened', businessDate: day }, 'open', day, day)).toEqual({ ok: false, why: 'already_open' });
    expect(canOpen({ status: 'locked', businessDate: day }, 'closed', day, day)).toEqual({ ok: false, why: 'day_closed' });
    expect(canOpen(null, 'never_opened', '2026-09-23', day)).toEqual({ ok: false, why: 'past_day' });
    expect(canOpen(null, 'never_opened', '2026-09-25', day)).toEqual({ ok: false, why: 'future_day' });
  });
});

describe('openChoices (docs/56)', () => {
  it('offers the early start to the Owner before 06:00, and only then — the same rule as a reopen', () => {
    expect(openChoices(true, true)).toEqual(['continue', 'start_new']);
    expect(openChoices(true, false)).toEqual(['continue']);
    expect(openChoices(false, true)).toEqual(['continue']);
    expect(openChoices(false, false)).toEqual(['continue']);
  });
});

describe('reopenChoices', () => {
  it('offers the early start only before 06:00 to somebody allowed to start a day early', () => {
    expect(reopenChoices(true, true)).toEqual(['continue', 'start_new']);
    expect(reopenChoices(true, false)).toEqual(['continue']);
    expect(reopenChoices(false, true)).toEqual(['continue']);
    expect(reopenChoices(false, false)).toEqual(['continue']);
  });
});

describe('reconcileDiscrepancy', () => {
  it('opens a new question only for a real difference', () => {
    expect(reconcileDiscrepancy(null, -500)).toEqual({ kind: 'open', amount: -500 });
    expect(reconcileDiscrepancy([], 0)).toEqual({ kind: 'none' });
  });

  it('a channel nobody checked at this close answers nothing: an earlier question stays as it was', () => {
    expect(reconcileDiscrepancy(null, null)).toEqual({ kind: 'none' });
    expect(reconcileDiscrepancy([{ status: 'pending_investigation', amount: -500 }], null)).toEqual({ kind: 'none' });
    expect(reconcileDiscrepancy([{ status: 'resolved', amount: -500 }], null)).toEqual({ kind: 'none' });
  });

  it('updates an undecided question, or closes it when no difference remains', () => {
    const pending = [{ status: 'pending_investigation' as const, amount: -500 }];
    expect(reconcileDiscrepancy(pending, -200)).toEqual({ kind: 'update', amount: -200 });
    expect(reconcileDiscrepancy(pending, -500)).toEqual({ kind: 'none' });
    expect(reconcileDiscrepancy(pending, 0)).toEqual({ kind: 'resolve_no_difference' });
  });

  it('never rewrites a decided question — the remainder becomes a new one', () => {
    const decided = [{ status: 'resolved' as const, amount: -500 }];
    expect(reconcileDiscrepancy(decided, -500)).toEqual({ kind: 'none' });
    expect(reconcileDiscrepancy(decided, -300)).toEqual({ kind: 'open', amount: 200 });
    expect(reconcileDiscrepancy(decided, 0)).toEqual({ kind: 'open', amount: 500 });
  });

  it('repeated recloses never count the same shortage twice', () => {
    // First close: −1 200, decided. Reclose: −700 → a +500 remainder opens.
    const afterFirst = [{ status: 'resolved' as const, amount: -1200 }];
    expect(reconcileDiscrepancy(afterFirst, -700)).toEqual({ kind: 'open', amount: 500 });
    // Reclose again at the same −700: the +500 question already says so — nothing new.
    const afterSecond = [...afterFirst, { status: 'pending_investigation' as const, amount: 500 }];
    expect(reconcileDiscrepancy(afterSecond, -700)).toEqual({ kind: 'none' });
    // Σ of every row equals the current difference: −1 200 + 500 = −700.
    expect(afterSecond.reduce((n, r) => n + r.amount, 0)).toBe(-700);
  });
});

describe('physical verification at a close (docs/51 D2)', () => {
  const reopenedAt = new Date('2026-09-23T15:00:00Z');
  const before = new Date('2026-09-23T14:00:00Z');
  const after = new Date('2026-09-23T16:00:00Z');

  it('only a fresh count is a verification; a skip, a close without checking and a stale count are not', () => {
    expect(verificationOf(null, null)).toBe('not_counted');
    expect(verificationOf({ counted: 1000, isSkipped: false, skipReason: null, countedAt: before }, null)).toBe('counted');
    expect(verificationOf({ counted: null, isSkipped: true, skipReason: 'Balance not readable', countedAt: before }, null)).toBe('skipped');
    expect(verificationOf({ counted: null, isSkipped: true, skipReason: NOT_VERIFIED_AT_CLOSE, countedAt: before }, null)).toBe('not_verified');
    expect(verificationOf({ counted: 1000, isSkipped: false, skipReason: null, countedAt: before }, reopenedAt)).toBe('stale');
    expect(verificationOf({ counted: 1000, isSkipped: false, skipReason: null, countedAt: after }, reopenedAt)).toBe('counted');
    expect(verificationOf({ counted: null, isSkipped: false, skipReason: null, countedAt: null }, null)).toBe('not_counted');
  });

  it('a close with any unchecked channel needs an acknowledgement; a fully counted one does not', () => {
    expect(closeVerification([
      { key: 'cash:NONE', countable: true, verification: 'counted' },
      { key: 'account:A', countable: true, verification: 'counted' },
      { key: 'account:NONE', countable: false, verification: 'not_counted' },
    ])).toEqual({ verified: ['cash:NONE', 'account:A'], unverified: [], requiresAcknowledgement: false });
    expect(closeVerification([
      { key: 'cash:NONE', countable: true, verification: 'counted' },
      { key: 'account:A', countable: true, verification: 'skipped' },
      { key: 'account:B', countable: true, verification: 'stale' },
      { key: 'account:C', countable: true, verification: 'not_counted' },
    ])).toEqual({ verified: ['cash:NONE'], unverified: ['account:A', 'account:B', 'account:C'], requiresAcknowledgement: true });
  });
});

describe('delegationAllowed', () => {
  it('the Owner plus two, never a third; re-granting an existing delegate is a no-op', () => {
    expect(CLOSING_DELEGATES_MAX).toBe(2);
    expect(delegationAllowed(0, false)).toEqual({ ok: true });
    expect(delegationAllowed(1, false)).toEqual({ ok: true });
    expect(delegationAllowed(2, false)).toEqual({ ok: false, why: 'limit' });
    expect(delegationAllowed(2, true)).toEqual({ ok: true });
  });
});
