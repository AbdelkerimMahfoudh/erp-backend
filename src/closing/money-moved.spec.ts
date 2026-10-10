import { createHash } from 'node:crypto';
import { buildChannels, type MovementRow } from './channels';
import {
  assembleReport,
  figureMoved,
  floatSinceCount,
  movedCounts,
  reportVersion,
  type ChannelCountState,
  type ClosingReport,
  type ReportFloatInput,
  type ReportInputs,
} from './closing-report';

/**
 * Money moved after a count (D159, docs/73 §11.2), recomputed by hand.
 *
 * A combined branch (electronics and the agent counter, one drawer), business date 2026-10-10. The drawer opened with
 * 10 000; by 18:00 a sale had taken 5 000 in cash, the counter had received 20 000 for credit sent and given 15 000
 * for credit received: expected 20 000, and that is what the drawer was counted against at 18:00. Bankily recorded
 * 2 000 and was counted against it; the Bankily float was counted against the 30 200 the app tracked.
 *
 * Whatever lands after 18:00 moves a figure a count was held against — an exchange, its reversal, a rebalancing, or
 * an ordinary electronics sale paid in cash — and that count no longer describes the money. The report says so on the
 * channel or the float, and in one warning with what the agent counter recorded meanwhile; a recount clears it.
 */

const BANKILY = 'b0000000-0000-7000-8000-000000000001';
const DAY = '2026-10-10';
const COUNTED_AT = new Date(`${DAY}T18:00:00Z`);
const accounts = [{ id: BANKILY, label: 'Bankily', isActive: true, sortOrder: 1 }];
const cash = (component: MovementRow['component'], amount: number): MovementRow => ({ channel: 'cash', accountId: null, component, amount });
const bankily = (amount: number): MovementRow => ({ channel: 'account', accountId: BANKILY, component: 'salesIn', amount });

/** The day as it stood when everything was counted. */
const atCount: MovementRow[] = [cash('salesIn', 5_000), cash('agentIn', 20_000), cash('agentOut', 15_000), bankily(2_000)];
const OPENING = 10_000;

const counted = (expectedAtCount: number | undefined, countedAmount: number): ChannelCountState => ({
  verification: 'counted',
  counted: countedAmount,
  countedAt: COUNTED_AT,
  skipReason: null,
  ...(expectedAtCount === undefined ? {} : { expectedAtCount }),
});

const float = (over: Partial<ReportFloatInput> = {}): ReportFloatInput => ({
  providerId: 'p-bankily',
  label: 'Bankily float',
  expected: 30_200,
  counted: 30_200,
  explanation: null,
  isSkipped: false,
  skipReason: null,
  countedAt: COUNTED_AT.toISOString(),
  countedByName: 'Aicha',
  expectedAtCount: 30_200,
  ...over,
});

function inputs(movements: MovementRow[], over: Partial<ReportInputs> = {}): ReportInputs {
  return {
    date: DAY,
    today: DAY,
    timezone: 'UTC',
    window: { startsAt: `${DAY}T06:00:00.000Z`, endsAt: '2026-10-11T06:00:00.000Z' },
    standing: 'counted',
    sales: { count: 1, value: 5_000, itemsSold: 1, cost: 4_000, missingCostLines: 0 },
    returns: { count: 0, grossRefund: 0, adjustments: 0, netRefundDue: 0, costCredited: 0, missingCostLines: 0 },
    cancellations: { count: 0, value: 0, items: 0, cost: 0, missingCostLines: 0, ofTheseSales: 0 },
    collected: { atCheckout: 5_000, laterSameDay: 0, corrections: 0 },
    channels: buildChannels(movements, accounts, OPENING),
    splits: new Map(),
    expenses: [],
    expenseReversals: [],
    counts: new Map([
      ['cash:NONE', counted(20_000, 20_000)],
      [`account:${BANKILY}`, counted(2_000, 2_000)],
    ]),
    opening: { amount: OPENING, anchorDate: '2026-10-09', anchorVerified: true, carriedDays: 0 },
    floats: [float()],
    pending: null,
    openDiscrepancies: 0,
    previousDay: null,
    closeKind: 'first',
    ...over,
  };
}

const warning = (r: ClosingReport) => r.warnings.find((w) => w.code === 'money_moved_after_count');

describe('a count is compared with the figure now (D159)', () => {
  it('nothing moved after the counts: every count holds, no warning, nothing for the close to wait for', () => {
    const r = assembleReport(inputs(atCount));
    expect(r.expected.cash).toMatchObject({ expected: 20_000, expectedAtCount: 20_000, movedSinceCount: false, difference: 0 });
    expect(r.expected.accounts[0]).toMatchObject({ expectedMovement: 2_000, expectedAtCount: 2_000, movedSinceCount: false });
    expect(r.expected.floats[0]).toMatchObject({ expected: 30_200, expectedAtCount: 30_200, movedSinceCount: false });
    expect(warning(r)).toBeUndefined();
    expect(movedCounts(r)).toEqual({ channels: [], floats: [] });
  });

  it.each([
    // [what landed after the drawer was counted, the legs, what the agent counter recorded since, the drawer now]
    ['an agent exchange (receive 20 000 cash, its 200 commission in cash)', [cash('agentIn', 20_000), cash('agentIn', 200)], { exchanges: 1, reversals: 0, rebalancings: 0 }, 40_200],
    ['the reversal of an earlier exchange (its 20 000 cash goes back out)', [cash('agentOut', 20_000)], { exchanges: 0, reversals: 1, rebalancings: 0 }, 0],
    ['a rebalancing (5 000 cash taken to top up a float)', [cash('agentOut', 5_000)], { exchanges: 0, reversals: 0, rebalancings: 1 }, 15_000],
    ['an ordinary electronics sale paid 1 500 in cash, at a combined branch', [cash('salesIn', 1_500)], { exchanges: 0, reversals: 0, rebalancings: 0 }, 21_500],
  ])('%s makes the counted drawer stale, says so, and names what the counter recorded since', (_label, after, since, drawerNow) => {
    const r = assembleReport(inputs([...atCount, ...after], { agentSinceCount: since }));
    expect(r.expected.cash).toMatchObject({ expected: drawerNow, expectedAtCount: 20_000, movedSinceCount: true });
    // The other counts did not move: the account and the float still hold.
    expect(r.expected.accounts[0].movedSinceCount).toBe(false);
    expect(r.expected.floats[0].movedSinceCount).toBe(false);
    expect(warning(r)).toEqual({ code: 'money_moved_after_count', severity: 'warning', section: 'money', params: { count: 1, ...since } });
    expect(movedCounts(r)).toEqual({ channels: [{ key: 'cash:NONE', label: r.money.channels.find((c) => c.key === 'cash:NONE')!.label }], floats: [] });
  });

  it('a float-only move after the float was counted makes the float stale, and only the float', () => {
    const r = assembleReport(inputs(atCount, { floats: [float({ expected: 30_700 })], agentSinceCount: { exchanges: 1, reversals: 0, rebalancings: 0 } }));
    expect(r.expected.floats[0]).toMatchObject({ expected: 30_700, expectedAtCount: 30_200, counted: 30_200, difference: -500, movedSinceCount: true });
    expect(r.expected.cash.movedSinceCount).toBe(false);
    expect(warning(r)?.params).toEqual({ count: 1, exchanges: 1, reversals: 0, rebalancings: 0 });
    expect(movedCounts(r)).toEqual({ channels: [], floats: [{ providerId: 'p-bankily', label: 'Bankily float' }] });
  });

  it('an account that moved after its count is stale too, and each stale count is counted once in the warning', () => {
    const r = assembleReport(inputs([...atCount, bankily(700), cash('salesIn', 100)], { floats: [float({ expected: 30_000 })] }));
    expect(r.expected.accounts[0]).toMatchObject({ expectedMovement: 2_700, expectedAtCount: 2_000, movedSinceCount: true });
    expect(warning(r)?.params).toEqual({ count: 3, exchanges: 0, reversals: 0, rebalancings: 0 });
    expect(movedCounts(r).channels.map((c) => c.key)).toEqual(['cash:NONE', `account:${BANKILY}`]);
  });

  it('counting again clears it: the figure the new count was taken against is the figure now', () => {
    const moved = inputs([...atCount, cash('salesIn', 1_500)]);
    const stale = assembleReport(moved);
    const recounted = assembleReport({ ...moved, counts: new Map([...moved.counts, ['cash:NONE', counted(21_500, 21_500)]]) });
    expect(stale.expected.cash.movedSinceCount).toBe(true);
    expect(recounted.expected.cash).toMatchObject({ expected: 21_500, expectedAtCount: 21_500, movedSinceCount: false, difference: 0 });
    expect(warning(recounted)).toBeUndefined();
    // The figures are the same either side of the recount; the version still moves, because what was counted did.
    expect(reportVersion(recounted)).not.toBe(reportVersion(stale));
  });

  it('only a fresh count is compared: a skip, a count from before a reopen, a channel nobody counted, a locked day', () => {
    const after = [...atCount, cash('salesIn', 1_500), bankily(700)];
    for (const state of [
      { verification: 'skipped' as const, counted: null, countedAt: COUNTED_AT, skipReason: 'Drawer key with the Owner', expectedAtCount: 20_000 },
      { verification: 'stale' as const, counted: 20_000, countedAt: COUNTED_AT, skipReason: null, expectedAtCount: 20_000 },
      // A locked day is read as it was closed: the service hands no figure to compare with.
      counted(undefined, 20_000),
    ]) {
      const r = assembleReport(inputs(after, { counts: new Map([['cash:NONE', state]]) }));
      expect(r.expected.cash).toMatchObject({ expectedAtCount: null, movedSinceCount: false });
      expect(r.expected.accounts[0]).toMatchObject({ verification: 'not_counted', expectedAtCount: null, movedSinceCount: false });
      expect(warning(r)).toBeUndefined();
    }
  });

  it('a skipped float and a float nobody counted assert no figure, so neither can move', () => {
    const r = assembleReport(
      inputs(atCount, {
        floats: [
          float({ expected: 31_000, counted: null, isSkipped: true, skipReason: 'App down' }),
          float({ providerId: 'p-sedad', label: 'Sedad float', expected: 9_000, counted: null, countedAt: null, countedByName: null, expectedAtCount: undefined }),
        ],
      }),
    );
    expect(r.expected.floats.map((f) => [f.expectedAtCount, f.movedSinceCount])).toEqual([
      [null, false],
      [null, false],
    ]);
  });
});

describe('the rule itself', () => {
  it('a cent either way is money that moved; less than half a cent is rounding, never a movement', () => {
    expect(figureMoved(100.01, 100)).toBe(true);
    expect(figureMoved(99.99, 100)).toBe(true);
    expect(figureMoved(100.004, 100)).toBe(false);
    expect(figureMoved(100, 100)).toBe(false);
  });

  it('a float unknown when counted and known now — or the reverse — moved; unknown both times did not', () => {
    expect(figureMoved(30_000, null)).toBe(true);
    expect(figureMoved(null, 30_000)).toBe(true);
    expect(figureMoved(null, null)).toBe(false);
    expect(floatSinceCount(float({ expected: 40_000, expectedAtCount: null }))).toEqual({ expectedAtCount: null, movedSinceCount: true });
  });
});

/**
 * The version a close is bound to (D159). Every day closed before 0091 has money version 0 and no stale count, and
 * must keep exactly the version it was closed on: pinned against the function as it stood before.
 */
describe('the report version and the day’s money version', () => {
  /** `reportVersion` as it stood before D159, copied verbatim. */
  function before(r: ClosingReport): string {
    const floats = r.expected.floats ?? [];
    const withoutZero = (side: Record<string, number>, key: string) => {
      if (side[key]) return side;
      const { [key]: _zero, ...rest } = side;
      return rest;
    };
    const figures = {
      s: { ...r.sales, salesCount: undefined, unitsSold: undefined },
      m: r.money.channels.map((c) => [c.key, withoutZero(c.in, 'agentIn'), withoutZero(c.out, 'agentOut'), c.net]),
      e: [r.expenses.total, r.expenses.lines.map((l) => [l.id, l.amount]), r.expenses.reversals.map((l) => [l.correctionId, l.amount])],
      x: [r.expected.cash.opening.amount, r.expected.cash.expected, r.expected.cash.verification, r.expected.accounts.map((a) => [a.key, a.expectedMovement, a.verification])],
      r: [r.result.status, r.result.costOfUnitsSold, r.result.grossProfit],
      ...(floats.length > 0 ? { f: floats.map((f) => [f.providerId, f.expected, f.counted === null ? (f.isSkipped ? 'skipped' : 'not_counted') : 'counted']) } : {}),
    };
    return createHash('sha256').update(JSON.stringify(figures)).digest('hex').slice(0, 16);
  }

  it('money version 0 and no stale count: exactly the version every earlier close was hashed on', () => {
    const r = assembleReport(inputs(atCount));
    expect(reportVersion(r, 0)).toBe(before(r));
    expect(reportVersion(r)).toBe(before(r));
    const electronicsOnly = assembleReport(inputs([cash('salesIn', 5_000)], { floats: [], counts: new Map([['cash:NONE', counted(15_000, 15_000)]]) }));
    expect(electronicsOnly.expected.cash.movedSinceCount).toBe(false);
    expect(reportVersion(electronicsOnly, 0)).toBe(before(electronicsOnly));
  });

  it('any other money version is part of it: a money write that left every figure as it was still moves the version', () => {
    const r = assembleReport(inputs(atCount));
    expect(reportVersion(r, 3)).not.toBe(reportVersion(r, 0));
    expect(reportVersion(r, 4)).not.toBe(reportVersion(r, 3));
    expect(reportVersion(r, 4)).toBe(reportVersion(r, 4));
  });

  it('a stale count is part of it too', () => {
    const r = assembleReport(inputs(atCount, { floats: [float({ expected: 30_700 })] }));
    const same = { ...r, expected: { ...r.expected, floats: r.expected.floats.map((f) => ({ ...f, movedSinceCount: false })) } };
    expect(reportVersion(r)).not.toBe(reportVersion(same));
  });
});
