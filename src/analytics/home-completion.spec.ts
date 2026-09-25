import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADJUSTMENT, METRIC_COLUMN, type GoalMetricKey } from '../goals/goal-progress';
import { localDateOf, localTimeOf } from '../common/business-day';

/**
 * Home's last checks, and the reporting rules they touch (docs/54).
 *
 *   D37  the units-sold goal = units sold − units on whole-sale cancellations − units returned,
 *        each subtraction on its approval date; the sales count keeps a returned item
 *   D39  sold in 30 days / last sold / not moving read the sales that stand, when asked
 *   D40  Home's arrivals carry the store's date and time, read in the store's timezone
 */

const SRC = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── D37: a branch units goal, the production expression evaluated per day and summed ──
const COLUMNS = ['qty_sold', 'sales_count', 'cancelled_qty', 'cancelled_count', 'returns_count'];
const goal = (metric: GoalMetricKey, days: Record<string, number>[]) => {
  const expr = `\`${METRIC_COLUMN[metric]}\` - (${ADJUSTMENT[metric]})`.replace(/`(\w+)`/g, 'row.$1');
  const f = new Function('row', `return ${expr};`) as (r: Record<string, number>) => number;
  return days.reduce((n, d) => n + f(Object.fromEntries(COLUMNS.map((c) => [c, d[c] ?? 0]))), 0);
};

describe('the units-sold goal takes returned units off on their approval day (D37)', () => {
  // Two phones sold on one invoice on D1.
  const sale = { qty_sold: 2, sales_count: 1 };

  it('a return approved the same day: 2 sold, 1 returned — 1 unit, and still 1 sale', () => {
    const d1 = { ...sale, returns_count: 1 };
    expect(goal('units_sold', [d1])).toBe(1);
    expect(goal('sales_count', [d1])).toBe(1);
  });

  it('a return approved on a later day: D1 keeps both units; D2, holding only the return, reads −1; together 1', () => {
    const d1 = sale;
    const d2 = { returns_count: 1 };
    expect([goal('units_sold', [d1]), goal('units_sold', [d2]), goal('units_sold', [d1, d2])]).toEqual([2, -1, 1]);
    // A returned item is not a cancelled invoice: the count does not move on D2.
    expect([goal('sales_count', [d1]), goal('sales_count', [d2]), goal('sales_count', [d1, d2])]).toEqual([1, 0, 1]);
  });

  it('a cancellation and a return together: each unit comes off once, on its own day', () => {
    const d1 = { qty_sold: 3, sales_count: 2 };
    const d2 = { cancelled_qty: 1, cancelled_count: 1 };
    const d3 = { returns_count: 1 };
    expect(goal('units_sold', [d1, d2, d3])).toBe(1);
    expect(goal('sales_count', [d1, d2, d3])).toBe(1);
  });

  it('a personal goal takes the seller\'s returned units the same way, one unit per return', () => {
    const goals = read('goals', 'goals.service.ts');
    expect(goals).toContain("units_sold: 'COUNT(*)',\n};");
    expect(goals).toMatch(/FROM return_reversals rr\s+JOIN sales s ON s\.id = rr\.sale_id\s+WHERE rr\.company_id = \$\{companyId\} AND \$\{person\}\s+AND rr\.approval_date BETWEEN \$\{from\} AND \$\{to\}/);
  });

  it('a return is one identified unit, so returns_count is the units returned', () => {
    const returns = read('returns', 'returns.service.ts');
    expect(returns).toMatch(/if \(!line\.unitId \|\| !line\.unit\) \{/);
    expect(read('sales', 'sales.service.ts')).toMatch(/unitId: unit\.id,\s+productId: unit\.productId,\s+quantity: 1,/);
  });
});

describe('movement is read from the sales that stand, when asked (D39)', () => {
  const movement = read('analytics', 'movement.ts');

  it('a cancelled sale is left out wherever it falls; the window is business dates ending today', () => {
    expect(movement).toMatch(/SUM\(CASE WHEN s\.business_date >= \$\{since\} THEN si\.quantity ELSE 0 END\)/);
    expect(movement).toMatch(/MAX\(s\.sold_at\) AS last_sold_at/);
    expect(movement).toMatch(/AND NOT EXISTS \(SELECT 1 FROM financial_corrections fc/);
    // A returned line stands: the return is its own event.
    expect(movement).not.toMatch(/return_reversals/);
  });

  it('the product report, "not moving" and the health score read it; nothing reads the old snapshot', () => {
    for (const f of ['analytics.service.ts', 'dashboard.service.ts', 'health.service.ts']) {
      const src = read('analytics', f);
      expect([f, /productMovement\(/.test(src), /productVelocity/.test(src)]).toEqual([f, true, false]);
    }
    expect(read('analytics', 'rollup.service.ts')).not.toMatch(/productVelocity|recomputeVelocity/);
    expect(read('analytics', 'dashboard.service.ts')).toMatch(/deadStockDays,\s+branchComparison,/);
  });
});

describe('Home\'s arrivals are the store\'s date and time (D40)', () => {
  it('an arrival late in the evening UTC is the next morning in a store at UTC+4, whatever the phone says', () => {
    const at = new Date('2026-09-24T21:30:00.000Z');
    expect([localDateOf(at, 'Asia/Dubai'), localTimeOf(at, 'Asia/Dubai')]).toEqual(['2026-09-25', '01:30']);
    expect([localDateOf(at, 'UTC'), localTimeOf(at, 'UTC')]).toEqual(['2026-09-24', '21:30']);
    expect([localDateOf(at, 'America/New_York'), localTimeOf(at, 'America/New_York')]).toEqual(['2026-09-24', '17:30']);
  });

  it('Home sends each arrival\'s store date and time, and the store\'s date now', () => {
    const dashboard = read('analytics', 'dashboard.service.ts');
    expect(dashboard).toMatch(/receivedLocalDate: localDateOf\(u\.dateIn, timezone\),\s+receivedLocalTime: localTimeOf\(u\.dateIn, timezone\),/);
    expect(dashboard).toMatch(/localDate: described\.localDate,/);
    expect(dashboard).toMatch(/this\.arrivals\(branchId, described\.timezone\)/);
  });
});
