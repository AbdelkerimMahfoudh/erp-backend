import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TrackingType } from '@prisma/client';
import { InventoryService } from './inventory.service';
import { TrackingStrategyRegistry } from '../tracking/tracking-strategy.registry';
import { binToUuid } from '../common/utils/uuid.util';

/**
 * Correcting an in-stock unit — the intake-mistake fix.
 *
 * Written from the manipulated-client direction: not "does the form send the
 * right shape" but "what happens when it sends a wrong or stale one on purpose".
 * The rules under test are the ones a correction must never break — sell-once
 * states are immutable here, another unit's IMEI cannot be stolen, cost is gated
 * both ways, and a stale token cannot overwrite a concurrent change.
 */

const COMPANY = Buffer.alloc(16, 1);
const BRANCH = Buffer.alloc(16, 2);
const USER = Buffer.alloc(16, 3);
const PHONE_PRODUCT = Buffer.alloc(16, 4);
const TV_PRODUCT = Buffer.alloc(16, 5);
const OTHER_PHONE_PRODUCT = Buffer.alloc(16, 6);

const UNIT_ID = Buffer.from('0192aaaaaaaa7aaa8aaaaaaaaaaaaaaa'.slice(0, 32), 'hex');
const OTHER_UNIT_ID = Buffer.from('0192bbbbbbbb7bbb8bbbbbbbbbbbbbbb'.slice(0, 32), 'hex');

const IMEI_A = '350000000000006'; // Luhn-valid
const IMEI_B = '353210110000005'; // Luhn-valid
const IMEI_C = '490154203237518'; // Luhn-valid
const UPDATED = new Date('2026-09-21T10:00:00.000Z');

type SeedUnit = {
  id: Buffer;
  productId: Buffer;
  imeiPrimary?: string | null;
  imeiSecondary?: string | null;
  serialNo?: string | null;
  cost?: string;
  status?: string;
  updatedAt?: Date;
  branchId?: Buffer;
};

function trackingOf(productId: Buffer): TrackingType {
  if (productId.equals(TV_PRODUCT)) return TrackingType.serial;
  return TrackingType.imei;
}

function harness(seed: { units?: SeedUnit[]; permissions?: string[] } = {}) {
  const units = (seed.units ?? []).map((u) => ({
    id: u.id,
    companyId: COMPANY,
    productId: u.productId,
    branchId: u.branchId ?? BRANCH,
    imeiPrimary: u.imeiPrimary ?? null,
    imeiSecondary: u.imeiSecondary ?? null,
    serialNo: u.serialNo ?? null,
    cost: new Prisma.Decimal(u.cost ?? '100.00'),
    status: u.status ?? 'in_stock',
    updatedAt: u.updatedAt ?? UPDATED,
    product: { id: u.productId, trackingType: trackingOf(u.productId) },
  }));

  const products: Record<string, any> = {
    [PHONE_PRODUCT.toString('hex')]: { id: PHONE_PRODUCT, trackingType: TrackingType.imei },
    [OTHER_PHONE_PRODUCT.toString('hex')]: { id: OTHER_PHONE_PRODUCT, trackingType: TrackingType.imei },
    [TV_PRODUCT.toString('hex')]: { id: TV_PRODUCT, trackingType: TrackingType.serial },
  };

  const audits: any[] = [];

  const applyUpdate = (id: Buffer, where: any, data: any): number => {
    const u = units.find((x) => x.id.equals(id));
    if (!u) return 0;
    if (where.updatedAt && where.updatedAt.getTime() !== u.updatedAt.getTime()) return 0;
    if (where.status && u.status !== where.status) return 0;
    // The BEFORE UPDATE trigger (migration 0042) — cross-column collision.
    const collide = (value: string | null | undefined) =>
      value != null &&
      units.some(
        (o) =>
          !o.id.equals(id) &&
          (o.imeiPrimary === value || o.imeiSecondary === value || o.serialNo === value),
      );
    const nextPrimary = 'imeiPrimary' in data ? data.imeiPrimary : u.imeiPrimary;
    const nextSecondary = 'imeiSecondary' in data ? data.imeiSecondary : u.imeiSecondary;
    const nextSerial = 'serialNo' in data ? data.serialNo : u.serialNo;
    if (collide(nextPrimary) || collide(nextSecondary) || collide(nextSerial)) {
      throw new Prisma.PrismaClientKnownRequestError('That IMEI already identifies another unit', {
        code: 'P2010',
        clientVersion: 'test',
      });
    }
    Object.assign(u, data);
    u.updatedAt = new Date(u.updatedAt.getTime() + 1000);
    return 1;
  };

  const tx = {
    unit: {
      updateMany: jest.fn(async ({ where, data }: any) => ({ count: applyUpdate(where.id, where, data) })),
      findUnique: jest.fn(async ({ where }: any) => units.find((u) => u.id.equals(where.id)) ?? null),
    },
    auditLog: { create: jest.fn(async () => ({})) },
  };

  const db: any = {
    unit: {
      findUnique: jest.fn(async ({ where }: any) => units.find((u) => u.id.equals(where.id)) ?? null),
      findMany: jest.fn(async ({ where }: any) => {
        const wanted: string[] = where.OR.flatMap((c: any) => (Object.values(c)[0] as { in: string[] }).in);
        const exclude: Buffer | undefined = where.id?.not;
        return units
          .filter((u) => !(exclude && u.id.equals(exclude)))
          .filter(
            (u) =>
              (u.imeiPrimary && wanted.includes(u.imeiPrimary)) ||
              (u.imeiSecondary && wanted.includes(u.imeiSecondary)) ||
              (u.serialNo && wanted.includes(u.serialNo)),
          )
          .map((u) => ({ imeiPrimary: u.imeiPrimary, imeiSecondary: u.imeiSecondary, serialNo: u.serialNo }));
      }),
    },
    product: { findUnique: jest.fn(async ({ where }: any) => products[where.id.toString('hex')] ?? null) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };

  const tenant: any = { companyId: () => COMPANY, requireBranchId: () => BRANCH, userId: () => USER };
  const audit: any = {
    record: jest.fn(),
    recordTx: jest.fn(async (_tx: any, params: any) => {
      audits.push(params);
    }),
  };
  const cls: any = { get: (k: string) => (k === 'permissions' ? new Set(seed.permissions ?? ['cost.view']) : undefined) };

  const service = new InventoryService(db, tenant, audit, new TrackingStrategyRegistry(), db, cls);
  return { service, units, audits, db, tx };
}

const uuid = (b: Buffer) => binToUuid(b);
const phone = (over: Partial<SeedUnit> = {}): SeedUnit => ({
  id: UNIT_ID,
  productId: PHONE_PRODUCT,
  imeiPrimary: IMEI_A,
  cost: '100.00',
  ...over,
});

describe('a correction touches only an in-stock unit', () => {
  it('refuses a sold unit', async () => {
    const { service } = harness({ units: [phone({ status: 'sold' })] });
    await expect(
      service.correctUnit(uuid(UNIT_ID), { expectedUpdatedAt: UPDATED.toISOString(), cost: 120, reason: 'x' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a reserved unit', async () => {
    const { service } = harness({ units: [phone({ status: 'reserved' })] });
    await expect(
      service.correctUnit(uuid(UNIT_ID), { expectedUpdatedAt: UPDATED.toISOString(), cost: 120, reason: 'x' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('404s an unknown unit', async () => {
    const { service } = harness({ units: [] });
    await expect(
      service.correctUnit(uuid(UNIT_ID), { expectedUpdatedAt: UPDATED.toISOString(), cost: 120, reason: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('optimistic concurrency', () => {
  it('refuses a stale token and writes nothing', async () => {
    const { service, tx } = harness({ units: [phone()] });
    const stale = new Date('2026-09-20T00:00:00.000Z').toISOString();
    await expect(
      service.correctUnit(uuid(UNIT_ID), { expectedUpdatedAt: stale, cost: 120, reason: 'typo' }),
    ).rejects.toMatchObject({ response: { code: 'stale_unit' } });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('applies with the current token', async () => {
    const { service, units } = harness({ units: [phone()] });
    await service.correctUnit(uuid(UNIT_ID), { expectedUpdatedAt: UPDATED.toISOString(), cost: 120, reason: 'typo' });
    expect(Number(units[0].cost)).toBe(120);
  });
});

describe('identifier corrections', () => {
  it('corrects a mistyped IMEI and records before/after with a reason', async () => {
    const { service, units, audits } = harness({ units: [phone({ imeiPrimary: IMEI_A })] });
    await service.correctUnit(uuid(UNIT_ID), {
      expectedUpdatedAt: UPDATED.toISOString(),
      imeiPrimary: IMEI_B,
      reason: 'scanned wrong box',
    });
    expect(units[0].imeiPrimary).toBe(IMEI_B);
    expect(audits[0]).toMatchObject({
      action: 'update',
      before: { imeiPrimary: IMEI_A },
      after: { imeiPrimary: IMEI_B },
      reason: 'scanned wrong box',
    });
  });

  it('rejects an IMEI that fails the checksum', async () => {
    const { service } = harness({ units: [phone()] });
    await expect(
      service.correctUnit(uuid(UNIT_ID), {
        expectedUpdatedAt: UPDATED.toISOString(),
        imeiPrimary: '350000000000000',
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an IMEI already held by another unit (app pre-check)', async () => {
    const { service } = harness({
      units: [
        phone({ imeiPrimary: IMEI_A }),
        { id: OTHER_UNIT_ID, productId: PHONE_PRODUCT, imeiPrimary: IMEI_B },
      ],
    });
    await expect(
      service.correctUnit(uuid(UNIT_ID), {
        expectedUpdatedAt: UPDATED.toISOString(),
        imeiPrimary: IMEI_B,
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps the cross-column trigger to a 409 under a race', async () => {
    // The pre-check passes (it sees nothing), so the DB trigger is what refuses
    // the write — and it must surface as a clean 409, not a raw Prisma error.
    const { service, db } = harness({
      units: [
        phone({ imeiPrimary: IMEI_A }),
        { id: OTHER_UNIT_ID, productId: PHONE_PRODUCT, imeiPrimary: IMEI_B },
      ],
    });
    db.unit.findMany = jest.fn(async () => []); // pre-check blind; the write still collides
    await expect(
      service.correctUnit(uuid(UNIT_ID), {
        expectedUpdatedAt: UPDATED.toISOString(),
        imeiPrimary: IMEI_B,
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('keeps its own IMEI without reporting itself as a duplicate', async () => {
    const { service, units } = harness({ units: [phone({ imeiPrimary: IMEI_A })] });
    await service.correctUnit(uuid(UNIT_ID), {
      expectedUpdatedAt: UPDATED.toISOString(),
      imeiPrimary: IMEI_A,
      imeiSecondary: IMEI_C,
      reason: 'add second sim',
    });
    expect(units[0].imeiSecondary).toBe(IMEI_C);
  });

  it('refuses the same number as both IMEIs', async () => {
    const { service } = harness({ units: [phone({ imeiPrimary: IMEI_A })] });
    await expect(
      service.correctUnit(uuid(UNIT_ID), {
        expectedUpdatedAt: UPDATED.toISOString(),
        imeiSecondary: IMEI_A,
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('clears a secondary IMEI with null', async () => {
    const { service, units } = harness({ units: [phone({ imeiPrimary: IMEI_A, imeiSecondary: IMEI_C })] });
    await service.correctUnit(uuid(UNIT_ID), {
      expectedUpdatedAt: UPDATED.toISOString(),
      imeiSecondary: null,
      reason: 'not dual sim',
    });
    expect(units[0].imeiSecondary).toBeNull();
  });
});

describe('the tracking type shapes the correction', () => {
  it('refuses a serial on an imei-tracked unit', async () => {
    const { service } = harness({ units: [phone()] });
    await expect(
      service.correctUnit(uuid(UNIT_ID), {
        expectedUpdatedAt: UPDATED.toISOString(),
        serialNo: 'SN123',
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an IMEI on a serial-tracked unit', async () => {
    const { service } = harness({
      units: [{ id: UNIT_ID, productId: TV_PRODUCT, serialNo: 'SN-OLD', imeiPrimary: null }],
    });
    await expect(
      service.correctUnit(uuid(UNIT_ID), {
        expectedUpdatedAt: UPDATED.toISOString(),
        imeiPrimary: IMEI_A,
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('corrects a serial on a serial-tracked unit', async () => {
    const { service, units } = harness({
      units: [{ id: UNIT_ID, productId: TV_PRODUCT, serialNo: 'sn-old', imeiPrimary: null }],
    });
    await service.correctUnit(uuid(UNIT_ID), {
      expectedUpdatedAt: UPDATED.toISOString(),
      serialNo: 'sn-new',
      reason: 'typo',
    });
    // Serial strategy upper-cases on normalize.
    expect(units[0].serialNo).toBe('SN-NEW');
  });
});

describe('product re-association', () => {
  it('moves the unit to another product of the same tracking type', async () => {
    const { service, units } = harness({ units: [phone()] });
    await service.correctUnit(uuid(UNIT_ID), {
      expectedUpdatedAt: UPDATED.toISOString(),
      productId: uuid(OTHER_PHONE_PRODUCT),
    });
    expect(units[0].productId.equals(OTHER_PHONE_PRODUCT)).toBe(true);
  });

  it('refuses moving across tracking types', async () => {
    const { service } = harness({ units: [phone()] });
    await expect(
      service.correctUnit(uuid(UNIT_ID), {
        expectedUpdatedAt: UPDATED.toISOString(),
        productId: uuid(TV_PRODUCT),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s an unknown product', async () => {
    const { service } = harness({ units: [phone()] });
    await expect(
      service.correctUnit(uuid(UNIT_ID), {
        expectedUpdatedAt: UPDATED.toISOString(),
        productId: binToUuid(Buffer.alloc(16, 9)),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a product-only correction needs no reason', async () => {
    const { service, units } = harness({ units: [phone()] });
    await service.correctUnit(uuid(UNIT_ID), {
      expectedUpdatedAt: UPDATED.toISOString(),
      productId: uuid(OTHER_PHONE_PRODUCT),
    });
    expect(units[0].productId.equals(OTHER_PHONE_PRODUCT)).toBe(true);
  });
});

describe('cost is gated both ways', () => {
  it('refuses a cost change without cost.view', async () => {
    const { service } = harness({ units: [phone()], permissions: ['unit.add'] });
    await expect(
      service.correctUnit(uuid(UNIT_ID), { expectedUpdatedAt: UPDATED.toISOString(), cost: 120, reason: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a cost change with cost.view', async () => {
    const { service, units } = harness({ units: [phone()], permissions: ['unit.add', 'cost.view'] });
    await service.correctUnit(uuid(UNIT_ID), { expectedUpdatedAt: UPDATED.toISOString(), cost: 120, reason: 'off by a digit' });
    expect(Number(units[0].cost)).toBe(120);
  });
});

describe('a correction must say what and why', () => {
  it('rejects an empty correction', async () => {
    const { service } = harness({ units: [phone()] });
    await expect(
      service.correctUnit(uuid(UNIT_ID), { expectedUpdatedAt: UPDATED.toISOString() }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires a reason for a sensitive change', async () => {
    const { service } = harness({ units: [phone()] });
    await expect(
      service.correctUnit(uuid(UNIT_ID), { expectedUpdatedAt: UPDATED.toISOString(), cost: 120 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
