import { ForbiddenException } from '@nestjs/common';
import { SalesService } from './sales.service';
import { SalesPolicyService } from './sales-policy.service';
import { ClosingService } from '../closing/closing.service';

/**
 * Selling below cost, through the real createSale (D223, 2026-10-27).
 *
 * No price floor: any seller may go below the suggested price at a profit. A
 * loss is open to `sale.below_cost` holders (Owner, Store Manager) after a
 * caution warning and with a reason; anyone else needs a consumed approval.
 * Fictional IMEI and prices.
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

function saleHarness(
  approval: { approvedPrice: number; belowCost: boolean } | null = null,
  permissions: string[] = [],
  gate: (input: any) => any = () => ({ ok: true }),
) {
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
  const consume: any = { consume: jest.fn(async () => approval) };
  const service = new SalesService(
    db,
    tenant,
    audit,
    new SalesPolicyService(),
    { resolveForSaleTx: jest.fn(async () => ({ price: SET_PRICE })) } as never,
    { next: jest.fn(async () => '00043') } as never,
    { emit: jest.fn() } as never,
    { get: (key: string) => (key === 'permissions' ? new Set(permissions) : undefined) } as never,
    consume,
    { configuredPrice: jest.fn(() => null), medianSalePrice: jest.fn(async () => null) } as never,
    { check: jest.fn(gate) } as never,
    businessDay,
    closing,
  );
  return { service, tx, consume };
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

const MANAGER = ['sale.create', 'sale.below_cost'];

describe('no price floor (D223)', () => {
  it('lets any seller sell below the suggested price while above cost, with no approval asked', async () => {
    const h = saleHarness();
    await h.service.createSale(sell({ price: 750 }, {}, 750) as never);
    expect(h.consume.consume).not.toHaveBeenCalled();
    expect(h.tx.sale.create).toHaveBeenCalledTimes(1);
  });
});

describe('a seller without sale.below_cost', () => {
  it('is refused below cost without an approval, and nothing is written', async () => {
    const h = saleHarness();
    const e = await refusalOf(h.service.createSale(sell({ price: 650 }, { overrideReason: 'display unit' }, 650) as never));
    expect(e).toBeInstanceOf(ForbiddenException);
    expect((e as ForbiddenException).getResponse()).toMatchObject({ code: 'approval_required', belowCost: true, identifier: IMEI });
    expect(h.tx.sale.create).not.toHaveBeenCalled();
  });

  it('sells with an approval for that price and a reason', async () => {
    const h = saleHarness({ approvedPrice: 650, belowCost: true });
    await h.service.createSale(sell({ price: 650 }, { overrideReason: 'display unit' }, 650) as never);
    expect(h.consume.consume).toHaveBeenCalledTimes(1);
    expect(h.tx.sale.create).toHaveBeenCalledTimes(1);
  });
});

describe('the Owner or a Store Manager (sale.below_cost)', () => {
  it('is warned first: a caution the gate must see acknowledged, before anything is written', async () => {
    let seen: any[] = [];
    const h = saleHarness(null, MANAGER, (input) => {
      seen = input.warnings;
      return { ok: false, response: { status: 'warnings_pending', warnings: input.warnings } };
    });
    const result: any = await h.service.createSale(sell({ price: 650 }, { overrideReason: 'display unit' }, 650) as never);
    expect(result).toMatchObject({ status: 'warnings_pending' });
    expect(seen).toEqual([expect.objectContaining({ code: 'loss.below_cost', severity: 'caution', field: 'lines.0.price', messageKey: 'warning.loss.belowCost' })]);
    // The cost is described, never quoted.
    expect(seen[0].reference).toEqual({ kind: 'unit_cost', amount: null, sample: null });
    expect(h.tx.sale.create).not.toHaveBeenCalled();
  });

  it('sells at a loss once the warning is acknowledged, with a reason and no approval', async () => {
    const h = saleHarness(null, MANAGER);
    await h.service.createSale(sell({ price: 650 }, { overrideReason: 'display unit' }, 650) as never);
    expect(h.consume.consume).not.toHaveBeenCalled();
    expect(h.tx.sale.create).toHaveBeenCalledTimes(1);
  });

  it('still gives a reason', async () => {
    const h = saleHarness(null, MANAGER);
    const e = await refusalOf(h.service.createSale(sell({ price: 650 }, {}, 650) as never));
    expect((e as any).getResponse()).toMatchObject({ code: 'reason_required' });
    expect(h.tx.sale.create).not.toHaveBeenCalled();
  });

  it('may discount below cost after the same warning, with a reason', async () => {
    const h = saleHarness(null, MANAGER);
    await h.service.createSale(sell({ price: SET_PRICE }, { saleDiscount: 300, overrideReason: 'display unit' }, 599) as never);
    expect(h.tx.sale.create).toHaveBeenCalledTimes(1);
  });

  it('is not warned at a profit', async () => {
    let seen: any[] = [];
    const h = saleHarness(null, MANAGER, (input) => ((seen = input.warnings), { ok: true }));
    await h.service.createSale(sell({ price: 750 }, {}, 750) as never);
    expect(seen).toEqual([]);
  });
});
