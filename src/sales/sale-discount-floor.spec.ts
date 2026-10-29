import { ForbiddenException } from '@nestjs/common';
import { SalesService } from './sales.service';
import { SalesPolicyService } from './sales-policy.service';
import { ClosingService } from '../closing/closing.service';

/**
 * A discount may not take a line below its cost (BE4-01).
 *
 * The floor loop judged each line's unit price, and the line and whole-sale
 * discounts came off afterwards: a phone costing 700, priced at its set price
 * of 899 with a discount of 300, sold for 599 with no approval and no reason.
 * Through the real createSale and a fake transaction: refused, and nothing is
 * written.
 */

const COMPANY = Buffer.alloc(16, 1);
const BRANCH = Buffer.alloc(16, 2);
const USER = Buffer.alloc(16, 3);
const UNIT = Buffer.alloc(16, 5);
const PRODUCT = Buffer.alloc(16, 6);
const KEY = '11111111-2222-4333-8444-555555555555';
const IMEI = '490154203237518';
const DAY = '2026-10-16';
const COST = 700;
const SET_PRICE = 899;

function saleHarness(approval: { approvedPrice: number; belowCost: boolean } | null = null) {
  const tx: any = {
    unit: {
      findFirst: async () => ({ id: UNIT, productId: PRODUCT, branchId: BRANCH, status: 'in_stock', imeiPrimary: IMEI, serialNo: null, cost: COST, product: { defaultPrice: SET_PRICE } }),
      updateMany: async () => ({ count: 1 }),
    },
    companySettings: { findUnique: async () => ({ returnWindowHours: 0 }) },
    // 0108: the branch has no policy of its own, so the company's window applies.
    branchReturnPolicy: { findFirst: async () => null },
    // 0111: the names the receipt is issued under.
    company: { findUnique: async () => ({ name: 'Boutique Kiffa', nameAr: null }) },
    branch: { findUnique: async () => ({ name: 'Centre', nameAr: 'المركز' }) },
    user: { findUnique: async () => ({ name: 'Aminetou', nameAr: 'أمينتو' }) },
    sale: { create: jest.fn(async () => ({})) },
    saleItem: { create: async () => ({}) },
    payment: { create: jest.fn(async () => ({})) },
    receivingAccount: { findFirst: async () => null },
    notification: { create: async () => ({}) },
    rollupRequest: { createMany: async () => ({}) },
    dailyClosing: { update: jest.fn(), updateMany: jest.fn() },
    closingEvent: { create: jest.fn() },
    $queryRaw: jest.fn(async (query: { sql: string }) => (/FROM closing_events/.test(query.sql) ? [{ one: 1 }] : [])),
    $executeRaw: jest.fn(async () => 1),
  };
  const db: any = {
    closingEvent: { findFirst: jest.fn(async () => ({ id: Buffer.alloc(16, 7) })) },
    sale: { findFirst: jest.fn(async () => null), findUnique: async () => null },
    dailyClosing: { findUnique: jest.fn(async () => null) },
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  };
  const tenant: any = { companyId: () => COMPANY, requireBranchId: () => BRANCH, userId: () => USER };
  const businessDay: any = { today: jest.fn(async () => DAY), assign: jest.fn(async () => DAY) };
  const audit: any = { recordTx: jest.fn(async () => undefined) };
  const closing = new ClosingService(db, tenant, audit, {} as never, {} as never, businessDay, {} as never, {} as never, {} as never);
  const service = new SalesService(
    db,
    tenant,
    audit,
    new SalesPolicyService(),
    { resolveForSaleTx: jest.fn(async () => ({ price: SET_PRICE })) } as never,
    { next: jest.fn(async () => '00043') } as never,
    { emit: jest.fn() } as never,
    { get: () => new Set() } as never,
    { consume: jest.fn(async () => approval) } as never,
    { configuredPrice: jest.fn(() => null), medianSalePrice: jest.fn(async () => null) } as never,
    { check: jest.fn(() => ({ ok: true })) } as never,
    businessDay,
    closing,
  );
  return { service, tx };
}

const sell = (line: Record<string, unknown>, extra: Record<string, unknown> = {}, paid: number) => ({
  clientUuid: KEY,
  lines: [{ identifier: IMEI, ...line }],
  payments: [{ method: 'cash', amount: paid }],
  ...extra,
});

async function refusalOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('a discount is measured against cost on what the line actually sells for (BE4-01)', () => {
  it('a whole-sale discount taking the set price below cost is refused, and nothing is written', async () => {
    const h = saleHarness();
    const e = await refusalOf(h.service.createSale(sell({ price: SET_PRICE }, { saleDiscount: 300 }, 599) as never));
    expect(e).toBeInstanceOf(ForbiddenException);
    expect((e as ForbiddenException).getResponse()).toMatchObject({ code: 'discount_below_cost', lineIndex: 0, identifier: IMEI });
    expect(h.tx.sale.create).not.toHaveBeenCalled();
    expect(h.tx.payment.create).not.toHaveBeenCalled();
  });

  it('a line discount taking the set price below cost is refused the same way', async () => {
    const h = saleHarness();
    const e = await refusalOf(h.service.createSale(sell({ price: SET_PRICE, discount: 300 }, {}, 599) as never));
    expect((e as ForbiddenException).getResponse()).toMatchObject({ code: 'discount_below_cost' });
    expect(h.tx.sale.create).not.toHaveBeenCalled();
  });

  it('an approval names one final price: a discount on top of an approved below-cost price is refused', async () => {
    const h = saleHarness({ approvedPrice: 650, belowCost: true });
    const e = await refusalOf(
      h.service.createSale(sell({ price: 650 }, { saleDiscount: 50, overrideReason: 'display unit' }, 600) as never),
    );
    expect((e as ForbiddenException).getResponse()).toMatchObject({ code: 'discount_below_cost' });
    expect(h.tx.sale.create).not.toHaveBeenCalled();
  });

  it('the approved below-cost price itself, with no discount, still sells', async () => {
    const h = saleHarness({ approvedPrice: 650, belowCost: true });
    await h.service.createSale(sell({ price: 650 }, { overrideReason: 'display unit' }, 650) as never);
    expect(h.tx.sale.create).toHaveBeenCalledTimes(1);
  });

  it('a discount that keeps the line at or above cost is not this rule’s business', async () => {
    for (const saleDiscount of [100, SET_PRICE - COST]) {
      const h = saleHarness();
      await h.service.createSale(sell({ price: SET_PRICE }, { saleDiscount }, SET_PRICE - saleDiscount) as never);
      expect(h.tx.sale.create).toHaveBeenCalledTimes(1);
    }
  });
});

describe('per line, never on the sale’s total margin', () => {
  const policy = new SalesPolicyService();
  const where = (index: number) => ({ index, unitId: null, identifier: null });

  it('a healthy line cannot pay for a whole-sale discount that sinks another below its cost', () => {
    // An accessory 1 000 (cost 100) and a phone 10 000 (cost 9 500); 1 100 off the invoice. The sale still makes
    // 300, but the phone's share of the 9 900 total is 9 000 — 500 under its cost.
    const lines = [
      { price: 1000, quantity: 1, discount: 0, cost: 100 },
      { price: 10000, quantity: 1, discount: 0, cost: 9500 },
    ];
    let e: unknown;
    try {
      policy.assertDiscountsKeepCost(lines, 9900, where);
    } catch (err) {
      e = err;
    }
    expect((e as ForbiddenException).getResponse()).toMatchObject({ code: 'discount_below_cost', lineIndex: 1 });
    expect(() => policy.assertDiscountsKeepCost(lines, 10900, where)).not.toThrow();
  });

  it('quantity lines are weighed on the whole line: 3 × 200 at cost 150 may take 150 off, not 151', () => {
    const line = [{ price: 200, quantity: 3, discount: 150, cost: 150 }];
    expect(() => policy.assertDiscountsKeepCost(line, 450, where)).not.toThrow();
    expect(() => policy.assertDiscountsKeepCost([{ ...line[0], discount: 151 }], 449, where)).toThrow(ForbiddenException);
  });
});
