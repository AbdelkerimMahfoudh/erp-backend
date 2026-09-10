import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, TrackingType } from '@prisma/client';
import { InventoryService } from './inventory.service';
import { TrackingStrategyRegistry } from '../tracking/tracking-strategy.registry';
import { fingerprintReceipt } from './receipt-fingerprint';

/**
 * Category-aware intake, at the only boundary that can actually enforce it.
 *
 * Every case here is written from the manipulated-client direction: not "does
 * the form send the right shape" but "what happens when it sends the wrong one
 * on purpose". The old contract answered most of these by silently discarding
 * the field it did not want, which is why they read as surprising.
 */

const COMPANY = Buffer.alloc(16, 1);
const BRANCH = Buffer.alloc(16, 2);
const USER = Buffer.alloc(16, 3);
const PHONE = Buffer.alloc(16, 4);
const CABLE = Buffer.alloc(16, 5);

function harness() {
  const receipts: any[] = [];
  const stockCalls: any[] = [];
  const units: any[] = [];

  const products: Record<string, any> = {
    [PHONE.toString('hex')]: {
      id: PHONE,
      trackingType: TrackingType.imei,
      defaultPrice: null,
      brand: 'Apple',
      model: 'iPhone 15',
    },
    [CABLE.toString('hex')]: {
      id: CABLE,
      trackingType: TrackingType.quantity,
      defaultPrice: new Prisma.Decimal('250.00'),
      brand: 'Anker',
      model: 'USB-C Cable',
    },
  };

  /** Mimics the unique index on (company_id, client_uuid). */
  function insertReceipt(data: any) {
    if (data.clientUuid) {
      const clash = receipts.some(
        (r) => r.companyId.equals(data.companyId) && r.clientUuid && r.clientUuid.equals(data.clientUuid),
      );
      if (clash) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
    }
    receipts.push({ ...data });
    return data;
  }

  const tx = {
    stockReceipt: { create: jest.fn(async ({ data }: any) => insertReceipt(data)) },
    // `receiveQuantityAtCost` runs raw SQL; capturing it proves the single
    // statement is still what moves stock, and that it is inside the transaction.
    $executeRaw: jest.fn(async (...args: unknown[]) => {
      stockCalls.push(args);
      return 1;
    }),
    unit: { create: jest.fn(async ({ data }: any) => (units.push(data), data)) },
    auditLog: { create: jest.fn(async () => ({})) },
  };

  const db: any = {
    product: { findUnique: jest.fn(async ({ where }: any) => products[where.id.toString('hex')] ?? null) },
    unit: { findMany: jest.fn(async () => []) },
    stockReceipt: {
      findFirst: jest.fn(async ({ where }: any) =>
        receipts.find(
          (r) =>
            r.companyId.equals(where.companyId) &&
            ((where.clientUuid === null && !r.clientUuid) ||
              (where.clientUuid && r.clientUuid && r.clientUuid.equals(where.clientUuid))),
        ) ?? null,
      ),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
    $executeRaw: tx.$executeRaw,
  };

  const tenant: any = {
    companyId: () => COMPANY,
    requireBranchId: () => BRANCH,
    userId: () => USER,
  };
  const audit: any = { record: jest.fn(), recordTx: jest.fn() };

  const service = new InventoryService(db, tenant, audit, new TrackingStrategyRegistry(), db);
  return { service, receipts, stockCalls, units, db, tx };
}

// ─────────────────────────── contradictory payloads ──────────────────────────

describe('a counted product refuses per-unit identity', () => {
  it('rejects an IMEI sent for a cable instead of ignoring it', async () => {
    const { service } = harness();
    await expect(
      service.quickAdd({ productId: uuid(CABLE), identifier: '353210110000005', cost: 100 } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a second IMEI too', async () => {
    const { service } = harness();
    await expect(
      service.quickAdd({ productId: uuid(CABLE), quantity: 5, imeiSecondary: '490154203237518', cost: 100 } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('does not move stock when it refuses', async () => {
    const { service, stockCalls, receipts } = harness();
    await expect(
      service.quickAdd({ productId: uuid(CABLE), identifier: 'SN-1', quantity: 5, cost: 100 } as any),
    ).rejects.toThrow();
    expect(stockCalls).toHaveLength(0);
    expect(receipts).toHaveLength(0);
  });
});

describe('a serialized product refuses bulk', () => {
  /**
   * The quiet one. "Receive 50" used to create ONE phone and report success,
   * throwing the other 49 away with no error anywhere.
   */
  it('rejects quantity above one on a phone', async () => {
    const { service } = harness();
    await expect(
      service.quickAdd({ productId: uuid(PHONE), identifier: '353210110000005', quantity: 50, cost: 100 } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates no unit when it refuses', async () => {
    const { service, units } = harness();
    await expect(
      service.quickAdd({ productId: uuid(PHONE), identifier: '353210110000005', quantity: 50, cost: 100 } as any),
    ).rejects.toThrow();
    expect(units).toHaveLength(0);
  });

  it('still accepts an explicit quantity of exactly one', async () => {
    const { service, units } = harness();
    await service.quickAdd({ productId: uuid(PHONE), identifier: '353210110000005', quantity: 1, cost: 100 } as any);
    expect(units).toHaveLength(1);
  });

  it('still requires the primary IMEI', async () => {
    const { service } = harness();
    await expect(service.quickAdd({ productId: uuid(PHONE), cost: 100 } as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('quantities that are not counts', () => {
  for (const [label, quantity] of [
    ['zero', 0],
    ['negative', -5],
    ['fractional', 2.5],
  ] as const) {
    it(`rejects a ${label} quantity`, async () => {
      const { service, stockCalls } = harness();
      await expect(
        service.quickAdd({ productId: uuid(CABLE), quantity, cost: 100 } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(stockCalls).toHaveLength(0);
    });
  }

  it('rejects a missing quantity', async () => {
    const { service } = harness();
    await expect(service.quickAdd({ productId: uuid(CABLE), cost: 100 } as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

// ───────────────────────────────── idempotency ───────────────────────────────

describe('a retry must not deliver the goods twice', () => {
  const KEY = '0195f0a0-0000-7000-8000-000000000001';

  it('receives once on the first request', async () => {
    const { service, receipts, stockCalls } = harness();
    const result = await service.quickAdd({
      productId: uuid(CABLE),
      quantity: 15,
      cost: 100,
      clientUuid: KEY,
    } as any);
    expect(result).toEqual({ productId: uuid(CABLE), quantity: 15, tracking: 'quantity' });
    expect(receipts).toHaveLength(1);
    expect(stockCalls).toHaveLength(1);
  });

  it('replays the same answer and moves no stock the second time', async () => {
    const { service, receipts, stockCalls } = harness();
    const dto = { productId: uuid(CABLE), quantity: 15, cost: 100, clientUuid: KEY } as any;
    const first = await service.quickAdd(dto);
    const second = await service.quickAdd(dto);

    expect(second).toEqual(first);
    expect(receipts).toHaveLength(1);
    expect(stockCalls).toHaveLength(1); // the crux: stock moved exactly once
  });

  it('treats the same key with different contents as a conflict, not a retry', async () => {
    const { service } = harness();
    await service.quickAdd({ productId: uuid(CABLE), quantity: 15, cost: 100, clientUuid: KEY } as any);
    await expect(
      service.quickAdd({ productId: uuid(CABLE), quantity: 40, cost: 100, clientUuid: KEY } as any),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('reports that conflict with a code the client can branch on', async () => {
    const { service } = harness();
    await service.quickAdd({ productId: uuid(CABLE), quantity: 15, cost: 100, clientUuid: KEY } as any);
    await expect(
      service.quickAdd({ productId: uuid(CABLE), quantity: 15, cost: 999, clientUuid: KEY } as any),
    ).rejects.toMatchObject({ response: { code: 'idempotency_conflict' } });
  });

  /**
   * Two retries in flight together. Both find no prior receipt, both try to
   * insert, and the unique index picks a winner — the loser must replay rather
   * than surface a database error.
   */
  it('survives two identical requests racing each other', async () => {
    const { service, receipts, stockCalls } = harness();
    const dto = { productId: uuid(CABLE), quantity: 15, cost: 100, clientUuid: KEY } as any;
    const [a, b] = await Promise.all([service.quickAdd({ ...dto }), service.quickAdd({ ...dto })]);

    expect(a).toEqual(b);
    expect(receipts).toHaveLength(1);
    expect(stockCalls).toHaveLength(1);
  });

  it('without a key, behaves exactly as it did before — no protection claimed', async () => {
    const { service, stockCalls } = harness();
    const dto = { productId: uuid(CABLE), quantity: 15, cost: 100 } as any;
    await service.quickAdd(dto);
    await service.quickAdd(dto);
    expect(stockCalls).toHaveLength(2);
  });
});

describe('the receipt records what happened', () => {
  it('stores the branch, product, quantity and the cost of this delivery', async () => {
    const { service, receipts } = harness();
    await service.quickAdd({ productId: uuid(CABLE), quantity: 12, cost: 87.5 } as any);
    expect(receipts[0]).toMatchObject({
      companyId: COMPANY,
      branchId: BRANCH,
      productId: CABLE,
      userId: USER,
      quantity: 12,
      unitCost: 87.5,
    });
  });

  it('stores no fingerprint when there is no key to fingerprint against', async () => {
    const { service, receipts } = harness();
    await service.quickAdd({ productId: uuid(CABLE), quantity: 12, cost: 87.5 } as any);
    expect(receipts[0].clientRequestHash).toBeNull();
  });
});

describe('the receipt fingerprint', () => {
  const base = { productId: 'p', branchId: 'b', quantity: 5, cost: 10, price: null };

  it('is stable for the same payload', () => {
    expect(fingerprintReceipt(base)).toBe(fingerprintReceipt({ ...base }));
  });

  for (const [field, changed] of [
    ['quantity', { quantity: 6 }],
    ['cost', { cost: 11 }],
    ['price', { price: 20 }],
    ['product', { productId: 'q' }],
    ['branch', { branchId: 'c' }],
  ] as const) {
    it(`changes when the ${field} changes`, () => {
      expect(fingerprintReceipt({ ...base, ...changed })).not.toBe(fingerprintReceipt(base));
    });
  }

  it('ignores a difference that is only decimal formatting', () => {
    expect(fingerprintReceipt({ ...base, cost: 10 })).toBe(fingerprintReceipt({ ...base, cost: 10.0 }));
  });
});

/** Buffer → the canonical uuid string the DTO carries. */
function uuid(b: Buffer): string {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
