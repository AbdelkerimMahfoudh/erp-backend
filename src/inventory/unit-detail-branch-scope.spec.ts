import { NotFoundException } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { uuidToBin } from '../common/utils/uuid.util';

/**
 * `GET /units/:identifier` and another branch's phone.
 *
 * The route has no `@RequirePermissions`, and the lookup was scoped by company
 * only — so a Store Manager of one branch read a phone of the other branch by
 * its IMEI: its branch, purchase reference, cost (through their own branch's
 * `cost.view`) and an audit timeline naming staff (found live). A unit outside
 * the caller's assigned branches now answers exactly like an unknown number, as
 * the sale lookup and the intake duplicate check already do.
 */

const id = (n: number) => uuidToBin(`00000000-0000-7000-8000-${String(n).padStart(12, '0')}`);
const MINE = id(1);
const THEIRS = id(2);
const USER = id(3);

function unitIn(branchId: Buffer, imei: string) {
  return {
    id: id(Number(imei.slice(-2))),
    branchId,
    imeiPrimary: imei,
    status: 'in_stock',
    cost: 15000,
    product: { brand: 'Apple', model: 'iPhone 15', trackingType: 'imei' },
    branch: { id: branchId, name: branchId.equals(MINE) ? 'Mine' : 'Theirs' },
    purchase: { referenceNo: 'P-1', date: new Date('2026-10-01') },
  };
}

function makeService(assignedTo: Buffer[]) {
  const units = [unitIn(MINE, '356888000000011'), unitIn(THEIRS, '356888000000012')];
  const db = {
    unit: {
      findFirst: async ({ where }: any) =>
        units.find((u) => where.OR.some((c: Record<string, string>) => c.imeiPrimary === u.imeiPrimary)) ?? null,
    },
    userBranch: {
      findMany: async ({ where }: any) =>
        where.userId.equals(USER) ? assignedTo.map((branchId) => ({ branchId })) : [],
    },
    auditLog: { findMany: jest.fn(async () => []) },
    user: { findMany: async () => [] },
    branch: { findMany: async () => [] },
  };
  const tenant = { branchId: () => MINE, userId: () => USER, requireUserId: () => USER };
  const service = new InventoryService(db as never, tenant as never, {} as never, {} as never, {} as never, { get: () => undefined } as never);
  return { service, db };
}

describe('unit detail is confined to the caller’s branches', () => {
  it('finds a unit of a branch the caller is assigned to, with its timeline', async () => {
    const { service } = makeService([MINE]);

    const unit = await service.findByIdentifierWithTimeline('356888000000011');

    expect(unit.imeiPrimary).toBe('356888000000011');
    expect(unit.timeline).toEqual([]);
  });

  it('answers a unit of another branch exactly as a number that exists nowhere', async () => {
    const { service, db } = makeService([MINE]);

    const elsewhere = service.findByIdentifierWithTimeline('356888000000012');
    await expect(elsewhere).rejects.toBeInstanceOf(NotFoundException);
    await expect(elsewhere).rejects.toThrow(/^Unit not found$/);
    await expect(service.findByIdentifierWithTimeline('356888000000099')).rejects.toThrow(/^Unit not found$/);
    // Nothing about the other branch's unit is read, not even its history.
    expect(db.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('someone assigned to both branches (the Owner) still finds it', async () => {
    const { service } = makeService([MINE, THEIRS]);

    const unit = await service.findByIdentifierWithTimeline('356888000000012');

    expect(unit.branchId).toEqual(THEIRS);
  });
});

describe('the unit detail carries what its picture is drawn from (D225)', () => {
  it('reads the product with its category key, chosen icon and parent', async () => {
    const { service, db } = makeService([MINE]);
    const findFirst = jest.spyOn(db.unit, 'findFirst');

    await service.findByIdentifierWithTimeline('356888000000011');

    expect(findFirst.mock.calls[0][0].include.product).toEqual({
      include: { category: { select: { id: true, key: true, icon: true, parent: { select: { key: true, icon: true } } } } },
    });
  });
});
