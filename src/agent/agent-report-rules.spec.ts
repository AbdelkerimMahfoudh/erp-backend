import { aggregateAgentReport, periodRangeOf, REPORT_PERIODS, type ReportRebalancingLeg, type ReportTransaction } from './agent-report-rules';

/**
 * The agent reports (D157), pure: the period's business dates, and the
 * figures from the period's rows — completed, reversed and rebalanced apart.
 */

const BANKILY = 'b0000000-0000-7000-8000-000000000001';
const SEDAD = 'b0000000-0000-7000-8000-000000000002';

const tx = (over: Partial<ReportTransaction> = {}): ReportTransaction => ({
  providerId: BANKILY,
  providerLabel: 'Bankily',
  direction: 'cash_in_credit_out',
  amount: 10_000,
  commission: 100,
  status: 'completed',
  recordedById: 'u1',
  recordedByName: 'Aicha',
  businessDate: '2026-10-08',
  ...over,
});

describe('the period’s business dates', () => {
  it('a day is itself; a week runs Monday to Sunday around the date; a month and a year are whole', () => {
    expect(periodRangeOf('day', '2026-10-08')).toEqual({ from: '2026-10-08', to: '2026-10-08' });
    // 2026-10-08 is a Thursday.
    expect(periodRangeOf('week', '2026-10-08')).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    // A Monday starts its own week; a Sunday ends the week before it.
    expect(periodRangeOf('week', '2026-10-05')).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(periodRangeOf('week', '2026-10-11')).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(periodRangeOf('month', '2026-02-14')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodRangeOf('month', '2028-02-14')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(periodRangeOf('month', '2026-12-31')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(periodRangeOf('year', '2026-06-15')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(REPORT_PERIODS).toEqual(['day', 'week', 'month', 'year']);
  });
});

describe('the figures of a period', () => {
  const rows = [
    tx({ amount: 20_000, commission: 200 }),
    tx({ direction: 'cash_out_credit_in', amount: 15_000, commission: 150, providerId: SEDAD, providerLabel: 'Sedad', recordedById: 'u2', recordedByName: 'Moussa' }),
    tx({ amount: 5_000, commission: 50, status: 'reversed' }),
    tx({ direction: 'cash_out_credit_in', amount: 0.1, commission: 0, businessDate: '2026-10-09' }),
    tx({ direction: 'cash_out_credit_in', amount: 0.2, commission: 0, businessDate: '2026-10-09' }),
  ];
  const legs: ReportRebalancingLeg[] = [
    { rebalancingId: 'r1', account: 'cash', direction: 'outflow', amount: 100_000, businessDate: '2026-10-08' },
    { rebalancingId: 'r1', account: 'provider', direction: 'inflow', amount: 100_000, businessDate: '2026-10-08' },
    { rebalancingId: 'r2', account: 'cash', direction: 'inflow', amount: 50_000, businessDate: '2026-10-09' },
    { rebalancingId: 'r2', account: 'external', direction: 'outflow', amount: 50_000, businessDate: '2026-10-09' },
    { rebalancingId: 'r3', account: 'commission_held', direction: 'outflow', amount: 300, businessDate: '2026-10-09' },
    { rebalancingId: 'r3', account: 'cash', direction: 'inflow', amount: 300, businessDate: '2026-10-09' },
  ];
  const report = aggregateAgentReport({ period: 'week', from: '2026-10-05', to: '2026-10-11', transactions: rows, rebalancingLegs: legs });

  it('count, volume and commission are the completed exchanges only; the reversed one is counted apart', () => {
    expect(report.totals).toEqual({
      count: 4,
      volume: 35_000.3,
      cashReceived: 20_000,
      cashPaid: 15_000.3,
      creditSent: 20_000,
      creditReceived: 15_000.3,
      commission: 350,
      reversals: { count: 1, volume: 5_000, commission: 50 },
      rebalancings: { count: 3, cashIn: 50_300, cashOut: 100_000, floatIn: 100_000, floatOut: 0 },
    });
  });

  it('a rebalancing never changes count, volume or commission (A8)', () => {
    const without = aggregateAgentReport({ period: 'week', from: '2026-10-05', to: '2026-10-11', transactions: rows, rebalancingLegs: [] });
    const { rebalancings: _a, ...withLegs } = report.totals;
    const { rebalancings: _b, ...withoutLegs } = without.totals;
    expect(withLegs).toEqual(withoutLegs);
    expect(without.totals.rebalancings).toEqual({ count: 0, cashIn: 0, cashOut: 0, floatIn: 0, floatOut: 0 });
    expect(report.byProvider).toEqual(without.byProvider);
    expect(report.byEmployee).toEqual(without.byEmployee);
  });

  it('by provider, largest volume first, each with its own reversals', () => {
    expect(report.byProvider.map((p) => [p.label, p.count, p.volume, p.commission, p.reversals.count])).toEqual([
      ['Bankily', 3, 20_000.3, 200, 1],
      ['Sedad', 1, 15_000, 150, 0],
    ]);
    expect(report.byProvider[0]).toMatchObject({ providerId: BANKILY, cashReceived: 20_000, cashPaid: 0.3, creditSent: 20_000, creditReceived: 0.3, reversals: { count: 1, volume: 5_000, commission: 50 } });
  });

  it('by employee: what each recorded, and how many of theirs were reversed', () => {
    expect(report.byEmployee).toEqual([
      { userId: 'u1', name: 'Aicha', count: 3, volume: 20_000.3, commission: 200, reversals: { count: 1 } },
      { userId: 'u2', name: 'Moussa', count: 1, volume: 15_000, commission: 150, reversals: { count: 0 } },
    ]);
  });

  it('no byMonth outside the year; an empty period is all zeros', () => {
    expect(report.byMonth).toBeUndefined();
    const empty = aggregateAgentReport({ period: 'day', from: '2026-10-08', to: '2026-10-08', transactions: [], rebalancingLegs: [] });
    expect(empty).toEqual({
      period: 'day',
      from: '2026-10-08',
      to: '2026-10-08',
      totals: { count: 0, volume: 0, cashReceived: 0, cashPaid: 0, creditSent: 0, creditReceived: 0, commission: 0, reversals: { count: 0, volume: 0, commission: 0 }, rebalancings: { count: 0, cashIn: 0, cashOut: 0, floatIn: 0, floatOut: 0 } },
      byProvider: [],
      byEmployee: [],
    });
  });

  it('the year groups by month, in the totals’ shape, months in order, and the months add up to the year', () => {
    const year = aggregateAgentReport({
      period: 'year',
      from: '2026-01-01',
      to: '2026-12-31',
      transactions: [tx({ businessDate: '2026-03-02', amount: 100, commission: 1 }), tx({ businessDate: '2026-01-15', amount: 50, commission: 0.5 }), tx({ businessDate: '2026-03-30', amount: 7, commission: 0.07, status: 'reversed' })],
      rebalancingLegs: [{ rebalancingId: 'r9', account: 'cash', direction: 'inflow', amount: 10, businessDate: '2026-07-01' }, { rebalancingId: 'r9', account: 'external', direction: 'outflow', amount: 10, businessDate: '2026-07-01' }],
    });
    expect(year.byMonth!.map((m) => m.month)).toEqual(['2026-01', '2026-03', '2026-07']);
    expect(year.byMonth![0]).toMatchObject({ month: '2026-01', count: 1, volume: 50, commission: 0.5 });
    expect(year.byMonth![1]).toMatchObject({ month: '2026-03', count: 1, volume: 100, commission: 1, reversals: { count: 1, volume: 7, commission: 0.07 } });
    expect(year.byMonth![2]).toMatchObject({ month: '2026-07', count: 0, rebalancings: { count: 1, cashIn: 10 } });
    expect(year.byMonth!.reduce((n, m) => n + m.volume, 0)).toBe(year.totals.volume);
    expect(year.byMonth!.reduce((n, m) => n + m.commission, 0)).toBe(year.totals.commission);
  });
});
