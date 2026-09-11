import { readFileSync } from 'node:fs';
import { buildStockSummary, type SummaryInputs } from './stock-summary';
import { isLowStock, LOW_STOCK_DEFAULT, LOW_STOCK_SETTING } from './low-stock';

/**
 * The Stock screen's rows: one per exact variant, what it sells for, how many
 * can be sold today, and whether that is low.
 *
 * Every assertion here is about a way this could quietly lie — one phone's
 * override shown as every phone's price, colours folded together, reserved
 * goods counted as sellable, an unpriced line read as free, a cost figure
 * riding along into a screen every role opens.
 */

const b = (n: number) => Buffer.from(n.toString(16).padStart(32, '0'), 'hex');
const BRANCH = b(1);
const OTHER = b(2);

const IPHONE_BLACK = b(100);
const IPHONE_BLUE = b(101);
const CABLE = b(102);
const TV = b(103);

function inputs(over: Partial<SummaryInputs> = {}): SummaryInputs {
  return {
    activeBranchId: BRANCH,
    threshold: 3,
    products: [
      { id: IPHONE_BLACK, brand: 'Apple', model: 'iPhone 17', variant: '256 GB · Black', barcode: null, trackingType: 'imei', specifications: null, defaultPrice: 40000 },
      { id: IPHONE_BLUE, brand: 'Apple', model: 'iPhone 17', variant: '256 GB · Blue', barcode: null, trackingType: 'imei', specifications: null, defaultPrice: 40000 },
      { id: CABLE, brand: 'Anker', model: 'USB-C Cable', variant: '1 m', barcode: '6901', trackingType: 'quantity', specifications: null, defaultPrice: 300 },
      { id: TV, brand: 'Sony', model: 'Bravia', variant: '55"', barcode: null, trackingType: 'serial', specifications: null, defaultPrice: null },
    ],
    units: [],
    overrides: [],
    branchVariants: [],
    stockItems: [],
    ...over,
  };
}

const unit = (n: number, productId: Buffer, branchId = BRANCH) => ({ id: b(1000 + n), productId, branchId });

describe('one row per exact variant', () => {
  it('keeps colours apart rather than folding them into the model', () => {
    const rows = buildStockSummary(
      inputs({ units: [unit(1, IPHONE_BLACK), unit(2, IPHONE_BLACK), unit(3, IPHONE_BLUE)] }),
    );
    expect(rows.map((r) => [r.variant, r.available])).toEqual([
      ['256 GB · Black', 2],
      ['256 GB · Blue', 1],
    ]);
  });

  it('lists a serialized product only when a unit is on the shelf', () => {
    // The service passes in_stock units only; a variant with none has no row,
    // exactly as the dashboard's low-stock list never lists it.
    expect(buildStockSummary(inputs())).toEqual([]);
  });

  it('categorises by tracking type', () => {
    const rows = buildStockSummary(
      inputs({
        units: [unit(1, IPHONE_BLACK), unit(2, TV)],
        stockItems: [{ productId: CABLE, quantity: 10, reservedQuantity: 0, price: 350, version: 1 }],
      }),
    );
    const byModel = Object.fromEntries(rows.map((r) => [r.model, r.category]));
    expect(byModel).toEqual({ 'iPhone 17': 'phone', 'USB-C Cable': 'accessory', Bravia: 'other' });
  });
});

describe('selling price, through the sale\'s own ladder', () => {
  it('uses the branch variant price when there is one', () => {
    const rows = buildStockSummary(
      inputs({
        units: [unit(1, IPHONE_BLACK), unit(2, IPHONE_BLACK)],
        branchVariants: [{ productId: IPHONE_BLACK, price: 42000, version: 3 }],
      }),
    );
    expect(rows[0].price).toEqual({ min: 42000, max: 42000, pricedCount: 2, unpricedCount: 0 });
  });

  it('shows a RANGE when one phone has its own price', () => {
    /*
     * The lie this prevents: one handset marked down to 39 000 while its twin
     * sells for 42 000, and the list showing a single number for both.
     */
    const rows = buildStockSummary(
      inputs({
        units: [unit(1, IPHONE_BLACK), unit(2, IPHONE_BLACK)],
        branchVariants: [{ productId: IPHONE_BLACK, price: 42000, version: 3 }],
        overrides: [{ unitId: b(1001), price: 39000, version: 1, branchId: BRANCH }],
      }),
    );
    expect(rows[0].price).toEqual({ min: 39000, max: 42000, pricedCount: 2, unpricedCount: 0 });
  });

  it('ignores an override set in another branch, as the sale would', () => {
    const rows = buildStockSummary(
      inputs({
        units: [unit(1, IPHONE_BLACK)],
        branchVariants: [{ productId: IPHONE_BLACK, price: 42000, version: 3 }],
        overrides: [{ unitId: b(1001), price: 1, version: 1, branchId: OTHER }],
      }),
    );
    expect(rows[0].price).toEqual({ min: 42000, max: 42000, pricedCount: 1, unpricedCount: 0 });
  });

  it('says nothing is priced rather than inventing a zero', () => {
    const rows = buildStockSummary(inputs({ units: [unit(1, TV)] }));
    expect(rows[0].price).toBeNull();
  });

  it('counts unpriced units separately from priced ones', () => {
    const products = inputs().products.map((p) => (p.id.equals(IPHONE_BLACK) ? { ...p, defaultPrice: null } : p));
    const rows = buildStockSummary(
      inputs({
        products,
        units: [unit(1, IPHONE_BLACK), unit(2, IPHONE_BLACK)],
        overrides: [{ unitId: b(1001), price: 39000, version: 1, branchId: BRANCH }],
      }),
    );
    expect(rows[0].price).toEqual({ min: 39000, max: 39000, pricedCount: 1, unpricedCount: 1 });
  });

  it('falls back to the product default for an unpriced stock line, never to free', () => {
    const rows = buildStockSummary(
      inputs({ stockItems: [{ productId: CABLE, quantity: 10, reservedQuantity: 0, price: null, version: 0 }] }),
    );
    expect(rows[0].price).toEqual({ min: 300, max: 300, pricedCount: 10, unpricedCount: 0 });
  });
});

describe('available and low', () => {
  it('does not count reserved goods as sellable', () => {
    const rows = buildStockSummary(
      inputs({ stockItems: [{ productId: CABLE, quantity: 10, reservedQuantity: 4, price: 350, version: 1 }] }),
    );
    expect(rows[0].available).toBe(6);
  });

  it('keeps an empty stock line visible, available zero and low', () => {
    const rows = buildStockSummary(
      inputs({ stockItems: [{ productId: CABLE, quantity: 0, reservedQuantity: 0, price: 350, version: 1 }] }),
    );
    expect(rows[0]).toMatchObject({ available: 0, lowStock: true });
  });

  it('is low AT the threshold, not only below it', () => {
    const at = buildStockSummary(inputs({ units: [unit(1, IPHONE_BLACK), unit(2, IPHONE_BLACK), unit(3, IPHONE_BLACK)] }));
    const above = buildStockSummary(
      inputs({ units: [1, 2, 3, 4].map((n) => unit(n, IPHONE_BLACK)) }),
    );
    expect(at[0].lowStock).toBe(true);
    expect(above[0].lowStock).toBe(false);
  });

  it('compares quantity stock on the PHYSICAL figure, as the dashboard does', () => {
    // 5 physical, 3 reserved: 2 available, but the dashboard's rule has always
    // been physical quantity, and two screens must not disagree about "low".
    const rows = buildStockSummary(
      inputs({ stockItems: [{ productId: CABLE, quantity: 5, reservedQuantity: 3, price: 350, version: 1 }] }),
    );
    expect(rows[0]).toMatchObject({ available: 2, lowStock: false });
  });
});

describe('what the row never carries', () => {
  it('has no cost or margin in any shape', () => {
    const rows = buildStockSummary(
      inputs({
        units: [unit(1, IPHONE_BLACK)],
        stockItems: [{ productId: CABLE, quantity: 10, reservedQuantity: 0, price: 350, version: 1 }],
      }),
    );
    const json = JSON.stringify(rows).toLowerCase();
    for (const forbidden of ['cost', 'margin', 'profit', 'inventoryvalue']) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('carries no unit ids or identifiers — those stay on the unit list', () => {
    const rows = buildStockSummary(inputs({ units: [unit(1, IPHONE_BLACK)] }));
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['available', 'barcode', 'brand', 'category', 'lowStock', 'lowStockThreshold', 'model', 'price', 'productId', 'specifications', 'trackingType', 'variant'].sort(),
    );
  });
});

describe('one definition of low', () => {
  it('is the shop setting, inclusive', () => {
    expect(LOW_STOCK_SETTING).toBe('low_stock_threshold');
    expect(LOW_STOCK_DEFAULT).toBe(3);
    expect(isLowStock(3, 3)).toBe(true);
    expect(isLowStock(4, 3)).toBe(false);
  });

  it('is the one the dashboard uses', () => {
    const dashboard = readFileSync('src/analytics/dashboard.service.ts', 'utf8');
    expect(dashboard).toMatch(/LOW_STOCK_SETTING/);
    expect(dashboard).toMatch(/isLowStock\(/);
  });
});
