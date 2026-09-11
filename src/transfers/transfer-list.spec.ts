import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { binToUuid } from '../common/utils/uuid.util';
import { ListTransfersDto } from './dto/transfer.dto';
import { computeActions, requestedAtOf } from './transfer-view';
import {
  DEST,
  DEST_MANAGER,
  Db,
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
 * The list, counts and detail contract (H1.3 CP3).
 *
 * The list used to be `take: 100`, no filter, no search, raw rows — so a busy
 * shop lost its older history and the app would have had to filter locally.
 * A client-side filter answers "not found" for something that exists, which is
 * worse than no search at all.
 */

let db: Db;
let h: Harness;

const asEmployee = () => h.act({ userId: EMPLOYEE, branchId: SOURCE, permissions: EMPLOYEE_PERMISSIONS });
const asManager = () => h.act({ userId: MANAGER, branchId: SOURCE, permissions: MANAGER_PERMISSIONS });

beforeEach(() => {
  db = emptyDb();
  seedBranchesAndPeople(db);
  h = makeHarness(db, { userId: EMPLOYEE, branchId: SOURCE, permissions: EMPLOYEE_PERMISSIONS });
});

async function request(opts: { to?: Buffer; imei?: string; brand?: string } = {}) {
  const unit = seedUnit(db, { branchId: SOURCE, imei: opts.imei });
  if (opts.brand) {
    db.product.find((p) => (p.id as Buffer).equals(unit.productId as Buffer))!.brand = opts.brand;
  }
  const created = (await h.service.create({
    clientUuid: randomUUID(),
    toBranchId: binToUuid(opts.to ?? DEST),
    identifiers: [unit.imeiPrimary as string],
  })) as { id: string; version: number };
  return { ...created, identifier: unit.imeiPrimary as string };
}

type ListResult = Awaited<ReturnType<Harness['service']['list']>>;
const list = (query = {}) => h.service.list(query) as Promise<ListResult>;

// ───────────────────────────── paging ─────────────────────────────────────

describe('paging keeps the whole history reachable', () => {
  it('pages with a keyset cursor, newest first, with no gap or repeat', async () => {
    asEmployee();
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) made.push((await request()).id);

    /**
     * Descending by id, which is the ordering the endpoint promises. It is NOT
     * necessarily creation order: five transfers made inside one millisecond
     * share a UUIDv7 timestamp prefix, and the random tail then decides. That is
     * fine — `id desc` is still a TOTAL order, which is the property keyset
     * paging actually needs. Asserting creation order here would be asserting
     * something the contract never claimed.
     */
    const byIdDesc = [...made].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

    const first = await list({ limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(first.rows.map((r) => r.id)).toEqual(byIdDesc.slice(0, 2));

    const second = await list({ limit: 2, cursor: first.nextCursor! });
    expect(second.rows.map((r) => r.id)).toEqual(byIdDesc.slice(2, 4));

    const third = await list({ limit: 2, cursor: second.nextCursor! });
    expect(third.rows.map((r) => r.id)).toEqual(byIdDesc.slice(4));
    expect(third.nextCursor).toBeNull();

    // Every transfer appeared exactly once across the three pages: no gap, no
    // repeat, which is the whole point of a keyset cursor.
    const seen = [...first.rows, ...second.rows, ...third.rows].map((r) => r.id);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual(byIdDesc);
  });

  it('caps an over-large limit rather than letting a client drain the table', async () => {
    asEmployee();
    for (let i = 0; i < 3; i += 1) await request();
    const page = await list({ limit: 9999 });
    expect(page.rows.length).toBeLessThanOrEqual(50);
    expect(page.rows).toHaveLength(3);
  });
});

// ───────────────────────────── filters and search ─────────────────────────

describe('history is navigable by status and by search', () => {
  it('filters by one status and by several', async () => {
    asEmployee();
    const pending = await request();
    const toApprove = await request();
    asManager();
    await h.service.approve(toApprove.id, { expectedVersion: toApprove.version });

    expect((await list({ status: 'pending_approval' })).rows.map((r) => r.id)).toEqual([pending.id]);
    expect((await list({ status: 'approved' })).rows.map((r) => r.id)).toEqual([toApprove.id]);
    expect((await list({ status: 'pending_approval,approved' })).rows).toHaveLength(2);
  });

  it('keeps completed and refused transfers reachable', async () => {
    asEmployee();
    const refused = await request();
    asManager();
    await h.service.reject(refused.id, { expectedVersion: refused.version, reason: 'No spare stock' });

    const rejected = await list({ status: 'rejected' });
    expect(rejected.rows.map((r) => r.id)).toEqual([refused.id]);
    expect(rejected.rows[0].decisionReason).toBe('No spare stock');
    // And with no filter, history still contains it.
    expect((await list()).rows.map((r) => r.id)).toContain(refused.id);
  });

  it('refuses an unknown status rather than silently returning everything', async () => {
    asEmployee();
    await request();
    await expect(list({ status: 'nonsense' })).rejects.toThrow(BadRequestException);
  });

  it('searches the reference, both branch names, the product and the IMEI', async () => {
    asEmployee();
    const target = await request({ imei: '356938035643999', brand: 'Xiaomi' });
    await request({ imei: '111111111111111', brand: 'Samsung' });

    const byImei = await list({ search: '5643999' });
    expect(byImei.rows.map((r) => r.id)).toEqual([target.id]);

    const byProduct = await list({ search: 'xiaomi' }); // case-insensitive
    expect(byProduct.rows.map((r) => r.id)).toEqual([target.id]);

    const byBranch = await list({ search: 'Warehouse' });
    expect(byBranch.rows).toHaveLength(2); // both go to the Warehouse

    const byRef = await list({ search: 'TRF-000001' });
    expect(byRef.rows).toHaveLength(1);

    // A search that matches nothing says so, rather than falling back.
    expect((await list({ search: 'nothing-like-this' })).rows).toEqual([]);
  });

  it('combines a status filter with a search', async () => {
    asEmployee();
    const a = await request({ imei: '356938035643111' });
    await request({ imei: '356938035643222' });
    asManager();
    await h.service.approve(a.id, { expectedVersion: a.version });

    expect((await list({ status: 'approved', search: '43111' })).rows.map((r) => r.id)).toEqual([a.id]);
    expect((await list({ status: 'approved', search: '43222' })).rows).toEqual([]);
  });
});

// ───────────────────────────── scoping ────────────────────────────────────

describe('a branch sees its own two ends, and nothing else', () => {
  it('shows outgoing and incoming, marked as such', async () => {
    asEmployee();
    const outgoing = await request();

    // The destination branch sees the same transfer as incoming.
    h.act({ userId: DEST_MANAGER, branchId: DEST, permissions: MANAGER_PERMISSIONS });
    const atDest = await list();
    expect(atDest.rows.map((r) => r.id)).toEqual([outgoing.id]);
    expect(atDest.rows[0].direction).toBe('incoming');

    asEmployee();
    expect((await list()).rows[0].direction).toBe('outgoing');
  });

  it('hides a transfer from a branch that is neither end', async () => {
    asEmployee();
    await request(); // SOURCE → DEST

    h.act({ userId: OWNER, branchId: THIRD, permissions: OWNER_PERMISSIONS });
    expect((await list()).rows).toEqual([]);
    expect(await h.service.counts()).toEqual({ pendingApproval: 0, approved: 0, inTransit: 0 });
  });

  it('counts only the work waiting at this branch', async () => {
    asEmployee();
    const a = await request();
    await request();
    asManager();
    await h.service.approve(a.id, { expectedVersion: a.version });
    await h.service.ship(a.id, { expectedVersion: a.version + 1 });

    expect(await h.service.counts()).toEqual({ pendingApproval: 1, approved: 0, inTransit: 1 });
    // Finished transfers are history, not a badge.
    const done = await request();
    await h.service.cancel(done.id, { expectedVersion: done.version, reason: 'no longer needed' });
    expect((await h.service.counts()).pendingApproval).toBe(1);
  });

  it('reports a row without money of any kind', async () => {
    asEmployee();
    await request();
    const row = (await list()).rows[0];
    const text = JSON.stringify(row);
    expect(text).not.toMatch(/cost|price|margin|profit/i);
    expect(row).toMatchObject({
      transferNo: 'TRF-000001',
      itemCount: 1,
      requestedBy: 'Salma the Employee',
      status: 'pending_approval',
    });
    expect(row.requestedAt).toBeInstanceOf(Date);
  });
});

// ───────────────────────────── detail and actions ─────────────────────────

describe('the detail screen is told what it may do, and why not', () => {
  it('carries identity, people, timestamps and no money', async () => {
    asEmployee();
    const t = await request({ brand: 'Nokia' });
    asManager();
    await h.service.approve(t.id, { expectedVersion: t.version });

    const detail = await h.service.getById(t.id);
    expect(detail.transferNo).toBe('TRF-000001');
    expect(detail.from.name).toBe('Main Store');
    expect(detail.to.name).toBe('Warehouse');
    expect(detail.people.requestedBy).toBe('Salma the Employee');
    expect(detail.people.approvedBy).toBe('Moussa the Manager');
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0].identifier).toBe(t.identifier);
    expect(detail.items[0].product).toContain('Nokia');
    expect(detail.items[0].unitStatus).toBe('reserved');
    expect(detail.timestamps.approvedAt).toBeInstanceOf(Date);
    // Not shipped, so there is no shipping time — despite the column's default.
    expect(detail.timestamps.sentAt).toBeNull();
    expect(JSON.stringify(detail)).not.toMatch(/cost|price|margin/i);
  });

  it('a transfer cancelled after approval was never shipped, and says so', async () => {
    /*
     * The column defaults to now(), so the row always carries a sent_at. Before
     * this, cancelling an APPROVED transfer left that default in the response
     * and the app listed a shipping event — "Sent by somebody", nobody named —
     * for goods that never left the shop.
     */
    asEmployee();
    const t = await request();
    asManager();
    await h.service.approve(t.id, { expectedVersion: t.version });
    const approved = await h.service.getById(t.id);
    await h.service.cancel(t.id, { expectedVersion: approved.version, reason: 'Quantity wrong' });

    const detail = await h.service.getById(t.id);
    expect(detail.status).toBe('cancelled');
    expect(detail.timestamps.sentAt).toBeNull();
    expect(detail.people.sentBy).toBeNull();
    expect(detail.timestamps.decidedAt).toBeInstanceOf(Date);
  });

  it('offers a manager approve, reject and cancel on a pending request', async () => {
    asEmployee();
    const t = await request();
    asManager();

    const { actions } = await h.service.getById(t.id);
    expect(actions.approve.allowed).toBe(true);
    expect(actions.reject.allowed).toBe(true);
    expect(actions.cancel.allowed).toBe(true);
    expect(actions.ship.allowed).toBe(false);
    expect(actions.ship.reason).toBe('status');
    expect(actions.receive.reason).toBe('status');
  });

  it('tells an employee they lack the authority, not that they are in the wrong place', async () => {
    asEmployee();
    const t = await request();

    const { actions } = await h.service.getById(t.id);
    expect(actions.approve).toMatchObject({ allowed: false, reason: 'permission' });
    // Their own pending request, so withdrawing it is still theirs to do.
    expect(actions.cancel.allowed).toBe(true);
  });

  it('an employee cannot cancel somebody else’s request, and is told why', async () => {
    asManager();
    const t = await request();
    asEmployee();

    const { actions } = await h.service.getById(t.id);
    expect(actions.cancel).toMatchObject({ allowed: false, reason: 'ownership' });
  });

  it('names the branch an action needs when the wrong one is active', async () => {
    asEmployee();
    const t = await request();

    // The Owner opens the notification while pointed at the destination.
    h.act({ userId: OWNER, branchId: DEST, permissions: OWNER_PERMISSIONS });
    const { actions, from } = await h.service.getById(t.id);

    expect(actions.approve).toMatchObject({
      allowed: false,
      reason: 'branch',
      branchName: 'Main Store',
    });
    expect(actions.approve.branchId).toBe(from.id);

    // Switching to the source makes the same action available.
    h.act({ branchId: SOURCE });
    expect((await h.service.getById(t.id)).actions.approve.allowed).toBe(true);
  });

  it('offers receive only at the destination, and only in transit', async () => {
    asManager();
    const t = await request();

    let detail = await h.service.getById(t.id);
    expect(detail.actions.receive).toMatchObject({ reason: 'status', branchName: 'Warehouse' });

    await h.service.ship(t.id, { expectedVersion: 0 });
    detail = await h.service.getById(t.id);
    // Still at the source branch: right status, wrong place.
    expect(detail.actions.receive).toMatchObject({ allowed: false, reason: 'branch' });
    expect(detail.actions.cancel).toMatchObject({ allowed: false, reason: 'status' });

    h.act({ userId: DEST_MANAGER, branchId: DEST, permissions: MANAGER_PERMISSIONS });
    expect((await h.service.getById(t.id)).actions.receive.allowed).toBe(true);
  });

  it('offers nothing at all once a transfer is finished', async () => {
    asEmployee();
    const t = await request();
    asManager();
    await h.service.reject(t.id, { expectedVersion: t.version, reason: 'no' });

    const { actions } = await h.service.getById(t.id);
    for (const action of Object.values(actions)) {
      expect(action.allowed).toBe(false);
      expect(action.reason).toBe('status');
    }
  });
});

// ───────────────────────────── the pure helpers ───────────────────────────

describe('action decisions, as a pure function', () => {
  const branchA = { id: SOURCE, name: 'Main Store' };
  const branchB = { id: DEST, name: 'Warehouse' };

  const decide = (over: Partial<Parameters<typeof computeActions>[0]> = {}) =>
    computeActions({
      transfer: { status: 'pending_approval', requestedById: EMPLOYEE },
      from: branchA,
      to: branchB,
      activeBranchId: SOURCE,
      userId: MANAGER,
      permissions: new Set(MANAGER_PERMISSIONS),
      ...over,
    });

  /**
   * Order matters. A received transfer cannot be approved by anybody from
   * anywhere, so saying "wrong branch" would send the user somewhere pointless;
   * and someone who simply lacks the authority must not be invited to switch
   * branches only to discover that.
   */
  it('reports status before branch, and permission before branch', () => {
    expect(
      decide({ transfer: { status: 'received', requestedById: EMPLOYEE }, activeBranchId: DEST })
        .approve.reason,
    ).toBe('status');
    expect(
      decide({ permissions: new Set(EMPLOYEE_PERMISSIONS), activeBranchId: DEST }).approve.reason,
    ).toBe('permission');
  });

  /**
   * The service takes a typed object, so a service test never exercises the
   * pipe — and `?limit=3` was a 400 for every client until a live request
   * proved it. A query parameter arrives as a STRING, and the global pipe runs
   * with `enableImplicitConversion: false`, so the DTO has to convert it.
   */
  it('accepts limit as the string a query parameter actually is', async () => {
    const dto = plainToInstance(ListTransfersDto, { limit: '3' });
    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.limit).toBe(3);
  });

  it('still refuses a limit that is not a number, or is out of range', async () => {
    for (const limit of ['abc', '0', '999']) {
      const errors = await validate(plainToInstance(ListTransfersDto, { limit }));
      expect(errors.some((e) => e.property === 'limit')).toBe(true);
    }
  });

  it('treats an absent or empty limit as unset rather than as zero', async () => {
    for (const value of [undefined, '']) {
      const dto = plainToInstance(ListTransfersDto, { limit: value });
      await expect(validate(dto)).resolves.toHaveLength(0);
      expect(dto.limit).toBeUndefined();
    }
  });

  it('derives the requested time from the UUIDv7 key, not from sent_at', () => {
    const before = Date.now();
    const id = Buffer.alloc(16);
    id.writeUIntBE(before, 0, 6);
    expect(requestedAtOf(id).getTime()).toBe(before);
  });
});
