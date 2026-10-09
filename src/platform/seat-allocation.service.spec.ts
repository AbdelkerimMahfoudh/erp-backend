import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SeatAllocationService } from './seat-allocation.service';
import { newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import type { Activity } from '../entitlement/activity';

/**
 * Seats beyond the included one (docs/21, 2026-10-05): nothing is granted by
 * asking; a payment needs a reference; two confirmations of one request
 * produce one payment and one refusal; a store request opens the store only
 * when its payment is confirmed.
 *
 * And a branch's activity (D154, docs/73 §3): an upgrade waits for payment of
 * the difference and applies at confirmation; a downgrade is scheduled for
 * the renewal at once and costs nothing; one open request per branch.
 */

const COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c001');
const BRANCH = uuidToBin('018f0000-0000-7000-8000-00000000b001');
const DEPOT = uuidToBin('018f0000-0000-7000-8000-00000000b002');
const USER = uuidToBin('018f0000-0000-7000-8000-00000000a002');
const ADMIN = { id: newUuidV7Bin(), email: 'ops@example.test', name: 'Ops' };
const CTX = { admin: ADMIN, ip: '127.0.0.1' };
const NOW = new Date('2026-10-05T10:00:00.000Z');

interface Row {
  id: Buffer;
  companyId: Buffer;
  subscriptionId: Buffer;
  branchId: Buffer | null;
  userId: Buffer | null;
  kind: 'seat' | 'store' | 'activity';
  status: 'pending_payment' | 'paid' | 'granted' | 'released' | 'refused';
  label: string | null;
  activityFrom: Activity | null;
  activityTo: Activity | null;
  activityEffective: 'now' | 'renewal' | null;
  monthlyAmount: number;
  currency: string;
  requestedBy: string;
  requestedAt: Date;
  paymentId: Buffer | null;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  closedAt: Date | null;
  closedBy: string | null;
  reason: string | null;
  version: number;
}

function makeWorld(main: { activity?: Activity; activityNext?: Activity | null } = {}, opts: { running?: boolean; status?: string } = {}) {
  const sub = {
    id: newUuidV7Bin(),
    companyId: COMPANY,
    status: opts.status ?? 'activated',
    subscribedBranchCount: 1,
    additionalSeats: 0,
    version: 2,
    company: { name: 'Shop', publicStoreId: 'ABCDEF1234' },
  };
  const branches: any[] = [
    {
      id: BRANCH,
      companyId: COMPANY,
      name: 'Main',
      type: 'store',
      activity: main.activity ?? 'electronics',
      activityNext: main.activityNext ?? null,
      activityChangedAt: null,
      isActive: true,
      deletedAt: null,
    },
    {
      id: DEPOT,
      companyId: COMPANY,
      name: 'Depot',
      type: 'warehouse',
      activity: 'electronics',
      activityNext: null,
      activityChangedAt: null,
      isActive: true,
      deletedAt: null,
    },
  ];
  const rows: Row[] = [];
  const payments: any[] = [];
  const events: any[] = [];
  const audits: any[] = [];
  const userBranches: any[] = [];
  const assessed: Buffer[] = [];

  const matches = (row: Row, where: any): boolean => {
    for (const [k, v] of Object.entries(where ?? {})) {
      const current = (row as any)[k];
      if (v && typeof v === 'object' && !Buffer.isBuffer(v) && 'in' in v) {
        if (!(v as any).in.includes(current)) return false;
      } else if (v && typeof v === 'object' && !Buffer.isBuffer(v) && 'not' in v) {
        const not = (v as any).not;
        if (Buffer.isBuffer(not) ? Buffer.isBuffer(current) && current.equals(not) : current === not) return false;
      } else if (Buffer.isBuffer(v)) {
        if (!current || !Buffer.isBuffer(current) || !current.equals(v)) return false;
      } else if (current !== v) return false;
    }
    return true;
  };
  const hydrate = (row: Row) => ({
    ...row,
    branch: row.branchId
      ? { id: row.branchId, name: branches.find((b) => b.id.equals(row.branchId))?.name ?? 'Main' }
      : null,
    user: row.userId ? { id: row.userId, name: 'Fatima' } : null,
    payment: row.paymentId ? (payments.find((p) => p.id.equals(row.paymentId)) ?? null) : null,
    company: sub.company,
  });

  const seatAllocation = {
    findFirst: async ({ where }: any) => {
      const r = rows.find((x) => matches(x, where));
      return r ? hydrate(r) : null;
    },
    findUnique: async ({ where }: any) => {
      const r = rows.find((x) => x.id.equals(where.id));
      return r ? hydrate(r) : null;
    },
    findUniqueOrThrow: async ({ where }: any) => hydrate(rows.find((x) => x.id.equals(where.id))!),
    findMany: async ({ where }: any) => rows.filter((x) => matches(x, where)).map(hydrate),
    count: async ({ where }: any) => rows.filter((x) => matches(x, where)).length,
    create: async ({ data }: any) => {
      const row: Row = {
        label: null,
        paymentId: null,
        confirmedBy: null,
        confirmedAt: null,
        closedAt: null,
        closedBy: null,
        reason: null,
        version: 0,
        currency: 'MRU',
        requestedAt: NOW,
        branchId: null,
        userId: null,
        activityFrom: null,
        activityTo: null,
        activityEffective: null,
        ...data,
      };
      rows.push(row);
      return hydrate(row);
    },
    updateMany: async ({ where, data }: any) => {
      const hits = rows.filter((x) => matches(x, where));
      for (const r of hits) {
        const { version, ...rest } = data;
        Object.assign(r, rest, { version: r.version + (version?.increment ?? 0) });
      }
      return { count: hits.length };
    },
  };

  const tx = {
    seatAllocation,
    subscriptionPayment: {
      create: async ({ data }: any) => {
        payments.push(data);
        return data;
      },
    },
    subscriptionEvent: { create: async ({ data }: any) => (events.push(data), data) },
    branch: {
      create: async ({ data }: any) => {
        if (branches.some((b) => b.name === data.name)) {
          throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
        }
        branches.push({ activityNext: null, activityChangedAt: null, ...data, isActive: true, deletedAt: null });
        return { id: data.id };
      },
      findFirst: async ({ where }: any) =>
        branches.find(
          (b) => (where.id ? b.id.equals(where.id) : true) && (where.name ? b.name === where.name : true),
        ) ?? null,
      update: async ({ where, data }: any) => {
        const b = branches.find((x) => x.id.equals(where.id))!;
        Object.assign(b, data);
        return { ...b };
      },
      updateMany: async ({ where, data }: any) => {
        const hits = branches.filter(
          (b) =>
            b.id.equals(where.id) &&
            (where.companyId ? b.companyId.equals(where.companyId) : true) &&
            (where.activityNext !== undefined ? b.activityNext === where.activityNext : true),
        );
        for (const b of hits) Object.assign(b, data);
        return { count: hits.length };
      },
    },
    userBranch: {
      findMany: async () => [{ userId: USER, roleId: newUuidV7Bin() }],
      create: async ({ data }: any) => (userBranches.push(data), data),
    },
    subscription: {
      findFirst: async () => ({ ...sub }),
      update: async ({ data }: any) => {
        sub.subscribedBranchCount += data.subscribedBranchCount?.increment ?? 0;
        sub.version += 1;
        return { ...sub };
      },
    },
    company: { findUnique: async () => ({ name: 'Shop' }) },
    // The per-branch lock of a request (SELECT … FOR UPDATE): one request at a time per branch, by the database.
    $queryRaw: async () => [],
  };
  const prisma = { ...tx, $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
  const audit = { record: async (e: unknown) => void audits.push(e) };
  const billing = {
    planAt: async () => ({
      current: { extraStaffMonthly: 100, branchMonthly: 500, agentMonthly: 300, bothMonthly: 700 },
      upcoming: null,
    }),
    assessNow: async (id: Buffer) => void assessed.push(id),
    /** A paid month running at the period's own copied prices — or, with `running: false`, no paid month at all. */
    chargeablePricing: async () => ({
      running: opts.running ?? true,
      pricing: { extraStaffMonthly: 100, branchMonthly: 500, agentMonthly: 300, bothMonthly: 700, includedStaffPerBranch: 1 },
    }),
    // No renewal is ever due in this world: the latest period is not modelled here (billing/renewal.ts has its own spec).
    latestPeriod: async () => null,
  };
  const clock = { now: () => NOW };
  const service = new SeatAllocationService(prisma as never, audit as never, billing as never, clock as never);
  return { service, rows, payments, events, audits, branches, userBranches, assessed, sub };
}

const PAYMENT = { amount: '100', paidAt: new Date('2026-10-05T09:00:00.000Z'), reference: 'BK-7781' };

describe('asking for a seat', () => {
  it('prices it from the plan and grants nothing', async () => {
    const w = makeWorld();
    const r = await w.service.requestSeat(COMPANY, { branchId: BRANCH, userId: USER, requestedBy: 'owner@shop.test' });
    expect(r.created).toBe(true);
    expect(r.allocation).toMatchObject({
      kind: 'seat',
      status: 'pending_payment',
      monthlyAmount: 100,
      providerVerified: false,
    });
    expect(w.events.map((e) => e.kind)).toEqual(['seat_requested']);
    expect(w.payments).toHaveLength(0);
  });

  it('asked twice for the same person at the same store, it answers with the one request that exists', async () => {
    const w = makeWorld();
    const a = await w.service.requestSeat(COMPANY, { branchId: BRANCH, userId: USER, requestedBy: 'owner' });
    const b = await w.service.requestSeat(COMPANY, { branchId: BRANCH, userId: USER, requestedBy: 'owner' });
    expect(b.created).toBe(false);
    expect(b.allocation.id).toBe(a.allocation.id);
    expect(w.rows).toHaveLength(1);
  });
});

describe('confirming a payment', () => {
  it('refuses without a reference, and writes nothing', async () => {
    const w = makeWorld();
    const { allocation } = await w.service.requestSeat(COMPANY, {
      branchId: BRANCH,
      userId: USER,
      requestedBy: 'owner',
    });
    const id = uuidToBin(allocation.id);
    await expect(w.service.confirmPayment(id, { ...PAYMENT, reference: '  ' }, CTX)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(w.service.confirmPayment(id, { ...PAYMENT, amount: '0' }, CTX)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(w.payments).toHaveLength(0);
    expect(w.rows[0].status).toBe('pending_payment');
  });

  it('records the payment and the status in one step, audits it, and charges the month at once', async () => {
    const w = makeWorld();
    const { allocation } = await w.service.requestSeat(COMPANY, {
      branchId: BRANCH,
      userId: USER,
      requestedBy: 'owner',
    });
    const r = await w.service.confirmPayment(uuidToBin(allocation.id), PAYMENT, CTX);

    expect(r.applied).toBe(true);
    expect(r.allocation.status).toBe('paid');
    expect(r.allocation.payment).toMatchObject({ reference: 'BK-7781', amount: '100' });
    expect(w.payments).toHaveLength(1);
    expect(w.payments[0]).toMatchObject({ confirmedBy: ADMIN.email, recordedBy: ADMIN.email, reference: 'BK-7781' });
    expect(w.events.map((e) => e.kind)).toEqual(['seat_requested', 'seat_paid']);
    expect(w.audits).toHaveLength(1);
    expect(w.audits[0]).toMatchObject({
      action: 'seat.payment_confirm',
      after: expect.objectContaining({ reference: 'BK-7781', providerVerified: false }),
    });
    expect(w.assessed).toHaveLength(1);
  });

  it('a second confirmation is a no-op: one payment, one event, no second charge', async () => {
    const w = makeWorld();
    const { allocation } = await w.service.requestSeat(COMPANY, {
      branchId: BRANCH,
      userId: USER,
      requestedBy: 'owner',
    });
    await w.service.confirmPayment(uuidToBin(allocation.id), PAYMENT, CTX);
    const again = await w.service.confirmPayment(
      uuidToBin(allocation.id),
      { ...PAYMENT, reference: 'BK-7781-again' },
      CTX,
    );
    expect(again.applied).toBe(false);
    expect(w.payments).toHaveLength(1);
    expect(w.events.filter((e) => e.kind === 'seat_paid')).toHaveLength(1);
    expect(w.audits).toHaveLength(1);
  });

  it('two administrators confirming at once: one wins, the other is refused, and only one payment exists', async () => {
    const w = makeWorld();
    const { allocation } = await w.service.requestSeat(COMPANY, {
      branchId: BRANCH,
      userId: USER,
      requestedBy: 'owner',
    });
    const id = uuidToBin(allocation.id);
    // Both read version 0; the first transition moves it to 1; the second's guard matches nothing.
    const first = await w.service.confirmPayment(id, { ...PAYMENT, expectedVersion: 0 }, CTX);
    expect(first.applied).toBe(true);
    await expect(
      w.service.confirmPayment(id, { ...PAYMENT, expectedVersion: 0, reference: 'BK-dup' }, CTX),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(w.payments).toHaveLength(1);
  });

  it('a refused request cannot be paid afterwards', async () => {
    const w = makeWorld();
    const { allocation } = await w.service.requestSeat(COMPANY, {
      branchId: BRANCH,
      userId: USER,
      requestedBy: 'owner',
    });
    await w.service.refuse(uuidToBin(allocation.id), { reason: 'No such transfer' }, CTX);
    await expect(w.service.confirmPayment(uuidToBin(allocation.id), PAYMENT, CTX)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(w.rows[0].status).toBe('refused');
    expect(w.events.map((e) => e.kind)).toEqual(['seat_requested', 'seat_closed']);
  });
});

describe('a store request', () => {
  it('creates nothing a shop could sell from until it is paid', async () => {
    const w = makeWorld();
    const r = await w.service.requestStore(COMPANY, { name: 'Market', requestedBy: 'owner' });
    expect(r.allocation).toMatchObject({
      kind: 'store',
      status: 'pending_payment',
      label: 'Market',
      monthlyAmount: 500,
    });
    // Main and the Depot warehouse the world starts with (D154 c needs one); nothing was added.
    expect(w.branches).toHaveLength(2);
    expect(w.sub.subscribedBranchCount).toBe(1);
  });

  it('opens the store, assigns the Owner and raises the subscribed count when its payment is confirmed', async () => {
    const w = makeWorld();
    const { allocation } = await w.service.requestStore(COMPANY, { name: 'Market', requestedBy: 'owner' });
    const r = await w.service.confirmPayment(uuidToBin(allocation.id), { ...PAYMENT, amount: '500' }, CTX);
    expect(r.applied).toBe(true);
    expect(w.branches.map((b) => b.name)).toEqual(['Main', 'Depot', 'Market']);
    expect(w.userBranches).toHaveLength(1);
    expect(w.sub.subscribedBranchCount).toBe(2);
    expect(w.events.map((e) => e.kind)).toEqual(['store_requested', 'branches_changed', 'seat_paid']);
    expect(w.audits[0].action).toBe('store.payment_confirm');
  });

  it('refuses a name a store already has', async () => {
    const w = makeWorld();
    await expect(w.service.requestStore(COMPANY, { name: 'Main', requestedBy: 'owner' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('is priced for the activity it will have, and the store opens as what was paid for (D154)', async () => {
    const w = makeWorld();
    const r = await w.service.requestStore(COMPANY, { name: 'Counter', activity: 'money_agent', requestedBy: 'owner' });
    expect(r.allocation).toMatchObject({ kind: 'store', monthlyAmount: 300, activityTo: 'money_agent', activityFrom: null, activityEffective: null });
    await w.service.confirmPayment(uuidToBin(r.allocation.id), { ...PAYMENT, amount: '300' }, CTX);
    expect(w.branches.find((b) => b.name === 'Counter')).toMatchObject({ type: 'store', activity: 'money_agent' });
    expect(w.events.find((e) => e.kind === 'branches_changed').note).toMatch(/money_agent/);
    // Said nothing → an electronics store, priced as one.
    const plain = await w.service.requestStore(COMPANY, { name: 'Market', requestedBy: 'owner' });
    expect(plain.allocation).toMatchObject({ monthlyAmount: 500, activityTo: 'electronics' });
  });
});

describe('the Owner withdrawing', () => {
  it('withdraws only their own, unpaid request', async () => {
    const w = makeWorld();
    const { allocation } = await w.service.requestSeat(COMPANY, {
      branchId: BRANCH,
      userId: USER,
      requestedBy: 'owner',
    });
    const other = uuidToBin('018f0000-0000-7000-8000-00000000c009');
    await expect(w.service.withdraw(other, uuidToBin(allocation.id), 'owner')).rejects.toThrow('Unknown request');
    const r = await w.service.withdraw(COMPANY, uuidToBin(allocation.id), 'owner');
    expect(r.allocation.status).toBe('released');
    await expect(w.service.confirmPayment(uuidToBin(allocation.id), PAYMENT, CTX)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('another activity for a branch (D154, docs/73 §3)', () => {
  const owner = 'owner@shop.test';

  it('an upgrade waits for payment of exactly the difference, applies nothing by asking, and names the branch', async () => {
    const w = makeWorld({ activity: 'electronics' });
    const r = await w.service.requestActivityChange(COMPANY, { branchId: BRANCH, activity: 'both', requestedBy: owner });
    expect(r.created).toBe(true);
    expect(r.allocation).toMatchObject({
      kind: 'activity',
      status: 'pending_payment',
      monthlyAmount: 200,
      activityFrom: 'electronics',
      activityTo: 'both',
      activityEffective: 'now',
      branchId: '018f0000-0000-7000-8000-00000000b001',
      branchName: 'Main',
      store: { name: 'Main' },
      providerVerified: false,
    });
    expect(w.branches[0]).toMatchObject({ activity: 'electronics', activityNext: null });
    expect(w.events.map((e) => e.kind)).toEqual(['activity_requested']);
    expect(w.events[0].note).toMatch(/electronics → both, 200 MRU/);
    expect(w.payments).toHaveLength(0);
    expect(w.assessed).toHaveLength(0);
  });

  it('a downgrade costs nothing: granted at once, scheduled on the branch for the renewal', async () => {
    const w = makeWorld({ activity: 'both' });
    const r = await w.service.requestActivityChange(COMPANY, { branchId: BRANCH, activity: 'money_agent', requestedBy: owner });
    expect(r.created).toBe(true);
    expect(r.allocation).toMatchObject({
      kind: 'activity',
      status: 'granted',
      monthlyAmount: 0,
      activityFrom: 'both',
      activityTo: 'money_agent',
      activityEffective: 'renewal',
      confirmedAt: null,
    });
    // The branch keeps what it has this period; only the renewal applies the change.
    expect(w.branches[0]).toMatchObject({ activity: 'both', activityNext: 'money_agent' });
    expect(w.events.map((e) => e.kind)).toEqual(['activity_scheduled']);
    expect(w.assessed).toHaveLength(0);
  });

  it('the sideways change is priced, not named: electronics → agent waits; agent → electronics is 200 now', async () => {
    const down = makeWorld({ activity: 'electronics' });
    const d = await down.service.requestActivityChange(COMPANY, { branchId: BRANCH, activity: 'money_agent', requestedBy: owner });
    expect(d.allocation).toMatchObject({ status: 'granted', monthlyAmount: 0, activityEffective: 'renewal' });
    const up = makeWorld({ activity: 'money_agent' });
    const u = await up.service.requestActivityChange(COMPANY, { branchId: BRANCH, activity: 'electronics', requestedBy: owner });
    expect(u.allocation).toMatchObject({ status: 'pending_payment', monthlyAmount: 200, activityEffective: 'now' });
  });

  it('the same activity, with nothing scheduled, is refused by name and writes nothing', async () => {
    const w = makeWorld({ activity: 'both' });
    const refusal = await w.service
      .requestActivityChange(COMPANY, { branchId: BRANCH, activity: 'both', requestedBy: owner })
      .catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(BadRequestException);
    expect((refusal as BadRequestException).getResponse()).toMatchObject({ code: 'activity_unchanged' });
    expect(w.rows).toHaveLength(0);
  });

  it('asking to KEEP the current activity while a downgrade is scheduled withdraws it: nothing charged, nothing refunded (docs/73 §3.3, corrected 2026-10-09)', async () => {
    const w = makeWorld({ activity: 'both' });
    const down = await w.service.requestActivityChange(COMPANY, { branchId: BRANCH, activity: 'money_agent', requestedBy: owner });
    expect(w.branches[0].activityNext).toBe('money_agent');
    const keep = await w.service.requestActivityChange(COMPANY, { branchId: BRANCH, activity: 'both', requestedBy: owner });
    expect(keep.created).toBe(false);
    expect(keep.allocation).toMatchObject({ id: down.allocation.id, status: 'released', reason: 'Withdrawn by a later request to keep both.', monthlyAmount: 0 });
    expect(w.branches[0]).toMatchObject({ activity: 'both', activityNext: null });
    expect(w.rows).toHaveLength(1);
    expect(w.payments).toHaveLength(0);
    expect(w.events.map((e) => e.kind)).toEqual(['activity_scheduled', 'seat_closed']);
  });

  it('an upgrade with no paid month running is scheduled like a downgrade — never a difference charged against nothing (reviewed 2026-10-09)', async () => {
    for (const opts of [{ running: false }, { running: true, status: 'pending_activation' }]) {
      const w = makeWorld({ activity: 'money_agent' }, opts);
      const r = await w.service.requestActivityChange(COMPANY, { branchId: BRANCH, activity: 'both', requestedBy: owner });
      expect(r.allocation).toMatchObject({ kind: 'activity', status: 'granted', activityEffective: 'renewal', monthlyAmount: 0, activityFrom: 'money_agent', activityTo: 'both' });
      expect(w.branches[0]).toMatchObject({ activity: 'money_agent', activityNext: 'both' });
      expect(w.events.map((e) => e.kind)).toEqual(['activity_scheduled']);
      expect(w.events[0].note).toMatch(/priced in full then/);
    }
  });

  it('a paid upgrade supersedes whatever else was open for the branch: no stale scheduled row survives (reviewed 2026-10-09)', async () => {
    const w = makeWorld({ activity: 'electronics' });
    const up = await w.service.requestActivityChange(COMPANY, { branchId: BRANCH, activity: 'both', requestedBy: owner });
    // A row the request path could never write beside it — the concurrency the per-branch lock now prevents — is still cleaned up.
    w.rows.push({ ...w.rows[0], id: newUuidV7Bin(), status: 'granted', activityTo: 'money_agent', activityEffective: 'renewal', monthlyAmount: 0, confirmedAt: null });
    await w.service.confirmPayment(uuidToBin(up.allocation.id), { ...PAYMENT, amount: '200' }, CTX);
    expect(w.rows.map((r) => r.status)).toEqual(['paid', 'released']);
    expect(w.rows[1].reason).toBe('Superseded by the paid upgrade.');
    expect(w.branches[0]).toMatchObject({ activity: 'both', activityNext: null });
  });

  it('a refusal and a release of an activity change are audited as what they are', async () => {
    const w = makeWorld({ activity: 'electronics' });
    const up = await w.service.requestActivityChange(COMPANY, { branchId: BRANCH, activity: 'both', requestedBy: owner });
    await w.service.refuse(uuidToBin(up.allocation.id), { reason: 'No such transfer arrived' }, CTX);
    expect(w.audits[0]).toMatchObject({ action: 'activity.refuse' });
  });

  it('a warehouse stays electronics and cannot be asked (D154 c)', async () => {
    const w = makeWorld();
    const refusal = await w.service
      .requestActivityChange(COMPANY, { branchId: DEPOT, activity: 'money_agent', requestedBy: owner })
      .catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(BadRequestException);
    expect((refusal as BadRequestException).getResponse()).toMatchObject({ code: 'activity_not_for_warehouse' });
    expect(w.rows).toHaveLength(0);
  });

  it('one open request per branch: the same target again is the request that exists; a different one waits for a withdrawal', async () => {
    const w = makeWorld({ activity: 'electronics' });
    const first = await w.service.requestActivityChange(COMPANY, { branchId: BRANCH, activity: 'both', requestedBy: owner });
    const again = await w.service.requestActivityChange(COMPANY, { branchId: BRANCH, activity: 'both', requestedBy: owner });
    expect(again.created).toBe(false);
    expect(again.allocation.id).toBe(first.allocation.id);

    const other = await w.service
      .requestActivityChange(COMPANY, { branchId: BRANCH, activity: 'money_agent', requestedBy: owner })
      .catch((e: unknown) => e);
    expect(other).toBeInstanceOf(ConflictException);
    expect((other as ConflictException).getResponse()).toMatchObject({ code: 'activity_request_pending' });
    expect(w.rows).toHaveLength(1);

    // Withdrawn, the way is clear.
    await w.service.withdraw(COMPANY, uuidToBin(first.allocation.id), owner);
    const next = await w.service.requestActivityChange(COMPANY, { branchId: BRANCH, activity: 'money_agent', requestedBy: owner });
    expect(next.created).toBe(true);
    expect(next.allocation.status).toBe('granted');
  });

  it('a scheduled downgrade blocks a different downgrade, and answers the same one with itself', async () => {
    const w = makeWorld({ activity: 'both' });
    const first = await w.service.requestActivityChange(COMPANY, { branchId: BRANCH, activity: 'money_agent', requestedBy: owner });
    const same = await w.service.requestActivityChange(COMPANY, { branchId: BRANCH, activity: 'money_agent', requestedBy: owner });
    expect(same).toMatchObject({ created: false, allocation: { id: first.allocation.id } });
    await expect(
      w.service.requestActivityChange(COMPANY, { branchId: BRANCH, activity: 'electronics', requestedBy: owner }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(w.branches[0].activityNext).toBe('money_agent');
  });

  it('a later upgrade cancels the downgrade waiting for the renewal (D154 d): released with a reason, nothing refunded', async () => {
    const w = makeWorld({ activity: 'electronics' });
    const down = await w.service.requestActivityChange(COMPANY, { branchId: BRANCH, activity: 'money_agent', requestedBy: owner });
    expect(w.branches[0].activityNext).toBe('money_agent');

    const up = await w.service.requestActivityChange(COMPANY, { branchId: BRANCH, activity: 'both', requestedBy: owner });
    expect(up.created).toBe(true);
    expect(up.allocation).toMatchObject({ status: 'pending_payment', monthlyAmount: 200, activityFrom: 'electronics', activityTo: 'both' });
    expect(w.rows.find((r) => r.id.equals(uuidToBin(down.allocation.id)))).toMatchObject({
      status: 'released',
      reason: 'Cancelled by a later upgrade request.',
      closedBy: owner,
    });
    expect(w.branches[0]).toMatchObject({ activity: 'electronics', activityNext: null });
    expect(w.events.map((e) => e.kind)).toEqual(['activity_scheduled', 'seat_closed', 'activity_requested']);
  });

  it('confirming the payment applies the upgrade: the branch changes, the period is assessed, the trail says so', async () => {
    const w = makeWorld({ activity: 'money_agent' });
    const { allocation } = await w.service.requestActivityChange(COMPANY, { branchId: BRANCH, activity: 'both', requestedBy: owner });
    expect(allocation.monthlyAmount).toBe(400);
    const r = await w.service.confirmPayment(uuidToBin(allocation.id), { ...PAYMENT, amount: '400' }, CTX);
    expect(r.applied).toBe(true);
    expect(r.allocation).toMatchObject({ status: 'paid', activityTo: 'both', confirmedBy: ADMIN.email });
    expect(w.branches[0]).toMatchObject({ activity: 'both', activityNext: null, activityChangedAt: NOW });
    expect(w.payments).toHaveLength(1);
    expect(w.events.map((e) => e.kind)).toEqual(['activity_requested', 'activity_changed', 'seat_paid']);
    expect(w.events[1].note).toMatch(/money_agent → both after payment BK-7781/);
    expect(w.audits).toHaveLength(1);
    expect(w.audits[0]).toMatchObject({
      action: 'activity.payment_confirm',
      before: { activity: 'money_agent' },
      after: { activity: 'both', store: 'Main', reference: 'BK-7781', providerVerified: false },
    });
    // The difference is charged to this period at once.
    expect(w.assessed).toEqual([COMPANY]);
    // A second confirmation changes nothing more.
    const again = await w.service.confirmPayment(uuidToBin(allocation.id), { ...PAYMENT, amount: '400' }, CTX);
    expect(again.applied).toBe(false);
    expect(w.events.filter((e) => e.kind === 'activity_changed')).toHaveLength(1);
  });

  it('refusing an upgrade leaves the branch exactly as it was', async () => {
    const w = makeWorld({ activity: 'electronics' });
    const { allocation } = await w.service.requestActivityChange(COMPANY, { branchId: BRANCH, activity: 'both', requestedBy: owner });
    const r = await w.service.refuse(uuidToBin(allocation.id), { reason: 'No such transfer' }, CTX);
    expect(r.allocation.status).toBe('refused');
    expect(w.branches[0]).toMatchObject({ activity: 'electronics', activityNext: null });
    expect(w.events.map((e) => e.kind)).toEqual(['activity_requested', 'seat_closed']);
    expect(w.events[1].note).toMatch(/Activity change at Main \(electronics → both\) refused/);
    await expect(w.service.confirmPayment(uuidToBin(allocation.id), PAYMENT, CTX)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('releasing a scheduled downgrade clears the branch\'s scheduled change; a change already in force is not released', async () => {
    const w = makeWorld({ activity: 'both' });
    const { allocation } = await w.service.requestActivityChange(COMPANY, { branchId: BRANCH, activity: 'money_agent', requestedBy: owner });
    const r = await w.service.release(uuidToBin(allocation.id), { reason: 'The Owner called: keep both' }, CTX);
    expect(r.allocation.status).toBe('released');
    expect(w.branches[0]).toMatchObject({ activity: 'both', activityNext: null });
    expect(w.audits[0]).toMatchObject({ action: 'activity.release', before: { activityFrom: 'both', activityTo: 'money_agent' } });

    const paid = makeWorld({ activity: 'electronics' });
    const up = await paid.service.requestActivityChange(COMPANY, { branchId: BRANCH, activity: 'both', requestedBy: owner });
    await paid.service.confirmPayment(uuidToBin(up.allocation.id), { ...PAYMENT, amount: '200' }, CTX);
    await expect(paid.service.release(uuidToBin(up.allocation.id), { reason: 'x' }, CTX)).rejects.toBeInstanceOf(BadRequestException);
    expect(paid.branches[0].activity).toBe('both');
  });

  it('the Owner withdraws a scheduled downgrade as freely as an unpaid upgrade — and only their own', async () => {
    const w = makeWorld({ activity: 'both' });
    const { allocation } = await w.service.requestActivityChange(COMPANY, { branchId: BRANCH, activity: 'money_agent', requestedBy: owner });
    const other = uuidToBin('018f0000-0000-7000-8000-00000000c009');
    await expect(w.service.withdraw(other, uuidToBin(allocation.id), owner)).rejects.toThrow('Unknown request');
    const r = await w.service.withdraw(COMPANY, uuidToBin(allocation.id), owner);
    expect(r.allocation).toMatchObject({ status: 'released', reason: 'Withdrawn by the business before the renewal.' });
    expect(w.branches[0]).toMatchObject({ activity: 'both', activityNext: null });
    // Withdrawn once; a second withdrawal is a no-op.
    await expect(w.service.withdraw(COMPANY, uuidToBin(allocation.id), owner)).resolves.toMatchObject({ applied: false });
  });

  it('the view says the same things on every row, so a seat and an activity read alike', async () => {
    const w = makeWorld();
    const seat = await w.service.requestSeat(COMPANY, { branchId: BRANCH, userId: USER, requestedBy: owner });
    expect(seat.allocation).toMatchObject({ branchId: '018f0000-0000-7000-8000-00000000b001', branchName: 'Main', activityFrom: null, activityTo: null, activityEffective: null });
    const list = await w.service.listForCompany(COMPANY);
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0])).toEqual(expect.arrayContaining(['activityFrom', 'activityTo', 'activityEffective', 'branchId', 'branchName']));
  });
});
