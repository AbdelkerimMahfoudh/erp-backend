import { ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { binToUuid } from '../common/utils/uuid.util';
import {
  Db,
  DEST,
  emptyDb,
  OWNER,
  OWNER_PERMISSIONS,
  seedBranchesAndPeople,
  seedUnit,
  SOURCE,
} from './__testing__/transfer-db';
import { Harness, makeHarness } from './__testing__/harness';

/**
 * Stock goes only where it can be sold (D156, reviewed 2026-10-09).
 *
 * A branch subscribed to money services alone sells no electronics, so a
 * transfer INTO it would leave the units in transit with nowhere to land:
 * refused at creation, by name. A branch that changed activity still holds
 * stock and empties itself: a transfer OUT of it stays open.
 */

let db: Db;
let h: Harness;

beforeEach(() => {
  db = emptyDb();
  seedBranchesAndPeople(db);
  h = makeHarness(db, { userId: OWNER, branchId: SOURCE, permissions: OWNER_PERMISSIONS });
});

const setActivity = (id: Buffer, activity: string) => {
  const branch = db.branch.find((b) => (b.id as Buffer).equals(id))!;
  branch.activity = activity;
};

async function transfer(from: Buffer, to: Buffer) {
  h.act({ userId: OWNER, branchId: from, permissions: OWNER_PERMISSIONS });
  const unit = seedUnit(db, { branchId: from });
  return h.service.create({ clientUuid: randomUUID(), toBranchId: binToUuid(to), identifiers: [unit.imeiPrimary as string] });
}

describe('a transfer and the destination’s activity', () => {
  it('refuses a transfer into a money-services-only branch, naming what it is and what it would need; nothing is reserved', async () => {
    setActivity(DEST, 'money_agent');
    const refusal = await transfer(SOURCE, DEST).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ForbiddenException);
    expect((refusal as ForbiddenException).getResponse()).toMatchObject({
      code: 'activity_not_subscribed',
      activity: 'money_agent',
      required: 'electronics',
    });
    expect(JSON.stringify((refusal as ForbiddenException).getResponse())).toMatch(/Warehouse/);
    expect(db.stockTransfer).toHaveLength(0);
    expect(db.unit.every((u) => u.status === 'in_stock')).toBe(true);
  });

  it('a branch that sells electronics, alone or beside the counter, receives as before', async () => {
    for (const activity of ['electronics', 'both']) {
      setActivity(DEST, activity);
      const created = (await transfer(SOURCE, DEST)) as { status: string };
      expect(created.status).toBeDefined();
    }
    expect(db.stockTransfer).toHaveLength(2);
  });

  it('a branch that became money services only still sends its remaining stock out', async () => {
    setActivity(SOURCE, 'money_agent');
    const created = (await transfer(SOURCE, DEST)) as { status: string };
    expect(created.status).toBeDefined();
    expect(db.stockTransfer).toHaveLength(1);
  });
});
