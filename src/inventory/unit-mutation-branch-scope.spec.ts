import { NotFoundException } from '@nestjs/common';
import { Prisma, TrackingType } from '@prisma/client';
import { InventoryService } from './inventory.service';
import { TrackingStrategyRegistry } from '../tracking/tracking-strategy.registry';
import { binToUuid } from '../common/utils/uuid.util';

/**
 * `PATCH /units/:id` and `POST /units/:id/faulty` act on the active branch only.
 *
 * Both routes carry `unit.add`, which `PermissionsGuard` checks at the branch in
 * `X-Branch-Id`. The unit itself was loaded by id with only the company filter,
 * so a Store Manager of one branch, sending their own branch's header, rewrote
 * the cost of the other branch's phone and took another off its shelf as faulty
 * (found live). The unit's branch must be the branch the permission was checked
 * at; anything else answers as a unit that does not exist, and nothing is written.
 */

const MINE = Buffer.alloc(16, 2);
const THEIRS = Buffer.alloc(16, 7);
const UNIT_ID = Buffer.from('0192aaaaaaaa7aaa8aaaaaaaaaaaaaaa', 'hex');
const UPDATED = new Date('2026-09-21T10:00:00.000Z');

function harness(unitBranch: Buffer) {
  const unit = {
    id: UNIT_ID,
    branchId: unitBranch,
    productId: Buffer.alloc(16, 4),
    imeiPrimary: '350000000000006',
    imeiSecondary: null,
    serialNo: null,
    cost: new Prisma.Decimal('15000.00'),
    status: 'in_stock',
    updatedAt: UPDATED,
    product: { trackingType: TrackingType.imei },
  };
  const tx = {
    unit: {
      updateMany: jest.fn(async () => ({ count: 1 })),
      update: jest.fn(async ({ data }: any) => ({ ...unit, ...data })),
      findUnique: jest.fn(async () => unit),
    },
  };
  const db: any = {
    unit: { findUnique: jest.fn(async () => unit), findMany: jest.fn(async () => []) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const tenant: any = { requireBranchId: () => MINE, userId: () => Buffer.alloc(16, 3) };
  const audit: any = { recordTx: jest.fn(async () => undefined) };
  const cls: any = { get: (k: string) => (k === 'permissions' ? new Set(['unit.add', 'cost.view']) : undefined) };
  const service = new InventoryService(db, tenant, audit, new TrackingStrategyRegistry(), db, cls);
  return { service, db, tx };
}

const correction = { expectedUpdatedAt: UPDATED.toISOString(), cost: 1, reason: 'cross-branch probe' };

describe('unit mutations are confined to the active branch', () => {
  it('corrects a unit of the active branch', async () => {
    const { service, tx } = harness(MINE);

    await service.correctUnit(binToUuid(UNIT_ID), correction);

    expect(tx.unit.updateMany).toHaveBeenCalledTimes(1);
  });

  it('refuses to correct another branch’s unit, as if it did not exist, writing nothing', async () => {
    const { service, db } = harness(THEIRS);

    await expect(service.correctUnit(binToUuid(UNIT_ID), correction)).rejects.toBeInstanceOf(NotFoundException);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('marks a unit of the active branch faulty', async () => {
    const { service, tx } = harness(MINE);

    await service.markFaulty(binToUuid(UNIT_ID));

    expect(tx.unit.update).toHaveBeenCalledTimes(1);
  });

  it('refuses to mark another branch’s unit faulty, writing nothing', async () => {
    const { service, db } = harness(THEIRS);

    await expect(service.markFaulty(binToUuid(UNIT_ID))).rejects.toBeInstanceOf(NotFoundException);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
