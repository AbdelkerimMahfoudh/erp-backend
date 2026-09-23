import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { SalesService } from './sales.service';
import { SalesController } from './sales.controller';
import { REQUIRE_PERMISSIONS_KEY } from '../rbac/require-permissions.decorator';
import { binToUuid } from '../common/utils/uuid.util';

/**
 * One client key, one sale — and never a different sale under the same key.
 *
 * The key exists so a retry after a lost answer cannot charge a customer twice.
 * Two things must therefore be true of it, and one was not: a REPLAY answers
 * with the sale already made (it did), and a different payload under the same
 * key is REFUSED (it was silently answered with the old sale, so a phone that
 * changed the price and resent would have been told the new price was recorded).
 * The third piece is the lookup: after a timeout the phone asks what its key
 * recorded before it offers another submission.
 */

const COMPANY = Buffer.alloc(16, 1);
const BRANCH = Buffer.alloc(16, 2);
const USER = Buffer.alloc(16, 3);
const SALE = Buffer.alloc(16, 4);
const UNIT = Buffer.alloc(16, 5);
const PRODUCT = Buffer.alloc(16, 6);
const KEY = '11111111-2222-4333-8444-555555555555';
const IMEI = '490154203237518';

function harness(existing: unknown) {
  const db: any = {
    sale: { findFirst: jest.fn(async () => existing) },
    saleItem: {
      findMany: jest.fn(async () => [{ unitId: UNIT, productId: null, quantity: 1, price: 899 }]),
    },
    payment: { findMany: jest.fn(async () => [{ method: 'cash', amount: 899 }]) },
    unit: { findFirst: jest.fn(async ({ where }: any) => (where.OR.some((c: any) => Object.values(c)[0] === IMEI) ? { id: UNIT } : null)) },
    $transaction: jest.fn(async () => { throw new Error('the transaction must not run on a replay'); }),
  };
  const tenant: any = { companyId: () => COMPANY, requireBranchId: () => BRANCH, userId: () => USER };
  const cls: any = { get: () => new Set() };
  const policy: any = { round: (n: number) => Math.round(n * 100) / 100 };
  const service = new SalesService(
    db, tenant, {} as never, policy, {} as never, {} as never, {} as never, cls, {} as never, {} as never, {} as never,
    { assign: async () => '2026-09-22', today: async () => '2026-09-22' } as never, { autoReopenTx: async () => ({ reopened: false, closingId: null, reopenCount: 0, at: null }), afterSaleCommitted: async () => undefined, afterReopenCommitted: async () => undefined } as never,
  );
  return { service, db };
}

const sale = {
  id: SALE,
  invoiceNo: '00042',
  total: 899,
  margin: 200,
  balanceDue: 0,
  payStatus: 'paid',
  soldAt: new Date('2026-09-22T03:00:00Z'),
  returnWindowHours: 0,
  returnDeadlineAt: null,
  discount: 0,
};

const base = { clientUuid: KEY, lines: [{ identifier: IMEI, price: 899 }], payments: [{ method: 'cash', amount: 899 }] };

describe('a replay of the same sale', () => {
  it('answers with the sale already made, and runs no transaction', async () => {
    const { service, db } = harness(sale);
    const r = (await service.createSale(base as never)) as { invoiceNo: string; id: string };
    expect(r.invoiceNo).toBe('00042');
    expect(r.id).toBe(binToUuid(SALE));
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('accepts a replay that leaves the price to the ladder', async () => {
    const { service } = harness(sale);
    const r = (await service.createSale({ ...base, lines: [{ identifier: IMEI }] } as never)) as { invoiceNo: string };
    expect(r.invoiceNo).toBe('00042');
  });
});

describe('a different sale under the same key is refused', () => {
  const conflicts = async (dto: unknown) => {
    const { service, db } = harness(sale);
    let caught: unknown;
    try {
      await service.createSale(dto as never);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    expect((caught as ConflictException).getResponse()).toMatchObject({ code: 'idempotency_conflict' });
    expect(db.$transaction).not.toHaveBeenCalled();
  };

  it('a changed price', () => conflicts({ ...base, lines: [{ identifier: IMEI, price: 1899 }], payments: [{ method: 'cash', amount: 1899 }] }));
  it('a different item', () => conflicts({ ...base, lines: [{ identifier: '353210110000005', price: 899 }] }));
  it('a product line instead of the unit', () => conflicts({ ...base, lines: [{ productId: binToUuid(PRODUCT), quantity: 2, price: 899 }] }));
  it('different money at the counter', () => conflicts({ ...base, payments: [{ method: 'cash', amount: 500 }] }));
  it('a discount that was not there', () => conflicts({ ...base, saleDiscount: 50 }));
});

describe('asking what a key recorded', () => {
  it('returns the sale for a known key', async () => {
    const { service } = harness(sale);
    const r = await service.findByClientUuid(KEY);
    expect(r.invoiceNo).toBe('00042');
    expect(JSON.stringify(r)).not.toMatch(/Buffer|clientUuid/);
  });
  it('404s an unknown key', async () => {
    const { service } = harness(null);
    await expect(service.findByClientUuid(KEY)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('refuses something that is not a uuid', async () => {
    const { service } = harness(null);
    await expect(service.findByClientUuid('not-a-key')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('the route needs sale.create, like the sale itself', () => {
    const perms: string[] = Reflect.getMetadata(REQUIRE_PERMISSIONS_KEY, SalesController.prototype.byClientUuid) ?? [];
    expect(perms).toEqual(['sale.create']);
  });
});
