import { ConflictException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SalesService } from './sales.service';
import { SalesPolicyService } from './sales-policy.service';
import { ClosingService } from '../closing/closing.service';
import { binToUuid } from '../common/utils/uuid.util';

/**
 * Open first: while the boutique's current business day is closed, a sale is
 * refused on the server — for every client, older app builds included — and it
 * never reopens the day by itself. Opening the store is the reopen.
 *
 * Driven through the real ClosingService checks: the plain read before anything
 * is spent, and the read under the day's row lock inside the sale's transaction.
 */

const COMPANY = Buffer.alloc(16, 1);
const BRANCH = Buffer.alloc(16, 2);
const USER = Buffer.alloc(16, 3);
const SALE = Buffer.alloc(16, 4);
const UNIT = Buffer.alloc(16, 5);
const PRODUCT = Buffer.alloc(16, 6);
const KEY = '11111111-2222-4333-8444-555555555555';
const IMEI = '490154203237518';
const DAY = '2026-09-27';
const NEXT = '2026-09-28';

type Status = 'counting' | 'counted' | 'locked' | 'reopened';

interface Setup {
  /** The sale this key already made, if any. */
  existing?: unknown;
  /** The branch's business day, which a sale made now is assigned to. */
  day?: string;
  /** Each date's closing status as a plain read sees it. */
  closings?: Record<string, Status>;
  /** Each date's closing status as the locking read sees it; the plain read's when not given. */
  locked?: Record<string, Status>;
}

function harness({ existing = null, day = DAY, closings = {}, locked = closings }: Setup = {}) {
  const lockReads: { sql: string; values: unknown[] }[] = [];
  const tx: any = {
    unit: {
      findFirst: async () => ({
        id: UNIT,
        productId: PRODUCT,
        branchId: BRANCH,
        status: 'in_stock',
        imeiPrimary: IMEI,
        serialNo: null,
        cost: 700,
        product: { defaultPrice: 899 },
      }),
      updateMany: async () => ({ count: 1 }),
    },
    companySettings: { findUnique: async () => ({ returnWindowHours: 0 }) },
    sale: { create: jest.fn(async () => ({})) },
    saleItem: { create: async () => ({}) },
    payment: { create: async () => ({}) },
    notification: { create: async () => ({}) },
    rollupRequest: { createMany: async () => ({}) },
    dailyClosing: { update: jest.fn(), updateMany: jest.fn() },
    closingEvent: { create: jest.fn() },
    $queryRaw: jest.fn(async (query: { sql: string; values: unknown[] }) => {
      lockReads.push(query);
      const status = locked[query.values.find((v) => typeof v === 'string') as string];
      return status ? [{ status }] : [];
    }),
  };
  const db: any = {
    sale: { findFirst: jest.fn(async () => existing), findUnique: async () => null },
    saleItem: { findMany: async () => [{ unitId: UNIT, productId: null, quantity: 1, price: 899 }] },
    payment: { findMany: async () => [{ method: 'cash', amount: 899 }] },
    unit: { findFirst: async ({ where }: any) => (where.OR.some((c: any) => Object.values(c)[0] === IMEI) ? { id: UNIT } : null) },
    dailyClosing: {
      findUnique: jest.fn(async ({ where }: any) => {
        const status = closings[(where.branchId_closingDate.closingDate as Date).toISOString().slice(0, 10)];
        return status ? { status } : null;
      }),
    },
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  };
  const tenant: any = { companyId: () => COMPANY, requireBranchId: () => BRANCH, userId: () => USER };
  const businessDay: any = { today: jest.fn(async () => day), assign: jest.fn(async () => day) };
  const audit: any = { recordTx: async () => ({}) };
  const closing = new ClosingService(db, tenant, audit, {} as never, {} as never, businessDay, {} as never, {} as never, {} as never);
  const spent = {
    approvals: { consume: jest.fn(async () => null) },
    magnitude: { configuredPrice: jest.fn(() => null), medianSalePrice: jest.fn(async () => null) },
    gate: { check: jest.fn(() => ({ ok: true })) },
    invoiceNumbers: { next: jest.fn(async () => '00043') },
    pricing: { resolveForSaleTx: jest.fn(async () => ({ price: 899 })) },
  };
  const events = { emit: jest.fn() };
  const service = new SalesService(
    db,
    tenant,
    audit,
    new SalesPolicyService(),
    spent.pricing as never,
    spent.invoiceNumbers as never,
    events as never,
    { get: () => new Set() } as never,
    spent.approvals as never,
    spent.magnitude as never,
    spent.gate as never,
    businessDay,
    closing,
  );
  return { service, db, tx, spent, events, lockReads };
}

const original = {
  id: SALE,
  invoiceNo: '00042',
  total: 899,
  margin: 199,
  balanceDue: 0,
  payStatus: 'paid',
  soldAt: new Date('2026-09-27T09:00:00Z'),
  returnWindowHours: 0,
  returnDeadlineAt: null,
  discount: 0,
};

const dto = { clientUuid: KEY, lines: [{ identifier: IMEI, price: 899 }], payments: [{ method: 'cash', amount: 899 }] };

async function refusal(run: () => Promise<unknown>): Promise<ConflictException> {
  let caught: unknown;
  try {
    await run();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ConflictException);
  return caught as ConflictException;
}

describe('a sale while the business day is closed', () => {
  it('is refused with the closed-store error before anything is spent — no warning, approval, number or transaction', async () => {
    const { service, db, spent } = harness({ closings: { [DAY]: 'locked' } });
    const e = await refusal(() => service.createSale(dto as never));
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toEqual({
      code: 'store_closed',
      businessDate: '2026-09-27',
      message: 'The store is closed for business day 2026-09-27. Nothing was sold: the Owner or a named delegate must open the store first.',
    });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(spent.pricing.resolveForSaleTx).not.toHaveBeenCalled();
    expect(spent.magnitude.medianSalePrice).not.toHaveBeenCalled();
    expect(spent.gate.check).not.toHaveBeenCalled();
    expect(spent.approvals.consume).not.toHaveBeenCalled();
    expect(spent.invoiceNumbers.next).not.toHaveBeenCalled();
  });

  it('is refused under the day’s lock when the day closed after the first check, and nothing reopens', async () => {
    const { service, db, tx, events, lockReads } = harness({ closings: {}, locked: { [DAY]: 'locked' } });
    const e = await refusal(() => service.createSale(dto as never));
    expect(e.getResponse()).toMatchObject({ code: 'store_closed' });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // Decided on the row the locking statement returned, not on a later plain read.
    expect(lockReads).toHaveLength(1);
    expect(lockReads[0].sql).toMatch(/SELECT status FROM daily_closings[\s\S]*FOR UPDATE/);
    expect(lockReads[0].values).toEqual([COMPANY, BRANCH, DAY]);
    expect(tx.dailyClosing.update).not.toHaveBeenCalled();
    expect(tx.dailyClosing.updateMany).not.toHaveBeenCalled();
    expect(tx.closingEvent.create).not.toHaveBeenCalled();
    // The transaction rolled back: the sale it began is not announced.
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe('a sale on a day the counter may use', () => {
  it.each([
    ['nobody has opened or counted yet', {}],
    ['is being counted', { [DAY]: 'counting' as const }],
    ['was counted but not closed', { [DAY]: 'counted' as const }],
    ['was closed and has been reopened', { [DAY]: 'reopened' as const }],
  ])('goes through on a day that %s', async (_label, closings) => {
    const { service, tx, events } = harness({ closings });
    const r = (await service.createSale(dto as never)) as { invoiceNo: string; businessDate: string };
    expect(r.invoiceNo).toBe('00043');
    expect(r.businessDate).toBe(DAY);
    expect(tx.sale.create).toHaveBeenCalledTimes(1);
    expect(tx.dailyClosing.update).not.toHaveBeenCalled();
    expect(tx.closingEvent.create).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith('sale.recorded', expect.objectContaining({ day: DAY }));
  });

  it('goes through on the next day the Owner started early, while the day left behind stays closed', async () => {
    const { service, lockReads } = harness({ day: NEXT, closings: { [DAY]: 'locked' } });
    const r = (await service.createSale(dto as never)) as { invoiceNo: string; businessDate: string };
    expect(r.businessDate).toBe(NEXT);
    expect(lockReads[0].values).toEqual([COMPANY, BRANCH, NEXT]);
  });
});

describe('a retry of a sale made before the close', () => {
  it('answers with the original sale, without reading the day or opening a transaction', async () => {
    const { service, db } = harness({ existing: original, closings: { [DAY]: 'locked' } });
    const r = (await service.createSale(dto as never)) as { id: string; invoiceNo: string };
    expect(r.id).toBe(binToUuid(SALE));
    expect(r.invoiceNo).toBe('00042');
    expect(db.dailyClosing.findUnique).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('still refuses a different sale under the same key as an idempotency conflict, not as a closed store', async () => {
    const { service, db } = harness({ existing: original, closings: { [DAY]: 'locked' } });
    const e = await refusal(() =>
      service.createSale({ ...dto, lines: [{ identifier: IMEI, price: 999 }], payments: [{ method: 'cash', amount: 999 }] } as never),
    );
    expect(e.getResponse()).toMatchObject({ code: 'idempotency_conflict' });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

/** Source without comments, so a pin never rests on prose. */
const code = (file: string) =>
  readFileSync(join(__dirname, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('the open-first rule in the source', () => {
  const sales = code('sales.service.ts');
  const closing = code('../closing/closing.service.ts');

  it('a sale never reopens the day: createSale calls no auto-reopen', () => {
    expect(sales).not.toMatch(/autoReopenTx/);
    expect(sales).toMatch(/await this\.closing\.assertCounterOpenTx\(tx, \{ branchId, businessDate, operation: 'sale' \}\);/);
  });

  it('asks whether the store is open after the replay and before the transaction', () => {
    const check = sales.indexOf("await this.closing.assertCounterOpen(branchId, 'sale');");
    expect(check).toBeGreaterThan(sales.indexOf('await this.assertReplayMatches(existing, dto);'));
    expect(check).toBeLessThan(sales.indexOf('this.db.$transaction('));
  });

  it('reads the day’s status in the locking statement itself', () => {
    const start = closing.indexOf('async assertCounterOpenTx(');
    const body = closing.slice(start, closing.indexOf('async afterSaleCommitted(', start));
    expect(body).toMatch(/SELECT status FROM daily_closings\s+WHERE company_id = \$\{companyId\} AND branch_id = \$\{args\.branchId\} AND closing_date = \$\{args\.businessDate\}\s+FOR UPDATE/);
    expect(body).not.toMatch(/dailyClosing\.find/);
  });

  it('no movement reopens a closed day any more: the automatic reopen is gone (docs/61)', () => {
    expect(closing).not.toMatch(/autoReopenTx|afterReopenCommitted|AutoReopenResult/);
    expect(code('sale-payments.service.ts')).not.toMatch(/autoReopenTx|afterReopenCommitted/);
  });
});
