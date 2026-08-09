import { randomUUID } from 'node:crypto';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import {
  BOTH_BRANCH_EMPLOYEE,
  COMPANY,
  Db,
  deactivate,
  DEST,
  DEST_EMPLOYEE,
  DEST_MANAGER,
  emptyDb,
  EMPLOYEE,
  EMPLOYEE_PERMISSIONS,
  MANAGER,
  MANAGER_PERMISSIONS,
  OTHER_COMPANY,
  OWNER,
  OWNER_PERMISSIONS,
  seedBranchesAndPeople,
  seedUnit,
  SOURCE,
} from './__testing__/transfer-db';
import { Harness, makeHarness } from './__testing__/harness';

/**
 * Who gets told what, when a transfer moves (H1.3 CP2).
 *
 * H1.2 shipped a workflow nobody could see. These tests pin the part that makes
 * it usable — and, just as importantly, the parts that must NOT happen: no
 * notification for a transition that rolled back, no second copy on a retry, no
 * telling somebody about their own action, and no money in the message.
 */

let db: Db;
let h: Harness;

const asEmployee = () => h.act({ userId: EMPLOYEE, branchId: SOURCE, permissions: EMPLOYEE_PERMISSIONS });
const asManager = () => h.act({ userId: MANAGER, branchId: SOURCE, permissions: MANAGER_PERMISSIONS });
const asDestManager = () =>
  h.act({ userId: DEST_MANAGER, branchId: DEST, permissions: MANAGER_PERMISSIONS });

beforeEach(() => {
  db = emptyDb();
  seedBranchesAndPeople(db);
  h = makeHarness(db, { userId: EMPLOYEE, branchId: SOURCE, permissions: EMPLOYEE_PERMISSIONS });
});

async function request() {
  const unit = seedUnit(db, { branchId: SOURCE });
  const created = (await h.service.create({
    clientUuid: randomUUID(),
    toBranchId: binToUuid(DEST),
    identifiers: [unit.imeiPrimary as string],
  })) as { id: string; version: number; status: string };
  return { ...created, identifier: unit.imeiPrimary as string };
}

/** Everyone told about this event, as a sorted set of hex user ids. */
const told = (event: string): string[] =>
  db.notification
    .filter((n) => n.type === `transfer.${event}`)
    .map((n) => (n.targetUserId as Buffer).toString('hex'))
    .sort();

const ids = (...users: Buffer[]) => users.map((u) => u.toString('hex')).sort();

const notificationsFor = (userId: Buffer) =>
  db.notification.filter((n) => (n.targetUserId as Buffer | null)?.equals(userId));

// ───────────────────────────── recipients per event ───────────────────────

describe('each event reaches exactly the people it concerns', () => {
  it('a request notifies the people who can approve it, and nobody else', async () => {
    asEmployee();
    await request();

    // Owner and Manager hold transfer.approve in the source branch. The
    // destination has no say in whether a request is granted.
    expect(told('requested')).toEqual(ids(OWNER, MANAGER));
    expect(notificationsFor(DEST_MANAGER)).toHaveLength(0);
    expect(notificationsFor(DEST_EMPLOYEE)).toHaveLength(0);
  });

  it('an auto-approved transfer tells the destination instead — there is nothing to approve', async () => {
    asManager();
    await request();

    expect(told('requested')).toEqual([]);
    expect(told('created_approved')).toEqual(
      ids(OWNER, DEST_MANAGER, DEST_EMPLOYEE, BOTH_BRANCH_EMPLOYEE),
    );
  });

  it('an approval reaches the requester, the shippers and the destination', async () => {
    asEmployee();
    const t = await request();
    asManager();
    await h.service.approve(t.id, { expectedVersion: t.version });

    expect(told('approved')).toEqual(
      ids(EMPLOYEE, OWNER, BOTH_BRANCH_EMPLOYEE, DEST_MANAGER, DEST_EMPLOYEE),
    );
  });

  it('a refusal reaches only the person who asked', async () => {
    asEmployee();
    const t = await request();
    asManager();
    await h.service.reject(t.id, { expectedVersion: t.version, reason: 'No spare stock' });

    // Broadcasting a refusal helps nobody and embarrasses somebody.
    expect(told('rejected')).toEqual(ids(EMPLOYEE));
  });

  it('a shipment reaches the people who will receive it', async () => {
    asEmployee();
    const t = await request();
    asManager();
    await h.service.approve(t.id, { expectedVersion: t.version });
    asEmployee();
    await h.service.ship(t.id, { expectedVersion: t.version + 1 });

    expect(told('shipped')).toEqual(
      ids(OWNER, DEST_MANAGER, DEST_EMPLOYEE, BOTH_BRANCH_EMPLOYEE),
    );
  });

  it('an arrival closes the loop for the requester and the source approvers', async () => {
    asEmployee();
    const t = await request();
    asManager();
    await h.service.approve(t.id, { expectedVersion: t.version });
    asEmployee();
    await h.service.ship(t.id, { expectedVersion: t.version + 1 });

    asDestManager();
    await h.service.receiveConfirm(t.id, {
      identifiers: [t.identifier],
      expectedVersion: t.version + 2,
    });

    expect(told('received')).toEqual(ids(EMPLOYEE, OWNER, MANAGER));
  });

  it('a cancellation reaches everybody who was already involved', async () => {
    asEmployee();
    const t = await request();
    asManager();
    await h.service.cancel(t.id, { expectedVersion: t.version, reason: 'Needed here after all' });

    expect(told('cancelled')).toEqual(
      ids(EMPLOYEE, OWNER, DEST_MANAGER, DEST_EMPLOYEE, BOTH_BRANCH_EMPLOYEE),
    );
  });
});

// ───────────────────────────── dedup, actor, isolation ────────────────────

describe('nobody is told twice, and nobody is told about themselves', () => {
  /**
   * The Owner is assigned to the source, the destination AND a third branch, and
   * qualifies as both an approver and a receiver. One person, one notification.
   */
  it('a person who qualifies through several branches and roles is told once', async () => {
    asEmployee();
    const t = await request();
    asManager();
    await h.service.approve(t.id, { expectedVersion: t.version });

    const ownersCopies = db.notification.filter(
      (n) => (n.targetUserId as Buffer).equals(OWNER) && n.type === 'transfer.approved',
    );
    expect(ownersCopies).toHaveLength(1);
  });

  it('the actor is never told about their own action', async () => {
    asManager();
    const t = await request(); // manager auto-approves their own request
    expect(notificationsFor(MANAGER)).toHaveLength(0);

    asEmployee();
    await h.service.ship(t.id, { expectedVersion: 0 });
    // The employee shipped it, so the shipment is not news to them.
    expect(
      notificationsFor(EMPLOYEE).filter((n) => n.type === 'transfer.shipped'),
    ).toHaveLength(0);
  });

  it('a requester who is also an approver is not told about their own approval', async () => {
    // The Owner requests (auto-approved) and would otherwise qualify as
    // requester, shipper and receiver all at once.
    h.act({ userId: OWNER, branchId: SOURCE, permissions: OWNER_PERMISSIONS });
    await request();
    expect(notificationsFor(OWNER)).toHaveLength(0);
  });

  it('a deactivated approver is not notified', async () => {
    deactivate(db, MANAGER);
    asEmployee();
    await request();

    expect(told('requested')).toEqual(ids(OWNER));
  });

  it('another company’s users are never notified, even in a branch of the same id', async () => {
    // A foreign user assigned to a branch id that also exists here. The tenant
    // client must not see them at all.
    const foreign = newUuidV7Bin();
    db.user.push({ id: foreign, companyId: OTHER_COMPANY, name: 'Outsider', isActive: true, deletedAt: null });
    db.userBranch.push({
      id: newUuidV7Bin(),
      companyId: OTHER_COMPANY,
      userId: foreign,
      branchId: SOURCE,
      roleKey: 'owner',
      rolePermissionKeys: OWNER_PERMISSIONS,
      user: { isActive: true, deletedAt: null },
    });

    asEmployee();
    await request();

    expect(told('requested')).toEqual(ids(OWNER, MANAGER));
    expect(db.notification.every((n) => (n.companyId as Buffer).equals(COMPANY))).toBe(true);
  });
});

// ───────────────────────────── nothing on a failure ───────────────────────

describe('a notification only ever accompanies a transition that committed', () => {
  it('a stale approval creates no notification', async () => {
    asEmployee();
    const t = await request();
    const before = db.notification.length;

    asManager();
    await expect(h.service.approve(t.id, { expectedVersion: 99 })).rejects.toThrow();

    expect(db.notification).toHaveLength(before);
    expect(told('approved')).toEqual([]);
  });

  it('a refusal without a reason creates no notification', async () => {
    asEmployee();
    const t = await request();
    const before = db.notification.length;

    asManager();
    await expect(h.service.reject(t.id, { expectedVersion: t.version })).rejects.toThrow();
    expect(db.notification).toHaveLength(before);
  });

  it('a cancel refused for lack of authority creates no notification', async () => {
    asManager();
    const t = await request();
    const before = db.notification.length;

    asEmployee();
    await expect(
      h.service.cancel(t.id, { expectedVersion: t.version, reason: 'not mine' }),
    ).rejects.toThrow();
    expect(db.notification).toHaveLength(before);
  });

  it('a request that cannot reserve its stock notifies nobody', async () => {
    asEmployee();
    const unit = seedUnit(db, { branchId: SOURCE, status: 'sold' });
    await expect(
      h.service.create({
        clientUuid: randomUUID(),
        toBranchId: binToUuid(DEST),
        identifiers: [unit.imeiPrimary as string],
      }),
    ).rejects.toThrow();

    expect(db.notification).toHaveLength(0);
  });
});

// ───────────────────────────── replay and duplication ─────────────────────

describe('a retry never produces a second copy', () => {
  it('an idempotent create replay creates no further notifications', async () => {
    asEmployee();
    const unit = seedUnit(db, { branchId: SOURCE });
    const payload = {
      clientUuid: randomUUID(),
      toBranchId: binToUuid(DEST),
      identifiers: [unit.imeiPrimary as string],
    };

    const first = await h.service.create(payload);
    const after = db.notification.length;
    expect(after).toBe(2); // owner + manager

    const replay = await h.service.create(payload);
    expect((replay as { id: string }).id).toBe((first as { id: string }).id);
    expect(db.notification).toHaveLength(after);
  });

  /**
   * The database is the arbiter, not an application pre-check. Writing the same
   * event twice must be REJECTED by the unique index — this asserts the
   * constraint exists and holds, rather than that the service remembered.
   */
  it('the unique key refuses a duplicate event for the same person', async () => {
    asEmployee();
    const t = await request();
    const one = db.notification.find((n) => n.type === 'transfer.requested')!;

    await expect(
      (h.service as unknown as { db: { notification: { create(a: unknown): Promise<unknown> } } }).db.notification.create(
        {
          data: {
            id: newUuidV7Bin(),
            companyId: COMPANY,
            branchId: SOURCE,
            targetUserId: one.targetUserId,
            type: 'transfer.requested',
            title: 'duplicate',
            dedupeKey: one.dedupeKey,
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'P2002' });

    expect(told('requested')).toEqual(ids(OWNER, MANAGER));
    expect(t.status).toBe('pending_approval');
  });

  it('the same person can still be told about a DIFFERENT event on the same transfer', async () => {
    asEmployee();
    const t = await request();
    asManager();
    await h.service.approve(t.id, { expectedVersion: t.version });

    // The Owner hears about the request AND the approval: different events,
    // different keys, both legitimate.
    const ownerKeys = notificationsFor(OWNER).map((n) => n.dedupeKey);
    expect(ownerKeys).toHaveLength(2);
    expect(new Set(ownerKeys).size).toBe(2);
  });
});

// ───────────────────────────── the message itself ─────────────────────────

describe('what a notification says', () => {
  it('names both branches and the transfer reference, and points at the exact transfer', async () => {
    asEmployee();
    const t = await request();
    const n = db.notification.find((x) => x.type === 'transfer.requested')!;
    const payload = n.payload as Record<string, unknown>;

    expect(payload.fromBranch).toBe('Main Store');
    expect(payload.toBranch).toBe('Warehouse');
    expect(payload.transferNo).toBe('TRF-000001');
    expect(payload.units).toBe(1);
    expect(payload.actor).toBe('Salma the Employee');

    // Never a generic list.
    expect(n.actionLink).toBe(`/transfers/${t.id}`);
  });

  it('carries the decision reason on a refusal', async () => {
    asEmployee();
    const t = await request();
    asManager();
    await h.service.reject(t.id, { expectedVersion: t.version, reason: 'Needed for a customer here' });

    const n = db.notification.find((x) => x.type === 'transfer.rejected')!;
    expect((n.payload as Record<string, unknown>).reason).toBe('Needed for a customer here');
    expect(n.body).toContain('Needed for a customer here');
  });

  /**
   * A notification is read outside the request that authorized it, so it must
   * never become a way around cost gating. The unit in these fixtures costs
   * 1000; that number must appear nowhere.
   */
  it('never carries a cost, price or margin', async () => {
    asEmployee();
    const t = await request();
    asManager();
    await h.service.approve(t.id, { expectedVersion: t.version });

    for (const n of db.notification) {
      const text = JSON.stringify({ title: n.title, body: n.body, payload: n.payload });
      expect(text).not.toMatch(/1000/);
      expect(text.toLowerCase()).not.toMatch(/cost|margin|profit|price/);
    }
    expect(t.status).toBe('pending_approval');
  });

  it('types every notification as transfer.<event>, so the app can localise it', async () => {
    asEmployee();
    const t = await request();
    asManager();
    await h.service.approve(t.id, { expectedVersion: t.version });

    const types = new Set(db.notification.map((n) => n.type));
    expect(types).toEqual(new Set(['transfer.requested', 'transfer.approved']));
    // Every row carries the fields the app needs to build its own sentence.
    for (const n of db.notification) {
      expect(n.payload).toMatchObject({ transferNo: expect.any(String), units: expect.any(Number) });
    }
  });
});
