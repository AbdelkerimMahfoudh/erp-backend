import {
  CLOSING_DELEGATES_MAX,
  canReopen,
  closeKindOf,
  delegationAllowed,
  freshCounts,
  previousDayNeedsReview,
  reconcileDiscrepancy,
  reopenChoices,
  standingOf,
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
    expect(reconcileDiscrepancy(null, 0)).toEqual({ kind: 'none' });
    expect(reconcileDiscrepancy(null, null)).toEqual({ kind: 'none' });
  });

  it('updates an undecided question, or closes it when no difference remains', () => {
    const pending = { status: 'pending_investigation' as const, amount: -500 };
    expect(reconcileDiscrepancy(pending, -200)).toEqual({ kind: 'update', amount: -200 });
    expect(reconcileDiscrepancy(pending, -500)).toEqual({ kind: 'none' });
    expect(reconcileDiscrepancy(pending, 0)).toEqual({ kind: 'resolve_no_difference' });
  });

  it('never rewrites a decided question — the remainder becomes a new one', () => {
    const decided = { status: 'resolved' as const, amount: -500 };
    expect(reconcileDiscrepancy(decided, -500)).toEqual({ kind: 'none' });
    expect(reconcileDiscrepancy(decided, -300)).toEqual({ kind: 'open_delta', amount: 200 });
    expect(reconcileDiscrepancy(decided, 0)).toEqual({ kind: 'open_delta', amount: 500 });
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
