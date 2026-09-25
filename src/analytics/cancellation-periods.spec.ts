import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildChannels, type MovementRow } from '../closing/channels';
import { assembleReport, reportInvariants, type ReportInputs } from '../closing/closing-report';
import { ADJUSTMENT, METRIC_COLUMN, type GoalMetricKey } from '../goals/goal-progress';
import { profit } from './accounting-rules';

/**
 * A sale cancelled the same day, and on a later business day (docs/51 §16, 0080).
 *
 * The rule every reader follows: the sale counts on the business day it was sold —
 * that day's Daily closing has shown it, and a closed day never changes — and the
 * cancellation comes off on the business day it was approved. So over the two days
 * together every reader says the same thing, and over each day alone every reader
 * says what that day's closing says.
 *
 * The records, once. D1 = 2026-09-24, D2 = 2026-09-25.
 *   S  1 phone 10 000 (cost 8 000) + 2 cases × 500 (cost 200 each)   11 000   3 units   paid 11 000 cash
 *   T  1 phone 10 000 (cost 8 000)                                    10 000   1 unit    paid 10 000 cash
 *   S is cancelled (its 11 000 given back in cash) — on D1, or on D2.
 *
 * Each reader's rows are derived below from those records by that reader's documented
 * rule; the figures then come from the production code: the goal's own SQL
 * expression (`METRIC_COLUMN` − `ADJUSTMENT`), Results' `profit()` and the
 * Daily closing's `assembleReport()`. The SQL that fills the rows is proved on a real
 * database by the lifecycle recorded in docs/21; the source pins at the end hold the
 * keys it uses.
 */

const D1 = '2026-09-24';
const D2 = '2026-09-25';

interface Line { price: number; qty: number; cost: number; phone: boolean }
interface Sale { id: string; day: string; lines: Line[]; paidCash: number }
const S: Sale = { id: 'S', day: D1, paidCash: 11_000, lines: [{ price: 10_000, qty: 1, cost: 8_000, phone: true }, { price: 500, qty: 2, cost: 200, phone: false }] };
const T: Sale = { id: 'T', day: D1, paidCash: 10_000, lines: [{ price: 10_000, qty: 1, cost: 8_000, phone: true }] };
const SALES = [S, T];

const value = (s: Sale) => s.lines.reduce((n, l) => n + l.price * l.qty, 0);
const cost = (s: Sale) => s.lines.reduce((n, l) => n + l.cost * l.qty, 0);
const units = (s: Sale) => s.lines.reduce((n, l) => n + l.qty, 0);
const phones = (s: Sale) => s.lines.filter((l) => l.phone).reduce((n, l) => n + l.qty, 0);
const sumOf = (xs: Sale[], f: (s: Sale) => number) => xs.reduce((n, s) => n + f(s), 0);

/** Which sale was cancelled, and the business day its cancellation was approved. */
type Scenario = { cancelledOn: string };
const soldOn = (day: string) => SALES.filter((s) => s.day === day);
const cancelledOn = (sc: Scenario, day: string) => (sc.cancelledOn === day ? [S] : []);

// ── The rollup row of a day (rollup.service.ts): the day's sales, and the sales cancelled on it ──
function rollupRow(sc: Scenario, day: string): Record<string, number> {
  const sold = soldOn(day);
  const gone = cancelledOn(sc, day);
  return {
    revenue: sumOf(sold, value),
    cogs: sumOf(sold, cost),
    gross_profit: sumOf(sold, value) - sumOf(sold, cost),
    sales_count: sold.length,
    qty_sold: sumOf(sold, units),
    cancelled_revenue: sumOf(gone, value),
    cancelled_cogs: sumOf(gone, cost),
    cancelled_count: gone.length,
    cancelled_qty: sumOf(gone, units),
    // No return in these two scenarios (docs/53 covers returns).
    returns_revenue: 0,
    returns_adjustments: 0,
    returns_gross_profit: 0,
    returns_count: 0,
  };
}

/** A branch goal over some days: the production expression, evaluated on each day's row, summed (goals.service.ts). */
function goal(sc: Scenario, metric: GoalMetricKey, days: string[]): number {
  const expression = `\`${METRIC_COLUMN[metric]}\` - (${ADJUSTMENT[metric]})`.replace(/`(\w+)`/g, 'row.$1');
  const evaluate = new Function('row', `return ${expression};`) as (row: Record<string, number>) => number;
  return days.reduce((n, d) => n + evaluate(rollupRow(sc, d)), 0);
}

/** Results over some days (summary.service.ts → accounting-rules.profit). */
function results(sc: Scenario, days: string[]) {
  const rows = days.map((d) => rollupRow(sc, d));
  const total = (k: string) => rows.reduce((n, r) => n + r[k], 0);
  return profit({
    grossSales: total('revenue'),
    returnsRevenue: 0,
    cogs: total('cogs'),
    returnsCogs: 0,
    cancelledRevenue: total('cancelled_revenue'),
    cancelledCogs: total('cancelled_cogs'),
    expenses: 0,
  });
}

/** Home over some days (dashboard.service.ts): the sales of those days, and the cancellations approved on them. */
function home(sc: Scenario, days: string[]) {
  const sold = days.flatMap(soldOn);
  const gone = days.flatMap((d) => cancelledOn(sc, d));
  return {
    salesValue: sumOf(sold, value),
    salesCount: sold.length,
    phonesSold: sumOf(sold, phones),
    cancellations: { count: gone.length, value: sumOf(gone, value), phones: sumOf(gone, phones) },
  };
}

/** The Daily closing of one day (closing-report.queries.ts → assembleReport). */
function closing(sc: Scenario, day: string) {
  const sold = soldOn(day);
  const gone = cancelledOn(sc, day);
  // The money given back leaves the drawer on the day of the cancellation, as a leg.
  const givenBack = sumOf(gone, (s) => s.paidCash);
  const ownGivenBack = sumOf(gone.filter((s) => s.day === day), (s) => s.paidCash);
  const movements: MovementRow[] = [
    ...(sold.length ? [{ channel: 'cash' as const, accountId: null, component: 'salesIn' as const, amount: sumOf(sold, (s) => s.paidCash) }] : []),
    ...(givenBack ? [{ channel: 'cash' as const, accountId: null, component: 'correctionsOut' as const, amount: givenBack }] : []),
  ];
  const splits = new Map([['cash:NONE', { todaysSales: sumOf(sold, (s) => s.paidCash), olderDebts: 0 }]]);
  const channels = buildChannels(movements, [], 50_000);
  const inputs: ReportInputs = {
    date: day,
    today: D2,
    timezone: 'UTC',
    window: { startsAt: `${day}T06:00:00.000Z`, endsAt: `${day}T06:00:00.000Z` },
    standing: 'counting',
    sales: { count: sold.length, value: sumOf(sold, value), itemsSold: sumOf(sold, units), cost: sumOf(sold, cost), missingCostLines: 0 },
    returns: { count: 0, grossRefund: 0, adjustments: 0, netRefundDue: 0, costCredited: 0, missingCostLines: 0 },
    cancellations: {
      count: gone.length,
      value: sumOf(gone, value),
      items: sumOf(gone, units),
      cost: sumOf(gone, cost),
      missingCostLines: 0,
      ofTheseSales: sumOf(gone.filter((s) => s.day === day), value),
    },
    collected: { atCheckout: sumOf(sold, (s) => s.paidCash), laterSameDay: 0, corrections: -ownGivenBack },
    channels,
    splits,
    expenses: [],
    expenseReversals: [],
    counts: new Map(),
    opening: { amount: 50_000, anchorDate: null, anchorVerified: false, carriedDays: 0 },
    pending: null,
    openDiscrepancies: 0,
    previousDay: null,
    closeKind: 'first',
  };
  const report = assembleReport(inputs);
  expect(reportInvariants(report, channels, splits, inputs.cancellations.ofTheseSales)).toEqual([]);
  return report;
}

describe('a sale cancelled the same business day', () => {
  const sc: Scenario = { cancelledOn: D1 };

  it('the Daily closing shows the sale and its cancellation on D1, and nothing on D2', () => {
    const r1 = closing(sc, D1);
    expect([r1.sales.value, r1.sales.count, r1.sales.itemsSold]).toEqual([21_000, 2, 4]);
    expect(r1.sales.cancellations).toEqual({ count: 1, value: 11_000, items: 3 });
    expect([r1.sales.netSalesValue, r1.result.grossProfit, r1.sales.owed]).toEqual([10_000, 2_000, 0]);
    expect(r1.sales.collected.total).toBe(10_000);
    expect(r1.expected.cash.expected).toBe(50_000 + 21_000 - 11_000);
    const r2 = closing(sc, D2);
    expect([r2.sales.value, r2.sales.cancellations.count, r2.sales.netSalesValue]).toEqual([0, 0, 0]);
  });

  it('the units-sold goal nets to T\'s one unit on D1 — and so does every other goal metric', () => {
    expect(goal(sc, 'units_sold', [D1])).toBe(1);
    expect(goal(sc, 'revenue', [D1])).toBe(10_000);
    expect(goal(sc, 'sales_count', [D1])).toBe(1);
    expect(goal(sc, 'gross_profit', [D1])).toBe(2_000);
    expect(goal(sc, 'units_sold', [D2])).toBe(0);
  });

  it('Home shows the sale and the cancellation on the same day; Results nets them', () => {
    expect(home(sc, [D1])).toEqual({ salesValue: 21_000, salesCount: 2, phonesSold: 2, cancellations: { count: 1, value: 11_000, phones: 1 } });
    expect(results(sc, [D1])).toMatchObject({ grossSales: 21_000, cancelledRevenue: 11_000, netRevenue: 10_000, grossProfit: 2_000 });
  });

  it('every reader agrees on D1', () => {
    const r1 = closing(sc, D1);
    const h = home(sc, [D1]);
    const res = results(sc, [D1]);
    expect(h.salesValue - h.cancellations.value).toBe(r1.sales.netSalesValue);
    expect(res.netRevenue).toBe(r1.sales.netSalesValue);
    expect(goal(sc, 'revenue', [D1])).toBe(r1.sales.netSalesValue);
    expect(goal(sc, 'units_sold', [D1])).toBe(r1.sales.itemsSold - r1.sales.cancellations.items);
    expect(goal(sc, 'sales_count', [D1])).toBe(r1.sales.count - r1.sales.cancellations.count);
    expect(goal(sc, 'gross_profit', [D1])).toBe(r1.result.grossProfit);
    expect(res.grossProfit).toBe(r1.result.grossProfit);
  });
});

describe('a sale cancelled on a later business day', () => {
  const sc: Scenario = { cancelledOn: D2 };

  it('D1 keeps the sale exactly as it was sold and closed; D2 carries the cancellation', () => {
    const r1 = closing(sc, D1);
    expect([r1.sales.value, r1.sales.itemsSold, r1.sales.cancellations.count]).toEqual([21_000, 4, 0]);
    expect([r1.sales.netSalesValue, r1.result.grossProfit, r1.sales.collected.total]).toEqual([21_000, 4_600, 21_000]);
    const r2 = closing(sc, D2);
    expect([r2.sales.value, r2.sales.count, r2.sales.itemsSold]).toEqual([0, 0, 0]);
    expect(r2.sales.cancellations).toEqual({ count: 1, value: 11_000, items: 3 });
    expect([r2.sales.netSalesValue, r2.result.costOfUnitsSold, r2.result.grossProfit]).toEqual([-11_000, -8_400, -2_600]);
    expect(r2.expected.cash.expected).toBe(50_000 - 11_000);
  });

  it('the units-sold goal counts S\'s 3 units in D1 and takes them off in D2', () => {
    expect(goal(sc, 'units_sold', [D1])).toBe(4);
    expect(goal(sc, 'units_sold', [D2])).toBe(-3);
    expect(goal(sc, 'units_sold', [D1, D2])).toBe(1);
    expect([goal(sc, 'revenue', [D1]), goal(sc, 'revenue', [D2]), goal(sc, 'revenue', [D1, D2])]).toEqual([21_000, -11_000, 10_000]);
    expect([goal(sc, 'sales_count', [D1]), goal(sc, 'sales_count', [D2])]).toEqual([2, -1]);
    expect([goal(sc, 'gross_profit', [D1]), goal(sc, 'gross_profit', [D2])]).toEqual([4_600, -2_600]);
  });

  it('Home shows the sale on D1 and the cancellation on D2; over both, Results and Home agree', () => {
    expect(home(sc, [D1])).toEqual({ salesValue: 21_000, salesCount: 2, phonesSold: 2, cancellations: { count: 0, value: 0, phones: 0 } });
    expect(home(sc, [D2])).toEqual({ salesValue: 0, salesCount: 0, phonesSold: 0, cancellations: { count: 1, value: 11_000, phones: 1 } });
    expect(results(sc, [D1])).toMatchObject({ netRevenue: 21_000, grossProfit: 4_600 });
    expect(results(sc, [D2])).toMatchObject({ grossSales: 0, cancelledRevenue: 11_000, netRevenue: -11_000, grossProfit: -2_600 });
  });

  it('every reader agrees on each day, and over both days, and both scenarios end in the same place', () => {
    for (const days of [[D1], [D2], [D1, D2]]) {
      const reports = days.map((d) => closing(sc, d));
      const net = reports.reduce((n, r) => n + r.sales.netSalesValue, 0);
      const itemsNet = reports.reduce((n, r) => n + r.sales.itemsSold - r.sales.cancellations.items, 0);
      const countNet = reports.reduce((n, r) => n + r.sales.count - r.sales.cancellations.count, 0);
      const gp = reports.reduce((n, r) => n + (r.result.grossProfit ?? 0), 0);
      const h = home(sc, days);
      expect(h.salesValue - h.cancellations.value).toBe(net);
      expect(results(sc, days).netRevenue).toBe(net);
      expect(results(sc, days).grossProfit).toBe(gp);
      expect(goal(sc, 'revenue', days)).toBe(net);
      expect(goal(sc, 'units_sold', days)).toBe(itemsNet);
      expect(goal(sc, 'sales_count', days)).toBe(countNet);
      expect(goal(sc, 'gross_profit', days)).toBe(gp);
    }
    const sameDay: Scenario = { cancelledOn: D1 };
    for (const metric of Object.keys(METRIC_COLUMN) as GoalMetricKey[]) {
      expect(goal(sc, metric, [D1, D2])).toBe(goal(sameDay, metric, [D1, D2]));
    }
  });
});

describe('the keys the SQL uses (source pins)', () => {
  const SRC = join(__dirname, '..');
  const code = (...p: string[]) =>
    readFileSync(join(SRC, ...p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const rollup = code('analytics', 'rollup.service.ts');
  const goals = code('goals', 'goals.service.ts');
  const dashboard = code('analytics', 'dashboard.service.ts');
  const queries = code('closing', 'closing-report.queries.ts');
  const migration = readFileSync(join(SRC, '..', 'prisma', 'migrations', '0080_cancelled_units', 'migration.sql'), 'utf8');

  it('the rollup writes the cancelled units on the correction day, from the lines it reads for the cancelled revenue', () => {
    const cancelled = rollup.slice(rollup.indexOf('const cancelledLines'), rollup.indexOf('const cancelledQty'));
    expect(cancelled).toMatch(/JOIN sales s ON s\.id = fc\.target_sale_id\s+JOIN sale_items si ON si\.sale_id = s\.id AND si\.voided = 0/);
    expect(cancelled).toMatch(/fc\.correction_date = \$\{day\}/);
    // Units and revenue from the same lines, the revenue at their shares of the invoice (docs/54 D36).
    expect(cancelled).toMatch(/const cancelled = lineTotals\(cancelledLines, sharesBySale\(shareLines\(cancelledLines\)\)\);/);
    expect(rollup).toMatch(/const cancelledQty = cancelled\.qty;/);
    expect(rollup.match(/cancelledQty,/g)).toHaveLength(2);
  });

  it('the sale\'s own day is never filtered: its rollup, Home\'s sales value and its report keep it', () => {
    const sold = rollup.slice(rollup.indexOf('const dayLines'), rollup.indexOf('const expRows'));
    expect(sold).toMatch(/s\.business_date = \$\{day\}/);
    expect(sold).not.toMatch(/released_by_correction_id|financial_corrections/);
    expect(dashboard).toMatch(/const saleWhere = \{ branchId, isReversed: false, businessDate: dateRange \};/);
  });

  it('a personal goal keys the sale on its business date and the cancellation on its approval date', () => {
    expect(goals).toMatch(/s\.business_date BETWEEN \$\{from\} AND \$\{to\}\) AS sold/);
    expect(goals).toMatch(/fc\.correction_date BETWEEN \$\{from\} AND \$\{to\}\) AS cancelled/);
    expect(goals).toMatch(/return round2\(num\(rows\[0\]\?\.sold as number\) - num\(rows\[0\]\?\.cancelled as number\) - num\(rows\[0\]\?\.returned as number\)\);/);
    expect(goals).not.toMatch(/DATE\(s\.sold_at\)/);
  });

  it('Home and the Daily closing count a cancellation on the day it was approved', () => {
    // Home reads the one dated definition (docs/53 D29), which keys a cancellation on its approval date.
    expect(dashboard).toMatch(/periodFigures\(this\.db, companyId, branchId, range\.from, range\.to\)/);
    expect(code('analytics', 'period-figures.ts')).toMatch(/fc\.target_kind = 'sale' AND fc\.status = 'approved'\s+AND fc\.correction_date BETWEEN \$\{from\} AND \$\{to\}/);
    const figures = queries.slice(queries.indexOf('export async function cancellationFigures'), queries.indexOf('export async function expenseReversalLines'));
    expect(figures).toMatch(/COALESCE\(SUM\(si\.quantity\), 0\) AS items/);
    expect(figures).toMatch(/fc\.correction_date = \$\{date\}/);
  });

  it('0080 adds the column once and backfills it from the same lines, per branch and correction day', () => {
    expect(migration).toMatch(/column_name = 'cancelled_qty'\) = 0/);
    expect(migration).toMatch(/ADD COLUMN `cancelled_qty` INT NOT NULL DEFAULT 0/);
    expect(migration).toMatch(/JOIN `sale_items` si ON si\.sale_id = fc\.target_sale_id AND si\.voided = 0/);
    expect(migration).toMatch(/c\.branch_id = dr\.branch_id AND c\.correction_date = dr\.day/);
  });
});
