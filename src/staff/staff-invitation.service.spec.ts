import { readFileSync } from 'node:fs';
import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { StaffInvitationService } from './staff-invitation.service';
import { newUuidV7Bin, uuidToBin, binToUuid } from '../common/utils/uuid.util';

/**
 * Creating an employee account is not the same as the account being usable
 * (docs/21, 2026-10-05): it is created pending, with an unguessable password;
 * codes go out only on channels that can deliver; a duplicate invitation is
 * the same account; the person proves each contact and chooses a password;
 * and only the server's activation gate can switch the account on.
 */

const COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c001');
const OWNER = uuidToBin('018f0000-0000-7000-8000-00000000a001');
const MAIN = uuidToBin('018f0000-0000-7000-8000-00000000b001');
const ROLE = uuidToBin('018f0000-0000-7000-8000-00000000d001');
const NOW = new Date('2026-10-05T10:00:00.000Z');

function makeWorld(
  opts: { canDeliver?: (channel: string) => boolean; activation?: { activated: boolean; pending: string[] } } = {},
) {
  const users: any[] = [
    {
      id: OWNER,
      companyId: COMPANY,
      name: 'Owner',
      email: 'owner@shop.test',
      phone: null,
      deletedAt: null,
      invitedAt: null,
      activatedAt: NOW,
      isActive: true,
      emailVerifiedAt: NOW,
      phoneVerifiedAt: null,
      userBranches: [],
    },
  ];
  const userBranches: any[] = [];
  const audits: any[] = [];
  const started: string[] = [];
  const challenges = new Map<string, { id: Buffer; code: string; consumedAt: Date | null }>();
  const hashed: string[] = [];
  const activations: Buffer[] = [];
  const seatRequests: any[] = [];
  const withdrawn: Buffer[] = [];
  let seatsFull: string[] = [];

  const matchesUser = (u: any, where: any): boolean => {
    if (where.id && !u.id.equals(where.id)) return false;
    if (where.companyId && !u.companyId.equals(where.companyId)) return false;
    if ('deletedAt' in where && where.deletedAt === null && u.deletedAt !== null) return false;
    if ('activatedAt' in where && where.activatedAt === null && u.activatedAt !== null) return false;
    if (where.invitedAt?.not === null && u.invitedAt === null) return false;
    if (where.email && u.email !== where.email) return false;
    if (where.phone && u.phone !== where.phone) return false;
    if (where.OR && !where.OR.some((o: any) => (o.email && u.email === o.email) || (o.phone && u.phone === o.phone)))
      return false;
    return true;
  };
  const hydrate = (u: any) => ({
    ...u,
    company: { name: 'Shop' },
    userBranches: userBranches
      .filter((ub) => ub.userId.equals(u.id))
      .map((ub) => ({ branch: { id: MAIN, name: 'Main' }, role: { key: 'store_employee' } })),
    seatAllocations: seatRequests
      .filter((r) => r.userId?.equals(u.id))
      .map((r) => ({ branchId: r.branchId, status: 'pending_payment' })),
  });

  const db = {
    user: {
      findUniqueOrThrow: async ({ where }: any) => hydrate(users.find((u) => u.id.equals(where.id))),
      findFirst: async ({ where }: any) => {
        const u = users.find((x) => matchesUser(x, where));
        return u ? hydrate(u) : null;
      },
      findMany: async ({ where }: any) => users.filter((x) => matchesUser(x, where)).map(hydrate),
      create: async ({ data }: any) => {
        hashed.push(data.passwordHash);
        users.push({ ...data, emailVerifiedAt: null, phoneVerifiedAt: null, deletedAt: null });
        return data;
      },
      update: async ({ where, data }: any) => {
        const u = users.find((x) => x.id.equals(where.id));
        Object.assign(u, data);
        return u;
      },
    },
    branch: {
      findMany: async ({ where }: any) =>
        where.id.in.some((id: Buffer) => id.equals(MAIN)) ? [{ id: MAIN, name: 'Main' }] : [],
    },
    role: { findFirst: async () => ({ id: ROLE }) },
    userBranch: { create: async ({ data }: any) => (userBranches.push(data), data) },
    seatAllocation: { findMany: async () => seatRequests.map((r) => ({ id: r.id })) },
    contactVerification: {
      updateMany: async ({ where }: any) => {
        const c = [...challenges.values()].find((x) => x.id.equals(where.id) && x.consumedAt === null);
        if (c) c.consumedAt = NOW;
        return { count: c ? 1 : 0 };
      },
    },
  };
  const prisma = { ...db, $transaction: async (fn: (t: typeof db) => Promise<unknown>) => fn(db) };
  const tenant = { companyId: () => COMPANY, requireUserId: () => OWNER };
  const audit = { recordTx: async (_tx: unknown, e: unknown) => void audits.push(e) };
  const hashing = { hash: async (s: string) => `hash(${s})` };
  const verification = {
    start: async (destination: string) => {
      started.push(destination);
      challenges.set(destination, { id: newUuidV7Bin(), code: '123456', consumedAt: null });
      return { delivery: 'outbox' as const };
    },
    latestChallengeFor: async (destination: string) => {
      const c = challenges.get(destination);
      return c && c.consumedAt === null ? c.id : null;
    },
    confirmChallenge: async (id: Buffer, code: string) => {
      const c = [...challenges.values()].find((x) => x.id.equals(id));
      if (!c || c.consumedAt) return 'gone';
      return c.code === code ? 'ok' : 'wrong';
    },
  };
  const canDeliver = opts.canDeliver ?? (() => true);
  const delivery = { canDeliver };
  const outbox = { peek: () => '123456' };
  const entitlement = {
    maySeat: async () => ({ allowed: seatsFull.length === 0, full: seatsFull, seatsUsed: 0, seatLimit: 1, stores: [] }),
  };
  const activation = {
    pendingFor: async () => ({ activated: false, alreadyActive: false, pending: ['phone_verification'] }),
    tryActivate: async (userId: Buffer) => {
      activations.push(userId);
      return opts.activation ?? { activated: true, alreadyActive: false, pending: [] };
    },
  };
  const allocations = {
    requestSeat: async (_c: Buffer, input: any) => {
      seatRequests.push({ id: newUuidV7Bin(), ...input });
      return { created: true };
    },
    withdraw: async (_c: Buffer, id: Buffer) => void withdrawn.push(id),
  };
  const service = new StaffInvitationService(
    prisma as never,
    tenant as never,
    audit as never,
    hashing as never,
    verification as never,
    delivery as never,
    outbox as never,
    entitlement as never,
    activation as never,
    allocations as never,
  );
  return {
    service,
    users,
    userBranches,
    audits,
    started,
    hashed,
    activations,
    seatRequests,
    withdrawn,
    setSeatsFull: (ids: string[]) => void (seatsFull = ids),
  };
}

const INVITE = {
  name: 'Fatima',
  phone: '+222 33 44 55 66',
  branchIds: [binToUuid(MAIN)],
  role: 'store_employee' as const,
};

describe('creating an account', () => {
  it('creates it pending and inactive, with a password nobody knows, and sends a code on the selected channel', async () => {
    const w = makeWorld();
    const r = await w.service.invite(INVITE);
    expect(r.created).toBe(true);
    expect(r.user.status).toBe('pending');
    const row = w.users.find((u) => u.name === 'Fatima')!;
    expect(row.isActive).toBe(false);
    expect(row.invitedAt).toBeInstanceOf(Date);
    expect(row.activatedAt).toBeNull();
    expect(row.phone).toBe('+22233445566');
    expect(w.hashed[0]).toMatch(/^hash\(/);
    expect(w.hashed[0]).not.toContain('Fatima');
    expect(r.verification).toEqual({ email: null, phone: 'sent' });
    expect(w.started).toEqual(['+22233445566']);
    expect(w.userBranches).toHaveLength(1);
    expect(w.audits[0]).toMatchObject({ action: 'create', after: expect.objectContaining({ status: 'pending' }) });
    // Local development only: the code the outbox holds, so the flow can be finished on one machine.
    expect(r.devCodes).toEqual({ phone: '123456' });
  });

  it('with both contacts, both codes go out and both must be proven', async () => {
    const w = makeWorld();
    const r = await w.service.invite({ ...INVITE, email: 'Fatima@Shop.test' });
    expect(r.verification).toEqual({ email: 'sent', phone: 'sent' });
    expect(w.started.sort()).toEqual(['+22233445566', 'fatima@shop.test']);
  });

  it('refuses an account with no contact at all', async () => {
    const w = makeWorld();
    await expect(
      w.service.invite({ name: 'Nobody', branchIds: [binToUuid(MAIN)], role: 'store_employee' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(w.users).toHaveLength(1);
  });

  it('when a channel cannot deliver, the account is still created, nothing pretends a code went out, and no code is shown', async () => {
    const w = makeWorld({ canDeliver: () => false });
    const r = await w.service.invite({ ...INVITE, email: 'f@shop.test' });
    expect(r.created).toBe(true);
    expect(r.verification).toEqual({ email: 'unavailable', phone: 'unavailable' });
    expect(w.started).toEqual([]);
    expect(r.devCodes).toBeUndefined();
    expect(w.users.find((u) => u.name === 'Fatima')!.isActive).toBe(false);
  });

  it('the same person invited twice is one pending account, not two', async () => {
    const w = makeWorld();
    const a = await w.service.invite(INVITE);
    const b = await w.service.invite({ ...INVITE, name: 'Fatima again' });
    expect(b.created).toBe(false);
    expect(b.user.id).toBe(a.user.id);
    expect(w.users.filter((u) => u.phone === '+22233445566')).toHaveLength(1);
  });

  it('a contact an active colleague already uses is refused', async () => {
    const w = makeWorld();
    await expect(w.service.invite({ ...INVITE, email: 'owner@shop.test', phone: undefined })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('with no free seat at the store, the server prices a seat and the account waits for the payment', async () => {
    const w = makeWorld();
    w.setSeatsFull([binToUuid(MAIN)]);
    const r = await w.service.invite(INVITE);
    expect(w.seatRequests).toHaveLength(1);
    expect(w.seatRequests[0].branchId.equals(MAIN)).toBe(true);
    expect(r.seats).toEqual([{ storeId: binToUuid(MAIN), store: 'Main', state: 'awaiting_payment' }]);
  });
});

describe('the person proving a contact', () => {
  it('a wrong code, an unknown destination and a code for nobody answer the same way', async () => {
    const w = makeWorld();
    await w.service.invite(INVITE);
    await expect(w.service.confirm('+22233445566', '000000', 'Secret-pass-1')).rejects.toThrow(
      'That code did not match.',
    );
    await expect(w.service.confirm('+22299999999', '123456', 'Secret-pass-1')).rejects.toThrow(
      'That code did not match.',
    );
    await expect(w.service.confirm('not a contact', '123456')).rejects.toThrow('That code did not match.');
  });

  it('asks for a password the first time, without spending the code', async () => {
    const w = makeWorld();
    await w.service.invite(INVITE);
    await expect(w.service.confirm('+22233445566', '123456')).rejects.toMatchObject({
      response: { code: 'password_required' },
    });
    // The code is still live: the same code now succeeds with a password.
    const r = await w.service.confirm('+222 33 44 55 66', '123456', 'Secret-pass-1');
    expect(r.verified).toBe(true);
  });

  it('marks the contact verified, sets the chosen password, consumes the code, and asks the gate to activate', async () => {
    const w = makeWorld();
    await w.service.invite(INVITE);
    const r = await w.service.confirm('+22233445566', '123456', 'Secret-pass-1');
    const row = w.users.find((u) => u.name === 'Fatima')!;
    expect(row.phoneVerifiedAt).toBeInstanceOf(Date);
    expect(row.passwordHash).toBe('hash(Secret-pass-1)');
    expect(w.activations).toHaveLength(1);
    expect(r.accounts).toEqual([{ business: 'Shop', name: 'Fatima', activated: true, pending: [] }]);
    // Spent: the same code is a miss now.
    await expect(w.service.confirm('+22233445566', '123456')).rejects.toThrow('That code did not match.');
  });

  it('with both contacts, the second proof needs no password and the gate decides when both are done', async () => {
    const w = makeWorld({ activation: { activated: false, pending: ['email_verification'] } });
    await w.service.invite({ ...INVITE, email: 'f@shop.test' });
    const first = await w.service.confirm('+22233445566', '123456', 'Secret-pass-1');
    expect(first.accounts[0]).toMatchObject({ activated: false, pending: ['email_verification'] });
    const second = await w.service.confirm('f@shop.test', '123456');
    expect(second.verified).toBe(true);
    const row = w.users.find((u) => u.name === 'Fatima')!;
    expect(row.emailVerifiedAt).toBeInstanceOf(Date);
    expect(row.passwordHash).toBe('hash(Secret-pass-1)');
  });
});

describe('the Owner managing an invitation', () => {
  it('resending is refused honestly when nothing can deliver, and the account stays pending', async () => {
    const w = makeWorld({ canDeliver: () => false });
    const r = await w.service.invite(INVITE);
    await expect(w.service.resend(r.user.id, 'phone')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(w.users.find((u) => u.name === 'Fatima')!.isActive).toBe(false);
  });

  it('cancelling withdraws the account and its seat request', async () => {
    const w = makeWorld();
    w.setSeatsFull([binToUuid(MAIN)]);
    const r = await w.service.invite(INVITE);
    await w.service.cancel(r.user.id);
    const row = w.users.find((u) => u.name === 'Fatima')!;
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(w.withdrawn).toHaveLength(1);
    await expect(w.service.cancel(r.user.id)).rejects.toThrow('Unknown user');
  });

  it('an active account is not an invitation', async () => {
    const w = makeWorld();
    await expect(w.service.resend(binToUuid(OWNER), 'email')).rejects.toMatchObject({
      response: { code: 'not_pending' },
    });
  });
});

describe('the gate holds on every other path', () => {
  it('sign-in considers only active accounts, so a pending one cannot sign in by any client', () => {
    const users = readFileSync('src/users/users.service.ts', 'utf8');
    expect(users).toMatch(/const base = \{ deletedAt: null, isActive: true \};/);
  });

  it('the Team PATCH cannot switch a pending account on by hand', () => {
    const management = readFileSync('src/users/user-management.service.ts', 'utf8');
    expect(management).toMatch(/activation_pending/);
  });

  it('only the activation service writes activated_at', () => {
    for (const f of [
      'src/staff/staff-invitation.service.ts',
      'src/users/user-management.service.ts',
      'src/platform/seat-allocation.service.ts',
    ]) {
      const src = readFileSync(f, 'utf8');
      expect({ f, ok: !/activatedAt:\s*(now|new Date)/.test(src) }).toEqual({ f, ok: true });
    }
  });
});
