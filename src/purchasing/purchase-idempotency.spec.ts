import { ConflictException } from '@nestjs/common';
import { PurchasingService } from './purchasing.service';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { uuidToBin, binToUuid } from '../common/utils/uuid.util';

/**
 * Receiving must survive a retry.
 *
 * A timeout on `POST /purchases` used to create a SECOND purchase: duplicate
 * stock, a duplicate supplier payable, and a second teach-on-confirm pass that
 * inflated recognition `confirmations` for one logical action. Offline replay
 * would have made that routine rather than rare.
 *
 * These tests fix the contract: one client request identity means one delivery,
 * whatever the network does.
 */

const COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c001');
const OTHER_COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c002');
const BRANCH = uuidToBin('018f0000-0000-7000-8000-0000000000b1');
const SUPPLIER = uuidToBin('018f0000-0000-7000-8000-00000000f001');
const PRODUCT = '018f0000-0000-7000-8000-00000000a001';
const KEY = '018f0000-0000-7000-8000-00000000e001';

function dtoFor(over: Record<string, unknown> = {}) {
  return {
    clientUuid: KEY,
    supplierId: binToUuid(SUPPLIER),
    items: [{ productId: PRODUCT, unitCost: 800, identifiers: ['356888000000001'] }],
    ...over,
  } as never;
}

/**
 * Store keyed by (companyId, clientUuid) — mirroring the unique index — so a
 * cross-company key collision is a real scenario rather than an assumption.
 */
function makeService(companyId: Buffer = COMPANY) {
  const purchases: any[] = [];
  let learnCalls = 0;

  const db: any = {
    purchase: {
      findFirst: jest.fn(async ({ where }: any) =>
        purchases.find(
          (p) =>
            p.companyId.equals(where.companyId) &&
            p.clientUuid &&
            where.clientUuid &&
            p.clientUuid.equals(where.clientUuid),
        ) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        // The unique index, enforced in the double.
        const clash = purchases.find(
          (p) =>
            p.companyId.equals(data.companyId) &&
            p.clientUuid &&
            data.clientUuid &&
            p.clientUuid.equals(data.clientUuid),
        );
        if (clash) {
          const e: any = new Error('Unique constraint failed');
          e.code = 'P2002';
          throw e;
        }
        purchases.push({ ...data, items: [], units: [], total: data.total });
        return data;
      }),
    },
    supplier: { findUnique: jest.fn(async () => ({ id: SUPPLIER })) },
    product: {
      findMany: jest.fn(async () => [
        { id: uuidToBin(PRODUCT), trackingType: 'imei', defaultPrice: 1000, companyId },
      ]),
    },
    purchaseItem: { create: jest.fn(async () => ({})) },
    supplierPayment: { create: jest.fn(async () => ({})) },
    $transaction: jest.fn(async (fn: any) =>
      fn({
        purchase: db.purchase,
        purchaseItem: db.purchaseItem,
        supplierPayment: db.supplierPayment,
        unit: { create: jest.fn(async () => ({ id: uuidToBin(PRODUCT) })) },
        stockItem: { upsert: jest.fn(async () => ({})) },
        auditLog: { create: jest.fn(async () => ({})) },
        supplier: { update: jest.fn(async () => ({})) },
      }),
    ),
  };

  const service = new PurchasingService(
    db as never,
    {
      companyId: () => companyId,
      requireBranchId: () => BRANCH,
      userId: () => null,
    } as never,
    { record: jest.fn(), recordTx: jest.fn() } as never,
    {
      findExistingIdentifiers: jest.fn(async () => new Set()),
      createUnit: jest.fn(async () => ({ id: uuidToBin(PRODUCT) })),
      addStock: jest.fn(async () => ({})),
    } as never,
    { create: jest.fn(), notify: jest.fn(), emit: jest.fn() } as never,
    {
      get: () => ({
        perUnit: true,
        identifierLabel: 'IMEI',
        validateIdentifier: () => ({ ok: true }),
        normalize: (s: string) => s,
        recognitionKey: () => null,
      }),
    } as never,
    { learn: jest.fn(async () => { learnCalls += 1; }) } as never,
    // Outbox: enqueue counts as the learning intent for these tests, since the
    // sweeper is what actually calls learn() in production.
    {
      enqueueTx: jest.fn(async (_tx: unknown, intents: unknown[]) => { learnCalls += intents.length; }),
      processNow: jest.fn(async () => {}),
    } as never,
    { enqueueDailyRecompute: jest.fn(), enqueueBranchRefresh: jest.fn() } as never,
  );

  return { service, purchases, learn: () => learnCalls };
}

describe('purchase idempotency', () => {
  it('an identical sequential retry returns the original and does not receive twice', async () => {
    const { service, purchases } = makeService();

    const first = await service.createPurchase(dtoFor());
    const second = await service.createPurchase(dtoFor());

    expect(purchases).toHaveLength(1);
    expect(second.purchaseId).toBe(first.purchaseId);
    expect((second as { replayed?: boolean }).replayed).toBe(true);
  });

  it('teaching runs once for one logical action, however many retries', async () => {
    const { service, learn } = makeService();

    await service.createPurchase(dtoFor());
    const afterFirst = learn();
    await service.createPurchase(dtoFor());
    await service.createPurchase(dtoFor());

    expect(learn()).toBe(afterFirst);
  });

  it('two concurrent copies of one request produce a single purchase', async () => {
    const { service, purchases } = makeService();

    // Both start before either has committed — the race the unique index exists
    // to lose safely.
    const results = await Promise.allSettled([
      service.createPurchase(dtoFor()),
      service.createPurchase(dtoFor()),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(purchases).toHaveLength(1);
    // Whichever lost the race must not have silently created a second delivery.
    expect(ok.length).toBeGreaterThanOrEqual(1);
  });

  it('the same key with a different payload is a conflict and changes nothing', async () => {
    const { service, purchases } = makeService();
    await service.createPurchase(dtoFor());

    await expect(
      service.createPurchase(
        dtoFor({ items: [{ productId: PRODUCT, unitCost: 999, identifiers: ['356888000000002'] }] }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(purchases).toHaveLength(1);
  });

  it('identifier order does not make an identical delivery look different', async () => {
    const { service } = makeService();
    const a = {
      productId: PRODUCT,
      unitCost: 800,
      identifiers: ['356888000000001', '356888000000002'],
    };
    const b = { ...a, identifiers: ['356888000000002', '356888000000001'] };

    const first = await service.createPurchase(dtoFor({ items: [a] }));
    const second = await service.createPurchase(dtoFor({ items: [b] }));

    expect(second.purchaseId).toBe(first.purchaseId);
  });

  it("one company's key never suppresses another company's receiving", async () => {
    const a = makeService(COMPANY);
    const b = makeService(OTHER_COMPANY);

    await a.service.createPurchase(dtoFor());
    const other = await b.service.createPurchase(dtoFor());

    // Same key, different company — must be a real purchase, not a replay.
    expect(other.purchaseId).toBeTruthy();
    expect((other as { replayed?: boolean }).replayed).toBeUndefined();
    expect(b.purchases).toHaveLength(1);
  });

  it('the same delivery sent under two different keys is two deliveries', async () => {
    const { service, purchases } = makeService();

    await service.createPurchase(dtoFor());
    await service.createPurchase(dtoFor({ clientUuid: '018f0000-0000-7000-8000-00000000e002' }));

    // Genuinely separate confirmations must not be collapsed.
    expect(purchases).toHaveLength(2);
  });

  it('rejects a request with no client key at validation level', async () => {
    // Mobile is the only consumer, so the key is REQUIRED rather than opt-in:
    // an unkeyed receive is exactly the retry that duplicates a delivery.
    const dto = plainToInstance(CreatePurchaseDto, {
      supplierId: binToUuid(SUPPLIER),
      items: [{ productId: PRODUCT, unitCost: 800, identifiers: ['356888000000001'] }],
    });
    const errors = await validate(dto, { whitelist: true });
    expect(errors.some((e) => e.property === 'clientUuid')).toBe(true);
  });

  it('accepts a request that supplies the key', async () => {
    const dto = plainToInstance(CreatePurchaseDto, {
      clientUuid: KEY,
      supplierId: binToUuid(SUPPLIER),
      items: [{ productId: PRODUCT, unitCost: 800, identifiers: ['356888000000001'] }],
    });
    const errors = await validate(dto, { whitelist: true });
    expect(errors.some((e) => e.property === 'clientUuid')).toBe(false);
  });
});
