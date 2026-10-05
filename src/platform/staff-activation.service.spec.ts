import { StaffActivationService } from './staff-activation.service';
import { newUuidV7Bin, uuidToBin, binToUuid } from '../common/utils/uuid.util';

/**
 * The server-side gate on a staff account (docs/21, 2026-10-05): every selected
 * contact verified AND a seat held at each store, in any order, decided only
 * here. Nothing a client sends changes the answer.
 */

const COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c001');
const MAIN = uuidToBin('018f0000-0000-7000-8000-00000000b001');
const MARKET = uuidToBin('018f0000-0000-7000-8000-00000000b002');
const NOW = new Date('2026-10-05T10:00:00.000Z');

interface UserRow {
  id: Buffer;
  companyId: Buffer;
  name: string;
  email: string | null;
  phone: string | null;
  emailVerifiedAt: Date | null;
  phoneVerifiedAt: Date | null;
  invitedAt: Date | null;
  activatedAt: Date | null;
  isActive: boolean;
  deletedAt: Date | null;
  branches: { branchId: Buffer; role: string }[];
}

function makeWorld(opts: { additionalSeats?: number } = {}) {
  const users: UserRow[] = [];
  const allocations: {
    id: Buffer;
    companyId: Buffer;
    branchId: Buffer | null;
    userId: Buffer | null;
    kind: string;
    status: string;
  }[] = [];
  const requested: { branchId: Buffer; userId: Buffer | undefined | null }[] = [];
  const events: any[] = [];
  const branches = [
    { id: MAIN, name: 'Main', isActive: true, deletedAt: null, companyId: COMPANY, createdAt: NOW },
    { id: MARKET, name: 'Market', isActive: true, deletedAt: null, companyId: COMPANY, createdAt: NOW },
  ];
  const sub = {
    id: newUuidV7Bin(),
    companyId: COMPANY,
    status: 'activated',
    subscribedBranchCount: 2,
    additionalSeats: opts.additionalSeats ?? 0,
    currentPeriodEnd: null,
    isComplimentary: false,
    complimentaryUntil: null,
  };

  const hydrate = (u: UserRow) => ({
    ...u,
    userBranches: u.branches.map((b) => ({
      branchId: b.branchId,
      branch: branches.find((x) => x.id.equals(b.branchId))!,
      role: { key: b.role },
    })),
    seatAllocations: allocations.filter(
      (a) => a.userId?.equals(u.id) && a.kind === 'seat' && ['pending_payment', 'paid', 'granted'].includes(a.status),
    ),
  });

  const db = {
    user: {
      findFirst: async ({ where }: any) => {
        const u = users.find((x) => x.id.equals(where.id) && x.deletedAt === null);
        return u ? hydrate(u) : null;
      },
      updateMany: async ({ where, data }: any) => {
        const hits = users.filter((x) => x.id.equals(where.id) && x.activatedAt === null && x.deletedAt === null);
        for (const u of hits) Object.assign(u, data);
        return { count: hits.length };
      },
    },
    subscription: { findFirst: async () => ({ ...sub }) },
    branch: { findMany: async () => branches.map((b) => ({ id: b.id, name: b.name })) },
    seatAllocation: {
      findMany: async ({ where }: any) =>
        allocations
          .filter((a) => a.kind === 'seat' && ['paid', 'granted'].includes(a.status) && a.userId !== null)
          .filter((a) => !where.userId.notIn.some((id: Buffer) => id.equals(a.userId!)))
          .filter((a) => {
            const owner = users.find((u) => u.id.equals(a.userId!));
            return owner && owner.activatedAt === null && owner.deletedAt === null;
          })
          .map((a) => ({ branchId: a.branchId })),
    },
    subscriptionEvent: { create: async ({ data }: any) => (events.push(data), data) },
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('FOR UPDATE')) return [{ id: sub.id }];
      if (sql.includes('COUNT(DISTINCT u.id)')) {
        const counts = new Map<string, Set<string>>();
        for (const u of users) {
          if (!u.isActive || u.deletedAt) continue;
          for (const b of u.branches) {
            if (b.role === 'owner') continue;
            const k = b.branchId.toString('hex').toUpperCase();
            if (!counts.has(k)) counts.set(k, new Set());
            counts.get(k)!.add(binToUuid(u.id));
          }
        }
        return [...counts.entries()].map(([branch_hex, set]) => ({ branch_hex, n: BigInt(set.size) }));
      }
      if (sql.includes('FROM seat_allocations')) {
        const out = new Map<string, number>();
        for (const a of allocations) {
          if (a.kind !== 'seat' || !a.branchId || !['paid', 'granted'].includes(a.status)) continue;
          const k = `${a.branchId.toString('hex').toUpperCase()}|${a.status}`;
          out.set(k, (out.get(k) ?? 0) + 1);
        }
        return [...out.entries()].map(([k, n]) => ({
          branch_hex: k.split('|')[0],
          status: k.split('|')[1],
          n: BigInt(n),
        }));
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
  const prisma = { ...db, $transaction: async (fn: (t: typeof db) => Promise<unknown>) => fn(db) };
  const allocationService = {
    requestSeat: async (_c: Buffer, input: { branchId: Buffer; userId?: Buffer | null }) => {
      requested.push({ branchId: input.branchId, userId: input.userId });
      allocations.push({
        id: newUuidV7Bin(),
        companyId: COMPANY,
        branchId: input.branchId,
        userId: input.userId ?? null,
        kind: 'seat',
        status: 'pending_payment',
      });
      return { created: true };
    },
  };
  const service = new StaffActivationService(prisma as never, allocationService as never, { now: () => NOW } as never);

  const addUser = (over: Partial<UserRow>): UserRow => {
    const u: UserRow = {
      id: newUuidV7Bin(),
      companyId: COMPANY,
      name: 'Fatima',
      email: null,
      phone: null,
      emailVerifiedAt: null,
      phoneVerifiedAt: null,
      invitedAt: NOW,
      activatedAt: null,
      isActive: false,
      deletedAt: null,
      branches: [{ branchId: MAIN, role: 'store_employee' }],
      ...over,
    };
    users.push(u);
    return u;
  };
  const active = (branchIds: Buffer[], role = 'store_employee') =>
    addUser({
      name: 'Existing',
      isActive: true,
      activatedAt: NOW,
      invitedAt: null,
      branches: branchIds.map((branchId) => ({ branchId, role })),
    });
  const hold = (branchId: Buffer, userId: Buffer | null, status: 'paid' | 'granted' | 'pending_payment') =>
    allocations.push({ id: newUuidV7Bin(), companyId: COMPANY, branchId, userId, kind: 'seat', status });

  return { service, addUser, active, hold, users, allocations, requested, events };
}

describe('what stands between a pending account and its first sign-in', () => {
  it('every selected contact must be verified: the email if given, the number if given, both if both', async () => {
    const w = makeWorld();
    const both = w.addUser({ email: 'f@shop.test', phone: '+22233445566' });
    expect((await w.service.pendingFor(both.id)).pending).toEqual(['email_verification', 'phone_verification']);
    both.emailVerifiedAt = NOW;
    expect((await w.service.pendingFor(both.id)).pending).toEqual(['phone_verification']);
    const emailOnly = w.addUser({ email: 'g@shop.test', branches: [{ branchId: MARKET, role: 'store_employee' }] });
    expect((await w.service.pendingFor(emailOnly.id)).pending).toEqual(['email_verification']);
  });

  it('the included seat is free when nobody holds it, and taken when somebody does', async () => {
    const w = makeWorld();
    const u = w.addUser({ phone: '+22233445566', phoneVerifiedAt: NOW });
    expect((await w.service.pendingFor(u.id)).pending).toEqual([]);
    w.active([MAIN]);
    expect((await w.service.pendingFor(u.id)).pending).toEqual(['seat_unavailable']);
  });

  it('a seat paid for THIS person counts; one paid for somebody else does not', async () => {
    const w = makeWorld();
    w.active([MAIN]);
    const fatima = w.addUser({ phone: '+22233445566', phoneVerifiedAt: NOW });
    const other = w.addUser({ phone: '+22233445577', phoneVerifiedAt: NOW });
    w.hold(MAIN, other.id, 'paid');
    expect((await w.service.pendingFor(fatima.id)).pending).toEqual(['seat_unavailable']);
    expect((await w.service.pendingFor(other.id)).pending).toEqual([]);
  });

  it('a request awaiting payment keeps the account waiting for the payment, not for a seat', async () => {
    const w = makeWorld();
    w.active([MAIN]);
    const u = w.addUser({ phone: '+22233445566', phoneVerifiedAt: NOW });
    w.hold(MAIN, u.id, 'pending_payment');
    expect((await w.service.pendingFor(u.id)).pending).toEqual(['seat_payment']);
  });

  it('a person at two stores needs a seat at each; a free seat at one store does not seat them at the other', async () => {
    const w = makeWorld();
    w.active([MAIN]);
    const u = w.addUser({
      phone: '+22233445566',
      phoneVerifiedAt: NOW,
      branches: [
        { branchId: MAIN, role: 'store_employee' },
        { branchId: MARKET, role: 'store_employee' },
      ],
    });
    const r = await w.service.tryActivate(u.id, 'test');
    expect(r.activated).toBe(false);
    expect(r.pending).toEqual(['seat_payment']);
    // The server priced ONE seat, at the full store, for this person.
    expect(w.requested).toHaveLength(1);
    expect(w.requested[0].branchId.equals(MAIN)).toBe(true);
    expect(w.requested[0].userId?.equals(u.id)).toBe(true);
  });

  it('a seat bought under the pooled rule and not yet assigned still seats one more person anywhere', async () => {
    const w = makeWorld({ additionalSeats: 1 });
    w.active([MAIN]);
    const u = w.addUser({ phone: '+22233445566', phoneVerifiedAt: NOW });
    expect((await w.service.pendingFor(u.id)).pending).toEqual([]);
  });
});

describe('activating', () => {
  it('flips the account on, once, and writes the timeline event', async () => {
    const w = makeWorld();
    const u = w.addUser({ phone: '+22233445566', phoneVerifiedAt: NOW });
    const r = await w.service.tryActivate(u.id, '+22233445566');
    expect(r).toEqual({ activated: true, alreadyActive: false, pending: [] });
    expect(u.isActive).toBe(true);
    expect(u.activatedAt).toBe(NOW);
    expect(w.events.map((e) => e.kind)).toEqual(['staff_activated']);

    const again = await w.service.tryActivate(u.id, 'retry');
    expect(again).toEqual({ activated: true, alreadyActive: true, pending: [] });
    expect(w.events).toHaveLength(1);
  });

  it('never activates while a contact is unverified, whatever a client claims', async () => {
    const w = makeWorld();
    const u = w.addUser({ email: 'f@shop.test', phone: '+22233445566', phoneVerifiedAt: NOW });
    const r = await w.service.tryActivate(u.id, 'test');
    expect(r.activated).toBe(false);
    expect(u.isActive).toBe(false);
    expect(w.events).toHaveLength(0);
  });

  it('a legacy deactivated account is not an invitation and is left alone', async () => {
    const w = makeWorld();
    const legacy = w.addUser({
      invitedAt: null,
      activatedAt: null,
      isActive: false,
      phone: '+22233445566',
      phoneVerifiedAt: NOW,
    });
    const r = await w.service.tryActivate(legacy.id, 'test');
    expect(r.activated).toBe(false);
    expect(legacy.isActive).toBe(false);
  });

  it('two people verifying at once cannot both take the last seat', async () => {
    const w = makeWorld();
    const a = w.addUser({ phone: '+22233445566', phoneVerifiedAt: NOW });
    const b = w.addUser({ phone: '+22233445577', phoneVerifiedAt: NOW });
    const first = await w.service.tryActivate(a.id, 'a');
    const second = await w.service.tryActivate(b.id, 'b');
    expect(first.activated).toBe(true);
    expect(second.activated).toBe(false);
    expect(second.pending).toEqual(['seat_payment']);
    expect(w.users.filter((u) => u.isActive && u.branches.some((x) => x.role !== 'owner'))).toHaveLength(1);
  });
});
