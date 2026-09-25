import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { grossRefundOf, settleRefund } from './return-workflow';

/**
 * The corrected accounting for an approved return (I2-CP4.1).
 *
 * CP4 shipped with `returns_cogs = 0` while a returned phone — held as
 * `faulty` — was excluded from every inventory figure. Those two together are
 * an immediate, full write-off of an asset the shop still owns, decided before
 * anyone has inspected the phone. That was never approved.
 *
 * The corrected treatment reverses the line's revenue, credits its immutable
 * COGS snapshot back, and reinstates that same cost as faulty/return-held
 * inventory value — kept entirely out of sellable stock.
 */

const SRC = join(__dirname);
const rollup = readFileSync(join(SRC, '..', 'analytics', 'rollup.service.ts'), 'utf8');
const heldValue = readFileSync(join(SRC, '..', 'analytics', 'held-value.ts'), 'utf8');
const analytics = readFileSync(join(SRC, '..', 'analytics', 'analytics.service.ts'), 'utf8');
const closing = readFileSync(join(SRC, '..', 'closing', 'closing.service.ts'), 'utf8');
const service = readFileSync(join(SRC, 'returns.service.ts'), 'utf8');

/**
 * The arithmetic, stated once and checked against the approved formula:
 *
 *   profit effect = − gross refund + adjustments + COGS credit
 *
 * Expressed as a positive reduction, which is how it is stored:
 *
 *   reduction = gross − adjustments − cogs
 */
const profitReduction = (gross: number, adjustments: number, cogs: number): number =>
  Math.round((gross - adjustments - cogs) * 100) / 100;

describe('the money, end to end', () => {
  // A phone sold for 1000 that cost 700, with 30 withheld for a used protector.
  const price = 1000;
  const cost = 700;
  const withheld = 30;

  const gross = grossRefundOf({ price, quantity: 1, discount: 0 });
  const { adjustmentTotal, netRefundDue } = settleRefund(gross, [{ totalAmount: withheld }]);

  it('refunds the customer gross minus what was kept', () => {
    expect(gross).toBe(1000);
    expect(adjustmentTotal).toBe(30);
    expect(netRefundDue).toBe(970);
  });

  /**
   * The point of the whole correction. Cumulative profit across the sale AND
   * its return must equal the adjustment income alone — not a loss of the
   * entire refund, which is what writing the asset off would produce.
   */
  it('leaves cumulative profit equal to the adjustments, and nothing else', () => {
    const saleProfit = price - cost; // +300
    const returnEffect = -gross + adjustmentTotal + cost; // −1000 + 30 + 700 = −270
    expect(saleProfit + returnEffect).toBe(withheld);
  });

  it('stores the profit effect as a positive reduction of that size', () => {
    expect(profitReduction(gross, adjustmentTotal, cost)).toBe(270);
    // And subtracting it from the sale's profit leaves the adjustments.
    expect(price - cost - profitReduction(gross, adjustmentTotal, cost)).toBe(withheld);
  });

  /**
   * The old treatment, kept here as the thing that must never come back: with
   * no COGS credit the shop appears to lose the entire net refund, which
   * silently impairs a phone nobody has looked at.
   */
  it('is materially better than the write-off it replaces', () => {
    const writeOffEffect = netRefundDue; // 970 — the CP4 behaviour
    const corrected = profitReduction(gross, adjustmentTotal, cost); // 270
    expect(corrected).toBeLessThan(writeOffEffect);
    expect(writeOffEffect - corrected).toBe(cost);
  });

  it('credits exactly the cost, so the asset and the credit are the same money', () => {
    // Counted once: the credit given here is the value reinstated as faulty
    // inventory, never a second benefit on top of it.
    expect(writeOffMinusCorrected(gross, adjustmentTotal, cost)).toBe(cost);
  });
});

function writeOffMinusCorrected(gross: number, adjustments: number, cogs: number): number {
  const netRefund = gross - adjustments;
  return Math.round((netRefund - profitReduction(gross, adjustments, cogs)) * 100) / 100;
}

describe('the rollup applies that formula', () => {
  it('credits the original immutable cost back, not zero', () => {
    expect(rollup).toMatch(/SUM\(line_cost\)[^A-Za-z]*AS cogs_credited/);
    // The CP4 mistake, gone.
    expect(rollup).not.toMatch(/const returnsCogs = 0;/);
  });

  it('reads gross and adjustments as separate components', () => {
    expect(rollup).toMatch(/SUM\(gross_refund\)/);
    expect(rollup).toMatch(/SUM\(adjustment_total\)/);
  });

  it('computes the reduction as gross − adjustments − cogs', () => {
    expect(rollup).toMatch(/returnsRevenue - returnsAdjustments - returnsCogs/);
  });

  it('still subtracts it explicitly from net profit', () => {
    // 0079: a cancelled sale's effect is subtracted beside the returns', explicitly too.
    expect(rollup).toMatch(/grossProfit - returnsGrossProfit - \(cancelledRevenue - cancelledCogs\) - expenses/);
  });

  it('takes the figures from the reversal snapshot, never from a live product', () => {
    // Scoped to the returns query: this file also builds per-product facts that
    // legitimately join products, and a file-wide assertion would be claiming
    // something that was never true.
    const start = rollup.indexOf('FROM return_reversals');
    expect(start).toBeGreaterThan(-1);
    const returnsQuery = rollup.slice(rollup.lastIndexOf('SELECT', start), rollup.indexOf('`', start));
    // `line_cost` is the cost as it was when the sale happened, not today's.
    expect(returnsQuery).not.toMatch(/JOIN/);
    expect(returnsQuery).toMatch(/line_cost/);
  });
});

describe('the asset is reinstated, not written off', () => {
  it('has a faulty/return-held valuation that counts returned and faulty units', () => {
    expect(heldValue).toMatch(/export async function faultyHeldValue/);
    expect(heldValue).toMatch(/u\.status IN \('returned', 'faulty'\)/);
  });

  it('uses the unit’s own cost — the same money credited to COGS', () => {
    expect(heldValue).toMatch(/SUM\(u\.cost\)/);
  });

  /**
   * Sellable value must never include a faulty phone: a dead-stock report that
   * did would offer a broken device for sale.
   */
  it('keeps sellable stock to in_stock only', () => {
    expect(heldValue).toMatch(/u\.status = 'in_stock'/);
  });

  it('reports sellable, faulty-held and total owned separately', () => {
    expect(analytics).toMatch(/sellableInventoryValue:/);
    expect(analytics).toMatch(/faultyHeldValue:/);
    expect(analytics).toMatch(/totalOwnedInventoryValue:/);
  });

  it('includes the faulty value in total owned exactly once', () => {
    expect(analytics).toMatch(
      /totalOwnedInventoryValue: round2\(\s*totals\.inventoryValue \+ transit\.value \+ faulty\.inventoryValue,?\s*\)/,
    );
  });

  it('leaves the travelling-stock guarantee alone', () => {
    // `totalStockValue` is documented as the number that must not move when
    // stock is merely travelling. Faulty value is a separate figure, not an
    // addition to that one.
    expect(analytics).toMatch(/totalStockValue: round2\(totals\.inventoryValue \+ transit\.value\)/);
  });
});

describe('the locked closing carries every component', () => {
  it('snapshots adjustments and the COGS credit as well as the totals', () => {
    expect(closing).toMatch(/totalReturnAdjustments/);
    expect(closing).toMatch(/totalReturnsCogsCredited/);
  });

  it('takes them from the rollup, which is the authoritative source', () => {
    expect(closing).toMatch(/rollup\?\.returnsAdjustments/);
    expect(closing).toMatch(/rollup\?\.returnsCogs/);
  });
});

describe('what approval and rejection each do', () => {
  it('approval snapshots the ORIGINAL line cost into the reversal', () => {
    expect(service).toMatch(/lineCost: num\(request\.saleItem\.cost\) \* request\.saleItem\.quantity/);
  });

  /**
   * A rejection creates no reversal, so there is no COGS credit and no faulty
   * asset — the phone goes back to the customer and the sale stands.
   */
  it('rejection creates no reversal at all', () => {
    const reject = service.slice(service.indexOf('async reject('), service.indexOf('// ─────────────────────────────── reads'));
    expect(reject).not.toMatch(/returnReversal\.create/);
    expect(reject).not.toMatch(/'faulty'/);
  });

  it('approval is still refused on a locked day', () => {
    expect(service).toMatch(/day_already_closed/);
  });
});
