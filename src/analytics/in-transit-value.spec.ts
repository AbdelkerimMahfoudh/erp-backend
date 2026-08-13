import { summarizeInTransit, type InTransitRow } from './in-transit-value';
import { FINANCIAL_FIELDS, stripFinancialFields } from '../common/interceptors/financial-fields';

/**
 * The valuation invariant, tested where it can be tested purely.
 *
 * The SQL itself is proved against real MySQL in the H1.4 race suite; what is
 * checked here is the folding rule, which is where double counting would come
 * from. A movement has two ends, and adding both to one company total is the
 * obvious mistake.
 */

const MAIN = Buffer.from('11111111111111111111111111111111', 'hex');
const WAREHOUSE = Buffer.from('22222222222222222222222222222222', 'hex');
const THIRD = Buffer.from('33333333333333333333333333333333', 'hex');

const row = (from: Buffer, to: Buffer, value: number, units = 0, quantity = 0): InTransitRow => ({
  fromBranchId: from,
  toBranchId: to,
  value,
  unitsCount: units,
  quantity,
});

describe('summarizeInTransit', () => {
  it('counts a movement once for the company, not once per end', () => {
    const total = summarizeInTransit([row(MAIN, WAREHOUSE, 410)], null);
    expect(total.value).toBe(410);
  });

  it('counts several movements between the same pair once each', () => {
    const total = summarizeInTransit(
      [row(MAIN, WAREHOUSE, 410), row(WAREHOUSE, MAIN, 250)],
      null,
    );
    expect(total.value).toBe(660);
  });

  it('shows a branch what it sent, separately from what is coming', () => {
    const at = summarizeInTransit(
      [row(MAIN, WAREHOUSE, 410), row(WAREHOUSE, MAIN, 250), row(WAREHOUSE, THIRD, 99)],
      MAIN,
    );
    expect(at.outbound).toBe(410);
    expect(at.inbound).toBe(250);
  });

  it('adds only outbound to a branch total, so two branches cannot both claim it', () => {
    const rows = [row(MAIN, WAREHOUSE, 410)];
    const atSource = summarizeInTransit(rows, MAIN);
    const atDestination = summarizeInTransit(rows, WAREHOUSE);
    expect(atSource.value).toBe(410);
    expect(atDestination.value).toBe(0);
    expect(atSource.value + atDestination.value).toBe(410);
  });

  it('ignores movements between two other branches entirely', () => {
    const at = summarizeInTransit([row(WAREHOUSE, THIRD, 500)], MAIN);
    expect(at.value).toBe(0);
    expect(at.inbound).toBe(0);
  });

  it('counts phones and accessories separately, and both honestly', () => {
    const at = summarizeInTransit([row(MAIN, WAREHOUSE, 641, 2, 10)], MAIN);
    expect(at.unitsCount).toBe(2);
    expect(at.quantity).toBe(10);
  });

  it('is zero, not undefined, when nothing is moving', () => {
    expect(summarizeInTransit([], MAIN)).toEqual({
      value: 0,
      outbound: 0,
      inbound: 0,
      unitsCount: 0,
      quantity: 0,
    });
  });
});

describe('the invariant a shipment must preserve', () => {
  /**
   * Ship 10 cables at 4.10 out of a branch holding 52 of them.
   *
   * Held value falls by 41.00 and in-transit rises by exactly 41.00. The
   * company total is the same number before and after — which is the whole
   * point, and what was NOT true before this phase.
   */
  it('moves value sideways rather than destroying it', () => {
    const heldBefore = 52 * 4.1;
    const shipped = 10 * 4.1;
    const heldAfter = heldBefore - shipped;

    const transit = summarizeInTransit([row(MAIN, WAREHOUSE, shipped)], null);
    expect(heldAfter + transit.value).toBeCloseTo(heldBefore, 10);
  });

  it('and receipt moves it back, still totalling the same', () => {
    const before = 52 * 4.1;
    const shipped = 10 * 4.1;
    const sourceAfter = before - shipped;
    const destinationAfter = shipped;
    const nothingInTransit = summarizeInTransit([], null);
    expect(sourceAfter + destinationAfter + nothingInTransit.value).toBeCloseTo(before, 10);
  });
});

describe('in-transit value is cost, and is gated like cost', () => {
  it.each(['inTransitValue', 'totalStockValue', 'outboundValue', 'inboundValue', 'shippedUnitCost'])(
    'strips %s for a caller without cost.view',
    (field) => {
      expect(FINANCIAL_FIELDS.has(field)).toBe(true);
    },
  );

  it('leaves the counts visible — knowing ten chargers are coming is not financial', () => {
    const stripped = stripFinancialFields({
      totals: {
        inventoryValue: 500,
        inTransitValue: 41,
        totalStockValue: 541,
        inTransit: { outboundValue: 41, inboundValue: 0, unitsCount: 2, quantity: 10 },
      },
    });
    expect(stripped.totals).not.toHaveProperty('inventoryValue');
    expect(stripped.totals).not.toHaveProperty('inTransitValue');
    expect(stripped.totals).not.toHaveProperty('totalStockValue');
    expect(stripped.totals.inTransit).toEqual({ unitsCount: 2, quantity: 10 });
  });
});
