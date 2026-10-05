import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SeatAllocationService } from './seat-allocation.service';
import { newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';

/**
 * Seats beyond the included one (docs/21, 2026-10-05): nothing is granted by
 * asking; a payment needs a reference; two confirmations of one request
 * produce one payment and one refusal; a store request opens the store only
 * when its payment is confirmed.
 */

const COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c001');
const BRANCH = uuidToBin('018f0000-0000-7000-8000-00000000b001');
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
  kind: 'seat' | 'store';
  status: 'pending_payment' | 'paid' | 'granted' | 'released' | 'refused';
  label: string | null;
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

function makeWorld() {
  const sub = {
    id: newUuidV7Bin(),
    companyId: COMPANY,
    status: 'activated',
    subscribedBranchCount: 1,
    additionalSeats: 0,
    version: 2,
    company: { name: 'Shop', publicStoreId: 'ABCDEF1234' },
  };
  const branches = [{ id: BRANCH, companyId: COMPANY, name: 'Main', isActive: true, deletedAt: null }];
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
      } else if (Buffer.isBuffer(v)) {
        if (!current || !Buffer.isBuffer(current) || !current.equals(v)) return false;
      } else if (current !== v) return false;
    }
    return true;
  };
  const hydrate = (row: Row) => ({
    ...row,
    branch: row.branchId ? { id: row.branchId, name: 'Main' } : null,
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
        branches.push({ ...data, isActive: true, deletedAt: null });
        return { id: data.id };
      },
      findFirst: async ({ where }: any) =>
        branches.find(
          (b) => (where.id ? b.id.equals(where.id) : true) && (where.name ? b.name === where.name : true),
        ) ?? null,
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
  };
  const prisma = { ...tx, $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
  const audit = { record: async (e: unknown) => void audits.push(e) };
  const billing = {
    planAt: async () => ({ current: { extraStaffMonthly: 100, branchMonthly: 500 }, upcoming: null }),
    assessNow: async (id: Buffer) => void assessed.push(id),
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
    expect(w.branches).toHaveLength(1);
    expect(w.sub.subscribedBranchCount).toBe(1);
  });

  it('opens the store, assigns the Owner and raises the subscribed count when its payment is confirmed', async () => {
    const w = makeWorld();
    const { allocation } = await w.service.requestStore(COMPANY, { name: 'Market', requestedBy: 'owner' });
    const r = await w.service.confirmPayment(uuidToBin(allocation.id), { ...PAYMENT, amount: '500' }, CTX);
    expect(r.applied).toBe(true);
    expect(w.branches.map((b) => b.name)).toEqual(['Main', 'Market']);
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
