import { HttpException } from '@nestjs/common';
import { binToUuid, uuidToBin } from '../common/utils/uuid.util';
import { ROLE_PERMISSIONS } from '../rbac/role-permissions';
import { AccessService } from '../rbac/access.service';
import { planPushes } from '../notifications/push-dispatcher';
import { ACTING_OWNER_PERMISSIONS, inForce } from './acting-owner-rules';
import { ActingOwnerService } from './acting-owner.service';
import { stepUpDigest, type StepUpAction } from './acting-owner-step-up';

/**
 * The temporary Acting Owner's lifecycle (D225), on an in-memory double: every appointment and removal needs the
 * Owner's password AND the WhatsApp code for that change; one at a time; a scheduled start; an end read from the
 * clock on each request with no job; an immediate revocation; the delegate's own role afterwards; the audit; and who
 * is pushed. The WhatsApp code itself is proven on the real code service in `acting-owner-step-up.spec.ts`.
 */

const uid = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const id = (n: number) => uuidToBin(uid(n));
const COMPANY = id(1);
const OWNER = id(2);
const MANAGER = id(3);
const EMPLOYEE = id(4);
const STORE = id(10);
const PASSWORD = 'owner-password';
const CHALLENGE = uid(900);
const T0 = new Date('2026-10-30T10:00:00.000Z');

type Row = { id: Buffer; companyId: Buffer; delegateUserId: Buffer; grantedByUserId: Buffer; startsAt: Date; endsAt: Date | null; revokedAt: Date | null; revokedByUserId?: Buffer | null };

function world() {
  const delegations: Row[] = [];
  const notifications: any[] = [];
  const audits: any[] = [];
  const roles = new Map<string, string>([
    [OWNER.toString('hex'), 'owner'],
    [MANAGER.toString('hex'), 'store_manager'],
    [EMPLOYEE.toString('hex'), 'store_employee'],
  ]);
  const roleOf = (u: Buffer) => roles.get(u.toString('hex'));
  const db: any = {
    $queryRaw: async () => [],
    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    userBranch: {
      count: async ({ where }: any) => (roleOf(where.userId) === where.role.key ? 1 : 0),
      findMany: async ({ where }: any) => (roleOf(where.userId) ? [{ id: id(500), roleId: id(600), role: { key: roleOf(where.userId) } }] : []),
    },
    user: {
      findUnique: async () => ({ passwordHash: `hash:${PASSWORD}` }),
      findFirst: async ({ where }: any) => (roleOf(where.id) ? { id: where.id, userBranches: [{ role: { key: roleOf(where.id) } }] } : null),
    },
    userBranchPermission: { findMany: async () => [] },
    actingOwnerDelegation: {
      findMany: async ({ where }: any) => delegations.filter((d) => d.revokedAt === where.revokedAt),
      create: async ({ data }: any) => {
        const row = { revokedAt: null, revokedByUserId: null, ...data };
        delegations.push(row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const hits = delegations.filter((d) => d.id.equals(where.id) && d.revokedAt === null);
        hits.forEach((d) => Object.assign(d, data));
        return { count: hits.length };
      },
      findFirst: async ({ where }: any) => delegations.find((d) => d.id.equals(where.id)) ?? null,
      // What AccessService asks on every request: an appointment in force at the request's own clock.
      count: async ({ where }: any) => delegations.filter((d) => d.delegateUserId.equals(where.delegateUserId) && inForce(d, where.startsAt.lte)).length,
    },
    notification: { create: async ({ data }: any) => void notifications.push(data) },
  };
  const confirms: any[] = [];
  const stepUp = {
    // Stands in for the WhatsApp code: passes only for the change the code was "sent" for.
    sentFor: null as StepUpAction | null,
    request: jest.fn(async (p: { change: StepUpAction }) => {
      stepUp.sentFor = p.change;
      return { challengeId: CHALLENGE, destinationMasked: '+222 ••• 67', expiresAt: T0.toISOString(), resendAvailableAt: null };
    }),
    confirm: jest.fn(async (p: { change: StepUpAction; code: string; challengeId: string }) => {
      confirms.push(p);
      if (!stepUp.sentFor || stepUpDigest(stepUp.sentFor) !== stepUpDigest(p.change) || p.code !== '123456') {
        throw new HttpException({ code: 'code_not_active' }, 409);
      }
      stepUp.sentFor = null; // single use
      return p.challengeId;
    }),
  };
  const hashing = { verify: async (h: string, p: string) => h === `hash:${p}`, verifyDummy: async () => false };
  const as = (actor: Buffer) =>
    new ActingOwnerService(
      db,
      { companyId: () => COMPANY, requireUserId: () => actor } as never,
      { recordTx: async (_tx: unknown, e: unknown) => void audits.push(e) } as never,
      hashing as never,
      stepUp as never,
    );
  // The permissions of the person's own role, as `role_permissions` holds them.
  let currentRole = 'store_employee';
  const access = new AccessService({
    ...db,
    rolePermission: { findMany: async () => (ROLE_PERMISSIONS[currentRole as keyof typeof ROLE_PERMISSIONS] ?? []).map((key) => ({ permission: { key } })) },
  } as never);
  const permissionsOf = async (u: Buffer) => {
    currentRole = roleOf(u)!;
    return access.getEffectivePermissions(u, STORE);
  };
  return { delegations, notifications, audits, stepUp, confirms, as, permissionsOf };
}

const errorCode = (e: unknown) => ((e as HttpException).getResponse() as { code: string }).code;
const statusOf = (e: unknown) => (e as HttpException).getStatus();
const CODE = { challengeId: CHALLENGE, code: '123456' };

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  jest.setSystemTime(T0);
});
afterEach(() => jest.useRealTimers());

describe('the step-up: password AND the WhatsApp code for that change', () => {
  it('an appointment until revoked is refused without the code, and with a code sent for another change', async () => {
    const w = world();
    const owner = w.as(OWNER);
    // No code asked for at all.
    const none = await owner.appoint({ delegateId: binToUuid(MANAGER), currentPassword: PASSWORD, ...CODE }).catch((e: unknown) => e);
    expect(errorCode(none)).toBe('code_not_active');
    // A code asked for "Mohamed until Friday", spent on "Mohamed until revoked".
    await owner.requestCode({ action: 'appoint', delegateId: binToUuid(MANAGER), endsAt: '2026-11-06T23:59:59.000Z', currentPassword: PASSWORD });
    const other = await owner.appoint({ delegateId: binToUuid(MANAGER), currentPassword: PASSWORD, ...CODE }).catch((e: unknown) => e);
    expect(errorCode(other)).toBe('code_not_active');
    expect(w.delegations).toHaveLength(0);
  });

  it('the password comes first: a wrong one sends no code and changes nothing', async () => {
    const w = world();
    const e = await w.as(OWNER).requestCode({ action: 'appoint', delegateId: binToUuid(MANAGER), currentPassword: 'wrong' }).catch((x: unknown) => x);
    expect([statusOf(e), errorCode(e)]).toEqual([403, 'password_incorrect']);
    expect(w.stepUp.request).not.toHaveBeenCalled();
    const f = await w.as(OWNER).appoint({ delegateId: binToUuid(MANAGER), currentPassword: 'wrong', ...CODE }).catch((x: unknown) => x);
    expect(errorCode(f)).toBe('password_incorrect');
    expect(w.stepUp.confirm).not.toHaveBeenCalled();
  });

  it('password and the right code: appointed until revoked, the step-up recorded in the audit', async () => {
    const w = world();
    const owner = w.as(OWNER);
    await owner.requestCode({ action: 'appoint', delegateId: binToUuid(MANAGER), currentPassword: PASSWORD, language: 'fr' });
    expect(w.stepUp.request).toHaveBeenCalledWith(expect.objectContaining({ userId: OWNER, companyId: COMPANY, language: 'fr' }));
    const made = await owner.appoint({ delegateId: binToUuid(MANAGER), currentPassword: PASSWORD, ...CODE });
    expect(made).toMatchObject({ state: 'active', endsAt: null });
    expect(w.audits).toEqual([
      expect.objectContaining({ entityType: 'ActingOwnerDelegation', action: 'create', reason: 'Acting Owner appointed', after: expect.objectContaining({ stepUp: { method: 'password+whatsapp_code', challengeId: CHALLENGE } }) }),
    ]);
    // The code is spent: the same one cannot appoint again.
    const again = await owner.appoint({ delegateId: binToUuid(EMPLOYEE), currentPassword: PASSWORD, ...CODE }).catch((e: unknown) => e);
    expect(errorCode(again)).toBe('code_not_active');
  });

  it('a removal needs its own code too; changing an appointment is a removal and an appointment, each confirmed', async () => {
    const w = world();
    const owner = w.as(OWNER);
    await owner.requestCode({ action: 'appoint', delegateId: binToUuid(MANAGER), currentPassword: PASSWORD });
    const made = await owner.appoint({ delegateId: binToUuid(MANAGER), currentPassword: PASSWORD, ...CODE });
    const bare = await owner.revoke(made.id, { currentPassword: PASSWORD, ...CODE }).catch((e: unknown) => e);
    expect(errorCode(bare)).toBe('code_not_active');
    await owner.requestCode({ action: 'revoke', delegationId: made.id, currentPassword: PASSWORD });
    await owner.revoke(made.id, { currentPassword: PASSWORD, ...CODE });
    await owner.requestCode({ action: 'appoint', delegateId: binToUuid(EMPLOYEE), endsAt: '2026-11-02T23:59:59.000Z', currentPassword: PASSWORD });
    await owner.appoint({ delegateId: binToUuid(EMPLOYEE), endsAt: '2026-11-02T23:59:59.000Z', currentPassword: PASSWORD, ...CODE });
    expect(w.confirms.map((c) => c.change.action)).toEqual(['appoint', 'revoke', 'revoke', 'appoint']);
    expect(w.audits.map((a) => a.reason)).toEqual(['Acting Owner appointed', 'Acting Owner removed', 'Acting Owner appointed']);
    expect(w.audits[1].after.stepUp).toEqual({ method: 'password+whatsapp_code', challengeId: CHALLENGE });
  });
});

describe('one at a time, on the server’s clock', () => {
  async function appoint(w: ReturnType<typeof world>, who: Buffer, startsAt?: string, endsAt?: string) {
    const owner = w.as(OWNER);
    await owner.requestCode({ action: 'appoint', delegateId: binToUuid(who), startsAt, endsAt, currentPassword: PASSWORD });
    return owner.appoint({ delegateId: binToUuid(who), startsAt, endsAt, currentPassword: PASSWORD, ...CODE });
  }

  it('only one active delegation: a second overlapping one is refused (409), a back-to-back one is not', async () => {
    const w = world();
    await appoint(w, MANAGER, undefined, '2026-10-30T20:00:00.000Z');
    const clash = await appoint(w, EMPLOYEE, '2026-10-30T19:00:00.000Z').catch((e: unknown) => e);
    expect([statusOf(clash), errorCode(clash)]).toEqual([409, 'delegation_overlap']);
    await expect(appoint(w, EMPLOYEE, '2026-10-30T20:00:00.000Z', '2026-10-31T20:00:00.000Z')).resolves.toMatchObject({ state: 'scheduled' });
    expect(w.delegations).toHaveLength(2);
  });

  it('an appointment until revoked blocks any later one: no overlap with an open end', async () => {
    const w = world();
    await appoint(w, MANAGER);
    const later = await appoint(w, EMPLOYEE, '2027-01-01T08:00:00.000Z', '2027-01-02T08:00:00.000Z').catch((e: unknown) => e);
    expect(errorCode(later)).toBe('delegation_overlap');
  });

  it('a scheduled start: nothing until then; from then, the Owner’s permissions; at the end, back to their own role — no job runs', async () => {
    const w = world();
    const own = await w.permissionsOf(EMPLOYEE);
    expect(own.has('sale.below_cost')).toBe(false);

    const made = await appoint(w, EMPLOYEE, '2026-10-31T08:00:00.000Z', '2026-10-31T23:59:59.000Z');
    expect(made.state).toBe('scheduled');
    expect((await w.permissionsOf(EMPLOYEE)).has('sale.below_cost')).toBe(false);

    jest.setSystemTime(new Date('2026-10-31T08:00:00.000Z'));
    const acting = await w.permissionsOf(EMPLOYEE);
    for (const key of ACTING_OWNER_PERMISSIONS) expect(acting.has(key)).toBe(true);
    expect(acting.has('integrations.manage')).toBe(false);

    jest.setSystemTime(new Date('2026-10-31T23:59:59.000Z'));
    // The end is read on this request: nothing ran between the two, and the delegate holds exactly their own role again.
    expect([...(await w.permissionsOf(EMPLOYEE))].sort()).toEqual([...own].sort());
  });

  it('a revocation ends it on the very next request', async () => {
    const w = world();
    const made = await appoint(w, MANAGER);
    expect((await w.permissionsOf(MANAGER)).has('user.manage')).toBe(true);
    await w.as(OWNER).requestCode({ action: 'revoke', delegationId: made.id, currentPassword: PASSWORD });
    await w.as(OWNER).revoke(made.id, { currentPassword: PASSWORD, ...CODE });
    expect((await w.permissionsOf(MANAGER)).has('user.manage')).toBe(ROLE_PERMISSIONS.store_manager.includes('user.manage'));
    expect(w.delegations[0]).toMatchObject({ revokedAt: T0, revokedByUserId: OWNER });
  });
});

describe('who is told, and who is pushed', () => {
  it('both are told, with a link to the Acting Owner page; the Owner who did it is not pushed, the person named is', async () => {
    const w = world();
    await w.as(OWNER).requestCode({ action: 'appoint', delegateId: binToUuid(MANAGER), currentPassword: PASSWORD });
    await w.as(OWNER).appoint({ delegateId: binToUuid(MANAGER), currentPassword: PASSWORD, ...CODE });
    expect(w.notifications.map((n) => binToUuid(n.targetUserId)).sort()).toEqual([binToUuid(OWNER), binToUuid(MANAGER)].sort());
    for (const n of w.notifications) expect(n).toMatchObject({ type: 'acting_owner.appointed', actorUserId: OWNER, actionLink: '/acting-owner' });

    const n = w.notifications[0];
    const pushes = planPushes({
      notification: { id: id(700), type: n.type, actionLink: n.actionLink, actorUserId: n.actorUserId },
      storeName: null,
      audience: [
        { userId: OWNER, level: 'all' },
        { userId: MANAGER, level: 'approvals' },
      ],
      devices: [
        { id: id(801), userId: OWNER, token: 'owner', locale: 'fr' },
        { id: id(802), userId: MANAGER, token: 'delegate', locale: 'ar' },
      ],
    });
    expect(pushes.map((p) => p.token)).toEqual(['delegate']);
  });

  it('what the Acting Owner does themselves is never pushed back to them (actorUserId)', () => {
    const pushes = planPushes({
      notification: { id: id(701), type: 'staff.role_changed', actionLink: null, actorUserId: MANAGER },
      storeName: null,
      audience: [
        { userId: OWNER, level: 'all' },
        { userId: MANAGER, level: 'all' },
      ],
      devices: [
        { id: id(801), userId: OWNER, token: 'owner', locale: 'fr' },
        { id: id(802), userId: MANAGER, token: 'delegate', locale: 'ar' },
      ],
    });
    expect(pushes.map((p) => p.token)).toEqual(['owner']);
  });
});
