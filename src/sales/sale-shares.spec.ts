import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromCents, lineShareCents, sharesBySale, toCents } from './sale-shares';

/**
 * A whole-invoice discount, on every reader (docs/54 D36).
 *
 * `sales.total` is what the customer was invoiced. Every reader that works per line
 * values a line at its share of that total, so the lines of a sale add up to it, a
 * cancellation takes off what the sale put on, and a return refunds no more than was
 * paid for the line.
 */

const id = (n: number) => Buffer.from([0, n]);
const line = (n: number, price: number, quantity = 1, discount = 0) => ({ id: id(n), price, quantity, discount });
const money = (shares: Map<string, bigint>) => [...shares.values()].map(fromCents);

describe('a line\'s share of the recorded invoice total', () => {
  it('without a whole-invoice discount, each line is its own net — unchanged from before', () => {
    const lines = [line(1, 10_000), line(2, 20, 2, 5)];
    expect(money(lineShareCents(lines, 10_035))).toEqual([10_000, 35]);
  });

  it('a whole-invoice discount is spread in proportion to what each line was invoiced at', () => {
    // A phone at 10 000 and two cables at 20, 1 000 off the invoice: 9 040 paid.
    const shares = lineShareCents([line(1, 10_000), line(2, 20, 2)], 9_040);
    expect(money(shares)).toEqual([9_003.98, 36.02]);
    expect(fromCents([...shares.values()].reduce((a, b) => a + b, 0n))).toBe(9_040);
  });

  it('the cents rounding leaves go to the largest line, the first created on a tie — the shares always add up to the total', () => {
    // 10 off three lines of 10: 6.67 × 3 = 20.01 — the extra cent comes off the first line.
    const three = lineShareCents([line(1, 10), line(2, 10), line(3, 10)], 20);
    expect(money(three)).toEqual([6.66, 6.67, 6.67]);
    for (const total of [0.01, 1, 99.99, 12_345.67, 19_000]) {
      const shares = lineShareCents([line(1, 7_000), line(2, 3_333.33, 3), line(3, 0.99, 7, 0.5)], total);
      expect(fromCents([...shares.values()].reduce((a, b) => a + b, 0n))).toBe(total);
    }
  });

  it('works in whole cents, so the same rows give the same share anywhere', () => {
    expect(toCents('10.10')).toBe(1010n);
    expect(toCents(0.1 + 0.2)).toBe(30n);
    expect(money(lineShareCents([line(1, 10.1, 3)], 30.3))).toEqual([30.3]);
  });

  it('shares are weighed within one sale, never across sales', () => {
    const rows = [
      { ...line(1, 10_000), saleId: Buffer.from('a'), saleTotal: 9_000 },
      { ...line(2, 10_000), saleId: Buffer.from('b'), saleTotal: 10_000 },
    ];
    expect(money(sharesBySale(rows))).toEqual([9_000, 10_000]);
  });
});

describe('every per-line reader uses it (source pins)', () => {
  const SRC = join(__dirname, '..');
  const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const rollup = read('analytics', 'rollup.service.ts');
  const figures = read('analytics', 'period-figures.ts');
  const returns = read('returns', 'returns.service.ts');
  const workflow = read('returns', 'return-workflow.ts');
  const closing = read('closing', 'closing.service.ts');
  const goals = read('goals', 'goals.service.ts');

  it('no reader values a line as price × quantity − discount any more', () => {
    for (const [name, src] of [['rollup', rollup], ['period-figures', figures], ['goals', goals], ['closing', closing], ['returns', returns]] as const) {
      expect([name, /price \* si\.quantity - si\.discount|price\) \* it\.quantity - num\(it\.discount\)/.test(src)]).toEqual([name, false]);
    }
  });

  it('the rollup values the day\'s lines, its products and its cancellations at their shares', () => {
    expect(rollup).toMatch(/const dayShares = sharesBySale\(shareLines\(dayLines\)\);/);
    expect(rollup).toMatch(/const rows = \[\.\.\.byProduct\.values\(\)\]\.map\(\(p\) => \(\{ \.\.\.p, \.\.\.lineTotals\(p\.lines, dayShares\) \}\)\);/);
    expect(rollup).toMatch(/const cancelled = lineTotals\(cancelledLines, sharesBySale\(shareLines\(cancelledLines\)\)\);/);
    expect(rollup).toMatch(/s\.total AS sale_total/);
  });

  it('the product report\'s cancelled lines, a return\'s refund and the closing digest take the same shares', () => {
    expect(figures).toMatch(/e\.cancelledRevenue = round2\(e\.cancelledRevenue \+ fromCents\(shares\.get\(l\.id\.toString\('hex'\)\) \?\? 0n\)\);/);
    expect(workflow).toMatch(/const cents = lineShareCents\(sale\.lines, sale\.total\)\.get\(lineId\.toString\('hex'\)\);/);
    expect(returns.match(/grossRefundOf\(/g)?.length).toBe(4);
    expect(returns).toMatch(/items: \{ where: \{ voided: false \}, select: \{ id: true, price: true, quantity: true, discount: true \} \}/);
    expect(closing).toMatch(/const salePrice = fromCents\(shares\.get\(it\.id\.toString\('hex'\)\) \?\? 0n\);/);
  });

  it('a personal goal reads the invoice total and its cost, per sale', () => {
    expect(goals).toContain("revenue: 'COALESCE(SUM(s.total), 0)'");
    expect(goals).toContain("gross_profit: 'COALESCE(SUM(s.total - s.total_cost), 0)'");
  });
});
