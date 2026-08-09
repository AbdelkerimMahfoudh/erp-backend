import { ConflictException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { binToUuid } from '../common/utils/uuid.util';
import {
  BOTH_BRANCH_EMPLOYEE,
  Db,
  DEST,
  emptyDb,
  EMPLOYEE,
  EMPLOYEE_PERMISSIONS,
  MANAGER,
  MANAGER_PERMISSIONS,
  OWNER,
  OWNER_PERMISSIONS,
  seedBranchesAndPeople,
  seedUnit,
  SOURCE,
  THIRD,
} from './__testing__/transfer-db';
import { Harness, makeHarness } from './__testing__/harness';

/**
 * The seven H1.2 behaviour requirements, reconciled (H1.3 CP1).
 *
 * H1.2 proved these live, against real sessions and real MySQL, but left no
 * standing test — so nothing would catch a regression, and the report did not
 * clearly evidence Manager/Owner auto-approval on create. These tests pin all
 * seven in the suite, against the real service.
 *
 * The concurrency guarantees are asserted here as compare-and-swap CONTRACTS
 * (the loser matches no row and is refused). Genuine simultaneity is proven
 * against real MySQL in the live verification, where the row lock is real.
 */

let db: Db;
let h: Harness;

const asEmployee = () => h.act({ userId: EMPLOYEE, branchId: SOURCE, permissions: EMPLOYEE_PERMISSIONS });
const asManager = () => h.act({ userId: MANAGER, branchId: SOURCE, permissions: MANAGER_PERMISSIONS });
const asOwner = (branchId = SOURCE) => h.act({ userId: OWNER, branchId, permissions: OWNER_PERMISSIONS });

beforeEach(() => {
  db = emptyDb();
  seedBranchesAndPeople(db);
  h = makeHarness(db, { userId: EMPLOYEE, branchId: SOURCE, permissions: EMPLOYEE_PERMISSIONS });
});

/** Request a transfer of one fresh unit, as whoever is currently acting. */
async function request(): Promise<{ id: string; version: number; status: string; identifier: string }> {
  const unit = seedUnit(db, { branchId: SOURCE });
  const created = (await h.service.create({
    clientUuid: randomUUID(),
    toBranchId: binToUuid(DEST),
    identifiers: [unit.imeiPrimary as string],
  })) as { id: string; version: number; status: string };
  return { ...created, identifier: unit.imeiPrimary as string };
}

const statusOf = (id: string) =>
  db.stockTransfer.find((t) => binToUuid(t.id) === id)!.status as string;

const unitStatus = (identifier: string) =>
  db.unit.find((u) => u.imeiPrimary === identifier)!.status as string;

// ───────────────────────── §2.1 and §2.2 — who needs approval ─────────────

describe('a request starts approved only when the requester could have approved it', () => {
  it('an Employee request starts pending_approval, reserved and unapproved', async () => {
    asEmployee();
    const t = await request();

    expect(t.status).toBe('pending_approval');
    expect(statusOf(t.id)).toBe('pending_approval');
    // H1.1's guarantee runs from the moment stock is promised, not from shipment.
    expect(unitStatus(t.identifier)).toBe('reserved');

    const row = db.stockTransfer.find((r) => binToUuid(r.id) === t.id)!;
    expect(row.autoApproved).toBe(false);
    expect(row.approvedById ?? null).toBeNull();
    expect(row.approvedAt ?? null).toBeNull();
    expect((row.requestedById as Buffer).equals(EMPLOYEE)).toBe(true);
  });

  /**
   * The requirement H1.2 shipped but never pinned in a test. Making a manager
   * approve their own request would be ceremony, not control — but the row must
   * still say WHO approved it, or the trail shows an approved transfer with no
   * approver.
   */
  it('a Manager request is born approved, with the approver and the auto flag recorded', async () => {
    asManager();
    const t = await request();

    expect(t.status).toBe('approved');
    expect(statusOf(t.id)).toBe('approved');
    expect(unitStatus(t.identifier)).toBe('reserved');

    const row = db.stockTransfer.find((r) => binToUuid(r.id) === t.id)!;
    expect(row.autoApproved).toBe(true);
    expect((row.approvedById as Buffer).equals(MANAGER)).toBe(true);
    expect(row.approvedAt).toBeInstanceOf(Date);
    expect((row.requestedById as Buffer).equals(MANAGER)).toBe(true);
  });

  it('an Owner request is born approved in exactly the same way', async () => {
    asOwner();
    const t = await request();

    expect(t.status).toBe('approved');
    const row = db.stockTransfer.find((r) => binToUuid(r.id) === t.id)!;
    expect(row.autoApproved).toBe(true);
    expect((row.approvedById as Buffer).equals(OWNER)).toBe(true);
  });

  /**
   * Auto-approval is decided by the permission IN THE ACTIVE BRANCH, never by a
   * role name. A manager of another branch requesting stock out of this one has
   * no authority to approve it here, so their request must wait.
   */
  it('is decided by the permission held here, not by the role the person has elsewhere', async () => {
    // Same person, same role name — but without transfer.approve in this branch.
    h.act({ userId: MANAGER, branchId: SOURCE, permissions: EMPLOYEE_PERMISSIONS });
    const t = await request();

    expect(t.status).toBe('pending_approval');
    expect(db.stockTransfer.find((r) => binToUuid(r.id) === t.id)!.autoApproved).toBe(false);
  });

  it('an approved-on-create transfer can ship without anybody approving it again', async () => {
    asManager();
    const t = await request();

    await h.service.ship(t.id, { expectedVersion: 0 });
    expect(statusOf(t.id)).toBe('in_transit');
    expect(unitStatus(t.identifier)).toBe('in_transit');
  });
});

// ───────────────────────── §2.6 — separation of duties ────────────────────

describe('an employee cannot approve their own way out of the workflow', () => {
  it('cannot ship a request that is still pending', async () => {
    asEmployee();
    const t = await request();

    await expect(h.service.ship(t.id, { expectedVersion: t.version })).rejects.toThrow(
      /cannot become 'in_transit'/,
    );
    expect(statusOf(t.id)).toBe('pending_approval');
    expect(unitStatus(t.identifier)).toBe('reserved');
  });

  /**
   * The case the H0 audit called out by name: an employee assigned to BOTH
   * branches used to be able to run a whole transfer alone. Branch assignment is
   * no longer the only control — approval is a permission they do not hold, so
   * being at both ends buys them nothing.
   */
  it('an employee assigned to both branches still cannot approve or reject their own request', async () => {
    h.act({ userId: BOTH_BRANCH_EMPLOYEE, branchId: SOURCE, permissions: EMPLOYEE_PERMISSIONS });
    const t = await request();

    expect(t.status).toBe('pending_approval');
    // The route guard holds `transfer.approve`, which this employee lacks in
    // either branch; the permission set above is exactly what 0031 grants them.
    expect(EMPLOYEE_PERMISSIONS).not.toContain('transfer.approve');
    expect(EMPLOYEE_PERMISSIONS).not.toContain('transfer.cancel');

    // And with the branch switched to the destination, still nothing changes.
    h.act({ branchId: DEST });
    await expect(h.service.approve(t.id, { expectedVersion: t.version })).rejects.toThrow(
      ForbiddenException,
    );
    expect(statusOf(t.id)).toBe('pending_approval');
  });
});

// ───────────────────────── §2.3 and §2.4 — cancellation ───────────────────

describe('cancellation authority', () => {
  it('an employee may withdraw their own pending request, releasing the stock', async () => {
    asEmployee();
    const t = await request();

    await h.service.cancel(t.id, { expectedVersion: t.version, reason: 'Customer changed their mind' });

    expect(statusOf(t.id)).toBe('cancelled');
    expect(unitStatus(t.identifier)).toBe('in_stock');
    const row = db.stockTransfer.find((r) => binToUuid(r.id) === t.id)!;
    expect(row.decisionReason).toBe('Customer changed their mind');
  });

  it('an employee may NOT withdraw somebody else’s request', async () => {
    asManager();
    const t = await request(); // manager's own, born approved

    asEmployee();
    await expect(
      h.service.cancel(t.id, { expectedVersion: t.version, reason: 'not mine to cancel' }),
    ).rejects.toThrow(/only withdraw a request you made yourself/);
    expect(statusOf(t.id)).toBe('approved');
    expect(unitStatus(t.identifier)).toBe('reserved');
  });

  it('an employee may NOT withdraw their own request once a manager has approved it', async () => {
    asEmployee();
    const t = await request();

    asManager();
    await h.service.approve(t.id, { expectedVersion: t.version });

    asEmployee();
    await expect(
      h.service.cancel(t.id, { expectedVersion: t.version + 1, reason: 'changed my mind' }),
    ).rejects.toThrow(/already been acted on/);
    expect(statusOf(t.id)).toBe('approved');
  });

  it('a manager may cancel somebody else’s pending request', async () => {
    asEmployee();
    const t = await request();

    asManager();
    await h.service.cancel(t.id, { expectedVersion: t.version, reason: 'Stock needed here' });

    expect(statusOf(t.id)).toBe('cancelled');
    expect(unitStatus(t.identifier)).toBe('in_stock');
  });

  it('a manager may cancel an approved transfer that has not shipped', async () => {
    asEmployee();
    const t = await request();
    asManager();
    await h.service.approve(t.id, { expectedVersion: t.version });

    await h.service.cancel(t.id, { expectedVersion: t.version + 1, reason: 'Sale at this branch instead' });

    expect(statusOf(t.id)).toBe('cancelled');
    expect(unitStatus(t.identifier)).toBe('in_stock');
  });

  it('both reject and cancel demand a reason, and refuse without one', async () => {
    asEmployee();
    const a = await request();
    await expect(h.service.cancel(a.id, { expectedVersion: a.version, reason: '   ' })).rejects.toThrow(
      /Say why/,
    );
    expect(statusOf(a.id)).toBe('pending_approval');

    asManager();
    await expect(h.service.reject(a.id, { expectedVersion: a.version })).rejects.toThrow(/Say why/);
    expect(statusOf(a.id)).toBe('pending_approval');
    // Refusing did not quietly release the stock either.
    expect(unitStatus(a.identifier)).toBe('reserved');
  });

  it('cancelling is refused from anywhere but the source branch', async () => {
    asEmployee();
    const t = await request();

    h.act({ branchId: DEST });
    await expect(
      h.service.cancel(t.id, { expectedVersion: t.version, reason: 'wrong end' }),
    ).rejects.toThrow(/Cancel from the branch the stock is leaving/);
    expect(statusOf(t.id)).toBe('pending_approval');
  });
});

// ───────────────────────── §2.5 — nothing cancels after shipment ──────────

describe('no role can cancel a transfer that has left, or one already finished', () => {
  it('refuses to cancel an in_transit transfer, even for an Owner', async () => {
    asManager();
    const t = await request();
    await h.service.ship(t.id, { expectedVersion: 0 });

    asOwner();
    await expect(
      h.service.cancel(t.id, { expectedVersion: 1, reason: 'call it back' }),
    ).rejects.toThrow(/already been shipped and cannot be cancelled/);

    expect(statusOf(t.id)).toBe('in_transit');
    expect(unitStatus(t.identifier)).toBe('in_transit');
  });

  it('refuses to cancel a received, rejected or already-cancelled transfer', async () => {
    // received
    asManager();
    const received = await request();
    await h.service.ship(received.id, { expectedVersion: 0 });
    h.act({ branchId: DEST });
    await h.service.receiveConfirm(received.id, {
      identifiers: [received.identifier],
      expectedVersion: 1,
    });
    expect(statusOf(received.id)).toBe('received');
    asOwner();
    await expect(
      h.service.cancel(received.id, { expectedVersion: 2, reason: 'undo' }),
    ).rejects.toThrow(/cannot become 'cancelled'/);

    // rejected
    asEmployee();
    const rejected = await request();
    asManager();
    await h.service.reject(rejected.id, { expectedVersion: rejected.version, reason: 'no spare stock' });
    await expect(
      h.service.cancel(rejected.id, { expectedVersion: rejected.version + 1, reason: 'undo' }),
    ).rejects.toThrow(/cannot become 'cancelled'/);

    // already cancelled
    asEmployee();
    const cancelled = await request();
    await h.service.cancel(cancelled.id, { expectedVersion: cancelled.version, reason: 'mistake' });
    /**
     * Two different rules refuse this, and which one speaks depends on who asks.
     * The requester is stopped by ownership — their request is no longer pending,
     * so it is not theirs to undo. A manager gets past that and is stopped by the
     * state machine instead. Both are refusals; neither is a state change.
     */
    await expect(
      h.service.cancel(cancelled.id, { expectedVersion: cancelled.version + 1, reason: 'again' }),
    ).rejects.toThrow(/already been acted on/);

    asManager();
    await expect(
      h.service.cancel(cancelled.id, { expectedVersion: cancelled.version + 1, reason: 'again' }),
    ).rejects.toThrow(/cannot become 'cancelled'/);
    expect(statusOf(cancelled.id)).toBe('cancelled');
  });

  it('a released unit is not released a second time by a repeated cancel', async () => {
    asEmployee();
    const t = await request();
    await h.service.cancel(t.id, { expectedVersion: t.version, reason: 'mistake' });
    expect(unitStatus(t.identifier)).toBe('in_stock');

    // Sell it, then replay the cancel: the release must not resurrect the unit.
    db.unit.find((u) => u.imeiPrimary === t.identifier)!.status = 'sold';
    await expect(
      h.service.cancel(t.id, { expectedVersion: t.version + 1, reason: 'again' }),
    ).rejects.toThrow();
    expect(unitStatus(t.identifier)).toBe('sold');
  });
});

// ───────────────────────── §2.7 — optimistic concurrency ──────────────────

describe('every decision carries the version the caller last saw', () => {
  it('a stale approval is refused rather than overwriting the decision made', async () => {
    asEmployee();
    const t = await request();

    asManager();
    await h.service.approve(t.id, { expectedVersion: 0 });

    // A second manager still holding version 0 arrives.
    await expect(h.service.approve(t.id, { expectedVersion: 0 })).rejects.toThrow(ConflictException);
    expect(statusOf(t.id)).toBe('approved');
  });

  it('approve and reject cannot both win — the loser is told to refresh', async () => {
    asEmployee();
    const t = await request();

    asManager();
    await h.service.approve(t.id, { expectedVersion: 0 });
    await expect(
      h.service.reject(t.id, { expectedVersion: 0, reason: 'no stock to spare' }),
    ).rejects.toThrow(ConflictException);

    expect(statusOf(t.id)).toBe('approved');
    // The loser must not have released stock the winner still holds.
    expect(unitStatus(t.identifier)).toBe('reserved');
  });

  it('ship and cancel cannot both win', async () => {
    asManager();
    const t = await request();

    await h.service.ship(t.id, { expectedVersion: 0 });
    await expect(
      h.service.cancel(t.id, { expectedVersion: 0, reason: 'too late' }),
    ).rejects.toThrow(/already been shipped/);

    expect(statusOf(t.id)).toBe('in_transit');
  });

  it('a stale cancel is refused, and releases nothing', async () => {
    asEmployee();
    const t = await request();
    asManager();
    await h.service.approve(t.id, { expectedVersion: 0 });

    await expect(
      h.service.cancel(t.id, { expectedVersion: 0, reason: 'stale' }),
    ).rejects.toThrow(ConflictException);
    expect(statusOf(t.id)).toBe('approved');
    expect(unitStatus(t.identifier)).toBe('reserved');
  });

  it('a failed transition leaves the reservation exactly as it was', async () => {
    asEmployee();
    const t = await request();

    asManager();
    await expect(
      h.service.reject(t.id, { expectedVersion: 99, reason: 'nope' }),
    ).rejects.toThrow(ConflictException);

    // The whole transaction rolled back: status, reason and reservation intact.
    const row = db.stockTransfer.find((r) => binToUuid(r.id) === t.id)!;
    expect(row.status).toBe('pending_approval');
    expect(row.decisionReason ?? null).toBeNull();
    expect(unitStatus(t.identifier)).toBe('reserved');
  });
});

// ───────────────────────── branch authority on every route ────────────────

describe('the source and destination ends each own their own actions', () => {
  it('approval and rejection are refused from anywhere but the source branch', async () => {
    asEmployee();
    const t = await request();

    h.act({ userId: OWNER, branchId: DEST, permissions: OWNER_PERMISSIONS });
    await expect(h.service.approve(t.id, { expectedVersion: 0 })).rejects.toThrow(
      /Approve from the branch the stock is leaving/,
    );
    await expect(h.service.reject(t.id, { expectedVersion: 0, reason: 'no' })).rejects.toThrow(
      /Reject from the branch the stock is leaving/,
    );

    // The same Owner, having switched to the source branch, may act.
    asOwner(SOURCE);
    await h.service.approve(t.id, { expectedVersion: 0 });
    expect(statusOf(t.id)).toBe('approved');
  });

  it('an Owner cannot approve from an unrelated third branch either', async () => {
    asEmployee();
    const t = await request();

    asOwner(THIRD);
    await expect(h.service.approve(t.id, { expectedVersion: 0 })).rejects.toThrow(ForbiddenException);
    expect(statusOf(t.id)).toBe('pending_approval');
  });

  it('shipping is refused from the destination, receiving from the source', async () => {
    asManager();
    const t = await request();

    h.act({ branchId: DEST });
    await expect(h.service.ship(t.id, { expectedVersion: 0 })).rejects.toThrow(
      /Ship from the origin branch/,
    );

    h.act({ branchId: SOURCE });
    await h.service.ship(t.id, { expectedVersion: 0 });
    await expect(
      h.service.receiveConfirm(t.id, { identifiers: [t.identifier], expectedVersion: 1 }),
    ).rejects.toThrow(/Receive at the destination branch/);

    h.act({ branchId: DEST });
    await h.service.receiveConfirm(t.id, { identifiers: [t.identifier], expectedVersion: 1 });
    expect(statusOf(t.id)).toBe('received');
    // The phone is now in stock AT THE DESTINATION.
    const unit = db.unit.find((u) => u.imeiPrimary === t.identifier)!;
    expect(unit.status).toBe('in_stock');
    expect((unit.branchId as Buffer).equals(DEST)).toBe(true);
  });
});
