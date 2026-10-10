import { ConflictException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PurchasingService } from './purchasing.service';
import { ClosingService } from '../closing/closing.service';
import { uuidToBin } from '../common/utils/uuid.util';

/**
 * Open first: while the boutique's current business day is closed, a receipt is
 * refused on the server — for every client, older app builds included — and its
 * payment never reopens the day by itself. Opening the store is the reopen.
 *
 * Driven through the real ClosingService checks: the plain read before anything
 * is looked up, and the read under the day's row lock inside the receipt's
 * transaction.
 */

const COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c001');
const BRANCH = uuidToBin('018f0000-0000-7000-8000-0000000000b1');
const PRODUCT = '018f0000-0000-7000-8000-00000000a001';
const KEY = '018f0000-0000-7000-8000-00000000e001';
const IMEI = '356888000000001';
const DAY = '2026-09-27';
const NEXT = '2026-09-28';

type Status = 'counting' | 'counted' | 'locked' | 'reopened';

const delivery = (over: Record<string, unknown> = {}) =>
  ({ clientUuid: KEY, paymentMethod: 'cash', items: [{ productId: PRODUCT, unitCost: 1500, identifiers: [IMEI] }], ...over }) as never;

/**
 * `closings` is each date's status as a plain read sees it and `locked` as the
 * locking read sees it (the plain read's unless given); both can change between
 * calls, as a close would change them.
 */
function harness(day = DAY) {
  const state = {
    closings: {} as Record<string, Status>,
    locked: null as Record<string, Status> | null,
    /** Dates nobody opened (docs/63) as the plain read sees them, and as the read inside the transaction does. */
    unopened: [] as string[],
    unopenedInside: null as string[] | null,
  };
  const stored: any[] = [];
  const lockReads: { sql: string; values: unknown[] }[] = [];
  const bumps: { sql: string; values: unknown[] }[] = [];
  const writes = { purchases: [] as any[], payments: [] as any[], units: [] as any[] };
  const tx: any = {
    purchase: { create: async ({ data }: any) => void writes.purchases.push(data) },
    purchaseItem: { create: async () => ({}) },
    supplierPayment: { create: async ({ data }: any) => void writes.payments.push(data) },
    rollupRequest: { createMany: async () => ({}) },
    dailyClosing: { update: jest.fn(), updateMany: jest.fn() },
    closingEvent: { create: jest.fn() },
    $queryRaw: jest.fn(async (query: { sql: string; values: unknown[] }) => {
      const date = query.values.find((v) => typeof v === 'string') as string;
      if (/FROM closing_events/.test(query.sql)) return (state.unopenedInside ?? state.unopened).includes(date) ? [] : [{ one: 1 }];
      lockReads.push(query);
      const status = (state.locked ?? state.closings)[date];
      return status ? [{ status }] : [];
    }),
    // The day's money version (D159): moved under the same lock once the day is found open.
    $executeRaw: jest.fn(async (query: { sql: string; values: unknown[] }) => {
      bumps.push(query);
      return 1;
    }),
  };
  const db: any = {
    closingEvent: {
      findFirst: jest.fn(async ({ where }: any) =>
        state.unopened.includes((where.businessDate as Date).toISOString().slice(0, 10)) ? null : { id: Buffer.alloc(16, 7) },
      ),
    },
    purchase: {
      findFirst: jest.fn(async ({ where }: any) => stored.find((p) => p.clientUuid.equals(where.clientUuid)) ?? null),
    },
    receivingAccount: { findFirst: jest.fn(async () => null) },
    product: { findMany: jest.fn(async () => [{ id: uuidToBin(PRODUCT), trackingType: 'imei', defaultPrice: 2000 }]) },
    dailyClosing: {
      findUnique: jest.fn(async ({ where }: any) => {
        const status = state.closings[(where.branchId_closingDate.closingDate as Date).toISOString().slice(0, 10)];
        return status ? { status } : null;
      }),
    },
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => {
      // All or nothing: what the transaction wrote survives only if it returns.
      const before = { purchases: writes.purchases.length, payments: writes.payments.length, units: writes.units.length };
      try {
        const result = await fn(tx);
        const data = writes.purchases[writes.purchases.length - 1];
        stored.push({
          ...data,
          items: [{ productId: uuidToBin(PRODUCT) }],
          units: [{ id: Buffer.alloc(16, 9), productId: uuidToBin(PRODUCT), imeiPrimary: IMEI, serialNo: null }],
        });
        return result;
      } catch (e) {
        writes.purchases.length = before.purchases;
        writes.payments.length = before.payments;
        writes.units.length = before.units;
        throw e;
      }
    }),
  };
  const inventory: any = {
    findExistingIdentifiers: jest.fn(async () => new Set()),
    findVoidedUnits: jest.fn(async () => new Map()),
    createUnit: jest.fn(async (_tx: unknown, data: any) => void writes.units.push(data)),
  };
  const strategies: any = {
    get: () => ({
      perUnit: true,
      identifierField: 'imeiPrimary',
      identifierLabel: 'IMEI',
      validateIdentifier: () => ({ ok: true }),
      normalize: (v: string) => v,
      recognitionKey: () => null,
    }),
  };
  const tenant: any = { companyId: () => COMPANY, requireBranchId: () => BRANCH, userId: () => null };
  const businessDay: any = { today: jest.fn(async () => day), assign: jest.fn(async () => day) };
  const audit: any = { recordTx: async () => ({}) };
  const closing = new ClosingService(db, tenant, audit, {} as never, {} as never, businessDay, {} as never, {} as never, {} as never);
  const service = new PurchasingService(
    db,
    tenant,
    audit,
    inventory,
    { emit: async () => ({}) } as never,
    strategies,
    {} as never,
    { enqueueTx: async () => ({}), processNow: async () => ({}) } as never,
    { processNow: async () => undefined } as never,
    businessDay,
    closing,
  );
  return { service, state, db, tx, inventory, writes, lockReads, bumps };
}

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

describe('a receipt while the business day is closed', () => {
  it('is refused with the closed-store error before any account, product or identifier is looked up', async () => {
    const { service, state, db, inventory, writes } = harness();
    state.closings = { [DAY]: 'locked' };
    const e = await refusal(() => service.createPurchase(delivery({ paymentMethod: 'mobile', receivingAccountId: KEY })));
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toEqual({
      code: 'store_closed',
      closedReason: 'closed',
      businessDate: '2026-09-27',
      message: 'The store is closed for business day 2026-09-27. Nothing was received: the Owner or a named delegate must open the store first.',
    });
    expect(db.receivingAccount.findFirst).not.toHaveBeenCalled();
    expect(db.product.findMany).not.toHaveBeenCalled();
    expect(inventory.findExistingIdentifiers).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(writes.purchases).toHaveLength(0);
  });

  it('is refused even when every line would have been rejected, rather than answered as an empty receipt', async () => {
    const { service, state, db } = harness();
    state.closings = { [DAY]: 'locked' };
    db.product.findMany.mockResolvedValue([]);
    const e = await refusal(() => service.createPurchase(delivery()));
    expect(e.getResponse()).toMatchObject({ code: 'store_closed' });
  });

  it('is refused under the day’s lock when the day closed after the first check: rolled back, not retried, nothing reopened', async () => {
    const { service, state, db, tx, writes, lockReads, bumps } = harness();
    state.locked = { [DAY]: 'locked' };
    const e = await refusal(() => service.createPurchase(delivery()));
    expect(e.getResponse()).toMatchObject({ code: 'store_closed' });
    // A refusal is not a lock conflict: the retry wrapper runs the transaction once.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(lockReads).toHaveLength(1);
    expect(lockReads[0].sql).toMatch(/SELECT status FROM daily_closings[\s\S]*FOR UPDATE/);
    expect(lockReads[0].values).toEqual([COMPANY, BRANCH, DAY]);
    expect(tx.dailyClosing.update).not.toHaveBeenCalled();
    expect(tx.dailyClosing.updateMany).not.toHaveBeenCalled();
    expect(tx.closingEvent.create).not.toHaveBeenCalled();
    // A refused receipt moves no money: the day's money version stays as the close read it (D159).
    expect(bumps).toEqual([]);
    expect(writes.purchases).toHaveLength(0);
    expect(writes.payments).toHaveLength(0);
    expect(writes.units).toHaveLength(0);
  });
});

describe('a receipt on a day nobody has opened (docs/63)', () => {
  it('is refused as not opened before any account, product or identifier is looked up', async () => {
    const { service, state, db, writes } = harness();
    state.unopened = [DAY];
    const e = await refusal(() => service.createPurchase(delivery()));
    expect(e.getResponse()).toMatchObject({ code: 'store_closed', closedReason: 'not_opened', businessDate: DAY });
    expect(db.receivingAccount.findFirst).not.toHaveBeenCalled();
    expect(db.product.findMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(writes.purchases).toHaveLength(0);
  });

  it('is refused inside the transaction when the day reads unopened there: rolled back, nothing written', async () => {
    const { service, state, writes } = harness();
    state.unopenedInside = [DAY];
    const e = await refusal(() => service.createPurchase(delivery()));
    expect(e.getResponse()).toMatchObject({ code: 'store_closed', closedReason: 'not_opened' });
    expect(writes.purchases).toHaveLength(0);
    expect(writes.payments).toHaveLength(0);
    expect(writes.units).toHaveLength(0);
  });
});

describe('a receipt on a day the counter may use', () => {
  it.each([
    ['was opened and nobody has counted yet', {}],
    ['is being counted', { [DAY]: 'counting' as const }],
    ['was counted but not closed', { [DAY]: 'counted' as const }],
    ['was closed and has been reopened', { [DAY]: 'reopened' as const }],
  ])('is received on a day that %s', async (_label, closings) => {
    const { service, state, tx, writes } = harness();
    state.closings = closings;
    const r = await service.createPurchase(delivery());
    expect(r.unitsCreated).toBe(1);
    expect(writes.payments[0]).toMatchObject({ amount: 1500, method: 'cash' });
    expect(tx.dailyClosing.update).not.toHaveBeenCalled();
    expect(tx.closingEvent.create).not.toHaveBeenCalled();
  });

  it('is received on the next day the Owner started early, while the day left behind stays closed', async () => {
    const { service, state, writes, lockReads } = harness(NEXT);
    state.closings = { [DAY]: 'locked' };
    await service.createPurchase(delivery());
    expect(writes.payments[0].businessDate).toEqual(new Date(`${NEXT}T00:00:00.000Z`));
    expect(lockReads[0].values).toEqual([COMPANY, BRANCH, NEXT]);
  });

  it('moves the day’s money version once, under the lock the close takes, after the day is found open (D159)', async () => {
    const { service, state, lockReads, bumps } = harness();
    state.closings = { [DAY]: 'counting' };
    await service.createPurchase(delivery());
    expect(bumps).toHaveLength(1);
    expect(bumps[0].sql).toMatch(/UPDATE daily_closings SET money_version = money_version \+ 1\s+WHERE company_id = \? AND branch_id = \? AND closing_date = \?/);
    expect(bumps[0].values).toEqual([COMPANY, BRANCH, DAY]);
    expect(lockReads).toHaveLength(1);
  });
});

describe('a retry of a receipt made before the close', () => {
  it('answers with the original receipt, without reading the day or opening a transaction', async () => {
    const { service, state, db } = harness();
    const first = await service.createPurchase(delivery());
    state.closings = { [DAY]: 'locked' };
    db.dailyClosing.findUnique.mockClear();
    const again = await service.createPurchase(delivery());
    expect(again).toMatchObject({ purchaseId: first.purchaseId, unitsCreated: 1, replayed: true });
    expect(db.dailyClosing.findUnique).not.toHaveBeenCalled();
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it('still refuses a different delivery under the same key as a key conflict, not as a closed store', async () => {
    const { service, state } = harness();
    await service.createPurchase(delivery());
    state.closings = { [DAY]: 'locked' };
    const e = await refusal(() => service.createPurchase(delivery({ items: [{ productId: PRODUCT, unitCost: 1600, identifiers: [IMEI] }] })));
    expect(e.message).toMatch(/already used for a different delivery/);
    expect(e.getResponse()).not.toMatchObject({ code: 'store_closed' });
  });
});

describe('the open-first rule in the source', () => {
  const service = readFileSync(join(__dirname, 'purchasing.service.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('a receipt never reopens the day: createPurchase calls no auto-reopen', () => {
    expect(service).not.toMatch(/autoReopenTx|afterReopenCommitted/);
    expect(service).toMatch(/await this\.closing\.assertCounterOpenTx\(tx, \{ branchId, businessDate: payDay, operation: 'receipt' \}\);/);
  });

  it('asks whether the store is open after the replay and before the first lookup', () => {
    const check = service.indexOf("await this.closing.assertCounterOpen(branchId, 'receipt');");
    expect(check).toBeGreaterThan(service.indexOf('if (replay) return replay;'));
    expect(check).toBeLessThan(service.indexOf('this.db.receivingAccount.findFirst('));
  });
});
