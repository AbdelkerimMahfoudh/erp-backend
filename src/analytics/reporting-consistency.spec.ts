import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sumFigures, type PeriodFigures } from './period-figures';
import { profit } from './accounting-rules';
import { ADJUSTMENT, METRIC_COLUMN, type GoalMetricKey } from '../goals/goal-progress';
import { expensesTodayOf } from '../closing/expenses-today';
import { stripFinancialFields } from '../common/interceptors/financial-fields';
import { assembleReport, reportVersion, type ReportInputs } from '../closing/closing-report';
import { buildChannels } from '../closing/channels';

/**
 * One set of dated rules for every screen (docs/53). Money, Home, sales by day, the employees and
 * the product reports read `period-figures.ts`; Results, branch goals and branches read the rollup
 * columns holding the same facts. The arithmetic of the rules is exercised here on the scenarios
 * the brief names; the real-database lifecycle recorded in docs/21 proves the SQL behind them.
 *
 *   D1  S: 2 phones × 10 000 (cost 6 000 each) — a partial return of one, approved D2, 500 kept
 *       T: 1 phone 10 000 (cost 6 000) — cancelled D3
 *       an expense of 800 confirmed D1; 300 of it reversed D3
 *   D2  the return: gross 10 000, adjustments 500, net refund due 9 500, cost credited 6 000
 *   D3  T's cancellation and the reversal — a day holding only negative adjustments
 *   D4  the refund of 9 500 confirmed — money only
 */

const zero = () => ({ count: 0, value: 0, units: 0, phones: 0, cost: 0, margin: 0 });
const noReturn = () => ({ count: 0, value: 0, grossRefund: 0, adjustments: 0, costCredited: 0, profitEffect: 0, phones: 0 });
const day = (over: Partial<Omit<PeriodFigures, 'net'>>): PeriodFigures =>
  sumFigures([
    {
      invoices: zero(),
      cancellations: zero(),
      returns: noReturn(),
      expenses: { recorded: 0, recordedCount: 0, reversed: 0, reversedCount: 0, net: 0 },
      net: { salesValue: 0, salesCount: 0, units: 0, phones: 0 },
      ...over,
    },
  ]);

const D1 = day({
  invoices: { count: 2, value: 30_000, units: 3, phones: 3, cost: 18_000, margin: 12_000 },
  expenses: { recorded: 800, recordedCount: 1, reversed: 0, reversedCount: 0, net: 800 },
});
const D2 = day({ returns: { count: 1, value: 9_500, grossRefund: 10_000, adjustments: 500, costCredited: 6_000, profitEffect: 3_500, phones: 1 } });
const D3 = day({
  cancellations: { count: 1, value: 10_000, units: 1, phones: 1, cost: 6_000, margin: 4_000 },
  expenses: { recorded: 0, recordedCount: 0, reversed: 300, reversedCount: 1, net: -300 },
});
const D4 = day({});

describe('the shared definitions (period-figures)', () => {
  it('a sale stays on its day; a return and a cancellation come off on theirs; counts and units follow R5/R6', () => {
    expect(D1.net).toEqual({ salesValue: 30_000, salesCount: 2, units: 3, phones: 3 });
    // The partial return: revenue falls by the net refund due; the count and the units sold do not move (a return is its own event).
    expect(D2.net).toEqual({ salesValue: -9_500, salesCount: 0, units: 0, phones: 0 });
    expect(D2.returns.count).toBe(1);
    // The later-day cancellation: a day holding only negative adjustments.
    expect(D3.net).toEqual({ salesValue: -10_000, salesCount: -1, units: -1, phones: -1 });
    expect(D3.expenses).toEqual({ recorded: 0, recordedCount: 0, reversed: 300, reversedCount: 1, net: -300 });
    // The refund paid later changes no sales figure.
    expect(D4.net).toEqual({ salesValue: 0, salesCount: 0, units: 0, phones: 0 });
  });

  it('a period is the sum of its days — whichever days it holds', () => {
    const all = sumFigures([D1, D2, D3, D4]);
    expect(all.net).toEqual({ salesValue: 10_500, salesCount: 1, units: 2, phones: 2 });
    expect(all.expenses.net).toBe(500);
    expect(sumFigures([D2, D3]).net.salesValue).toBe(-19_500);
  });
});

/** The rollup row of each day, as `rollup.service.ts` writes it for the scenario. */
const ROLLUP: Record<string, Record<string, number>> = {
  D1: { revenue: 30_000, cogs: 18_000, gross_profit: 12_000, sales_count: 2, qty_sold: 3, expenses: 800 },
  D2: { returns_revenue: 10_000, returns_adjustments: 500, returns_cogs: 6_000, returns_gross_profit: 3_500 },
  D3: { cancelled_revenue: 10_000, cancelled_cogs: 6_000, cancelled_count: 1, cancelled_qty: 1, expenses: -300 },
  D4: {},
};
const COLUMNS = ['revenue', 'cogs', 'gross_profit', 'sales_count', 'qty_sold', 'expenses', 'returns_revenue', 'returns_adjustments', 'returns_cogs', 'returns_gross_profit', 'cancelled_revenue', 'cancelled_cogs', 'cancelled_count', 'cancelled_qty'];
const row = (d: string) => Object.fromEntries(COLUMNS.map((c) => [c, ROLLUP[d][c] ?? 0]));
/** A branch goal: the production expression, evaluated per day and summed (goals.service.ts). */
const goal = (metric: GoalMetricKey, days: string[]) => {
  const expr = `\`${METRIC_COLUMN[metric]}\` - (${ADJUSTMENT[metric]})`.replace(/`(\w+)`/g, 'row.$1');
  const f = new Function('row', `return ${expr};`) as (r: Record<string, number>) => number;
  return days.reduce((n, d) => n + f(row(d)), 0);
};

describe('branch goals take returns off on their approval day, by the net refund due', () => {
  it('each day, and over all four', () => {
    expect([goal('revenue', ['D1']), goal('revenue', ['D2']), goal('revenue', ['D3']), goal('revenue', ['D4'])]).toEqual([30_000, -9_500, -10_000, 0]);
    expect(goal('revenue', ['D1', 'D2', 'D3', 'D4'])).toBe(sumFigures([D1, D2, D3, D4]).net.salesValue);
    // Profit: the return takes gross − adjustments − cost credited (3 500); the cancellation its margin (4 000).
    expect([goal('gross_profit', ['D1']), goal('gross_profit', ['D2']), goal('gross_profit', ['D3'])]).toEqual([12_000, -3_500, -4_000]);
    // Count and units: the cancellation only — the return is its own event (R5, R6).
    expect([goal('sales_count', ['D1', 'D2', 'D3']), goal('units_sold', ['D1', 'D2', 'D3'])]).toEqual([1, 2]);
    expect([goal('sales_count', ['D2']), goal('units_sold', ['D2'])]).toEqual([0, 0]);
  });
});

describe('Results takes the net refund due (D30)', () => {
  const results = (days: string[]) => {
    const s = (c: string) => days.reduce((n, d) => n + row(d)[c], 0);
    return profit({
      grossSales: s('revenue'),
      returnsRevenue: s('returns_revenue') - s('returns_adjustments'),
      cogs: s('cogs'),
      returnsCogs: s('returns_cogs'),
      cancelledRevenue: s('cancelled_revenue'),
      cancelledCogs: s('cancelled_cogs'),
      expenses: s('expenses'),
    });
  };

  it('agrees with the goals, the shared definitions and the rollup\'s own net profit, day by day', () => {
    for (const [d, f] of [['D1', D1], ['D2', D2], ['D3', D3], ['D4', D4]] as const) {
      const r = results([d]);
      expect(r.netRevenue).toBe(f.net.salesValue);
      expect(r.grossProfit).toBe(goal('gross_profit', [d]));
      // rollup.service: net_profit = gross − returns effect − (cancelled revenue − cost) − expenses
      const x = row(d);
      expect(r.netOperatingProfit).toBe(x.gross_profit - x.returns_gross_profit - (x.cancelled_revenue - x.cancelled_cogs) - x.expenses);
    }
  });

  it('over a sale and its return the kept adjustment stays profit (return-accounting-correction)', () => {
    const r = results(['D1', 'D2']);
    // Sold 30 000 at cost 18 000; one phone back at 10 000, 500 kept, its 6 000 cost credited.
    expect([r.netRevenue, r.netCogs, r.grossProfit]).toEqual([20_500, 12_000, 8_500]);
  });

  it('the summary passes the net refund due', () => {
    const summary = readFileSync(join(__dirname, 'summary.service.ts'), 'utf8');
    expect(summary).toMatch(/returnsRevenue: round2\(current\.returnsRevenue - current\.returnsAdjustments\)/);
    expect(summary).toMatch(/returnsRevenue: round2\(previous\.returnsRevenue - previous\.returnsAdjustments\)/);
  });
});

describe('Money\'s today\'s expenses (D33)', () => {
  const id = (n: number) => Buffer.alloc(16, n);
  it('rows on the accounting day, each reversal its own negative row; the rows add up to the total', () => {
    const t = expensesTodayOf(
      [{ id: id(1), category: 'Transport', amount: 800, method: 'cash', accountLabelSnapshot: null, reference: null, receiptKey: null, confirmedAt: null }],
      [{ id: id(2), amount: 300, method: 'cash', accountLabelSnapshot: null, decidedAt: null, targetExpense: { id: id(3), category: 'Food' } }],
    );
    expect(t.rows.map((r) => [r.kind, r.description, r.amount])).toEqual([['expense', 'Transport', 800], ['reversal', 'Food', -300]]);
    expect([t.recorded, t.reversed, t.total]).toEqual([800, 300, 500]);
    expect(t.rows.reduce((n, r) => n + r.amount, 0)).toBe(t.total);
  });

  it('a day with only a reversal reads negative, and says why', () => {
    const t = expensesTodayOf([], [{ id: id(2), amount: 300, method: 'cash', accountLabelSnapshot: null, decidedAt: null, targetExpense: { id: id(3), category: 'Food' } }]);
    expect(t.total).toBe(-300);
    expect(t.rows[0]).toMatchObject({ kind: 'reversal', description: 'Food', amount: -300 });
  });
});

describe('cost and profit stay hidden without cost.view (D35)', () => {
  it('Results\' comparison and cost side are stripped; revenue stays', () => {
    const out = stripFinancialFields({
      profit: { netRevenue: 1 },
      comparison: { netRevenue: { previous: 1 }, grossProfit: { previous: 2 }, netOperatingProfit: { previous: 3 } },
      block: { netCogs: 1, returnsCogs: 2, cancelledCogs: 3, returnsGrossProfit: 4, cancelledCostCredited: 5, revenue: 6 },
    });
    expect(out).toEqual({ comparison: { netRevenue: { previous: 1 } }, block: { revenue: 6 } });
  });

  it('a profit goal is neither listed for nor readable by someone who may not see cost', () => {
    const goals = readFileSync(join(__dirname, '..', 'goals', 'goals.service.ts'), 'utf8');
    expect(goals).toMatch(/\.\.\.\(seesCost \? \{\} : \{ metric: \{ not: 'gross_profit' as const \} \}\)/);
    expect(goals).toMatch(/if \(goal\.metric === 'gross_profit' && !\(await this\.seesCost\(\)\)\) throw new NotFoundException/);
  });
});

describe('the Daily closing shows the defined count, and every stored close stays valid', () => {
  const base = (): ReportInputs => ({
    date: '2026-09-24',
    today: '2026-09-24',
    timezone: 'UTC',
    window: { startsAt: '2026-09-24T06:00:00.000Z', endsAt: '2026-09-25T06:00:00.000Z' },
    standing: 'counting',
    sales: { count: 0, value: 0, itemsSold: 0, cost: 0, missingCostLines: 0 },
    returns: { count: 0, grossRefund: 0, adjustments: 0, netRefundDue: 0, costCredited: 0, missingCostLines: 0 },
    cancellations: { count: 1, value: 10_000, items: 1, cost: 6_000, missingCostLines: 0, ofTheseSales: 0 },
    collected: { atCheckout: 0, laterSameDay: 0, corrections: 0 },
    channels: buildChannels([{ channel: 'cash', accountId: null, component: 'correctionsOut', amount: 10_000 }], [], 50_000),
    splits: new Map(),
    expenses: [],
    expenseReversals: [],
    counts: new Map(),
    opening: { amount: 50_000, anchorDate: null, anchorVerified: false, carriedDays: 0 },
    pending: null,
    openDiscrepancies: 0,
    previousDay: null,
    closeKind: 'first',
  });

  it('a day holding only a cancellation: −1 sale, −1 unit', () => {
    const r = assembleReport(base());
    expect([r.sales.count, r.sales.salesCount, r.sales.itemsSold, r.sales.unitsSold]).toEqual([0, -1, 0, -1]);
  });

  it('the derived count and units are not part of the version a close is bound to', () => {
    const r = assembleReport(base());
    expect(reportVersion({ ...r, sales: { ...r.sales, salesCount: 99, unitsSold: 99 } })).toBe(reportVersion(r));
  });
});

describe('every screen reads the one definition, on the date that carries each fact (source pins)', () => {
  const src = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');
  const figures = src('analytics', 'period-figures.ts');

  it('period-figures keys each fact on its own date', () => {
    expect(figures).toMatch(/s\.business_date BETWEEN \$\{from\} AND \$\{to\}/);
    expect(figures).toMatch(/fc\.target_kind = 'sale' AND fc\.status = 'approved'\s+AND fc\.correction_date BETWEEN \$\{from\} AND \$\{to\}/);
    expect(figures).toMatch(/rr\.approval_date BETWEEN \$\{from\} AND \$\{to\}/);
    expect(figures).toMatch(/IF\(expense_class = 'fixed', due_date, confirmation_date\) BETWEEN \$\{from\} AND \$\{to\}/);
    expect(figures).toMatch(/fc\.target_kind = 'expense' AND fc\.status = 'approved'\s+AND fc\.correction_date BETWEEN \$\{from\} AND \$\{to\}/);
    // A refund's confirmation is money only: it is not a sales figure.
    expect(figures).not.toMatch(/refund_payouts/);
  });

  it('Home, Money, sales by day, employees and product reports read it', () => {
    expect(src('analytics', 'dashboard.service.ts')).toMatch(/periodFigures\(this\.db, companyId, branchId, range\.from, range\.to\)/);
    expect(src('closing', 'closing.service.ts')).toMatch(/periodFigures\(this\.db, companyId, branchId, from, to\)/);
    expect(src('sales', 'sales.service.ts')).toMatch(/figuresByDay\(this\.db, companyId, branchId, from, to\)/);
    expect(src('analytics', 'dashboard.service.ts')).toMatch(/sellerFigures\(this\.db, this\.tenant\.companyId\(\), branchId, from, until\)/);
    expect(src('analytics', 'analytics.service.ts').match(/productAdjustments\(this\.db, this\.tenant\.companyId\(\), branchId, dayKey\(from\)\)/g)).toHaveLength(2);
  });

  it('Money\'s today\'s expenses follow the accounting-day rule and list reversals', () => {
    const closing = src('closing', 'closing.service.ts');
    expect(closing).toMatch(/\{ expenseClass: 'variable', confirmationDate: todayDate \},\s+\{ expenseClass: 'fixed', dueDate: todayDate \}/);
    expect(closing).toMatch(/targetKind: 'expense', status: 'approved', correctionDate: todayDate/);
  });
});
