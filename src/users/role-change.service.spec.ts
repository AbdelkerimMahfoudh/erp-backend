import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { REQUIRE_PERMISSIONS_KEY } from '../rbac/require-permissions.decorator';
import { ROLE_PERMISSIONS } from '../rbac/role-permissions';
import { ACTING_OWNER_PERMISSIONS } from '../acting-owner/acting-owner-rules';
import { delegatedKeysKeptBy } from '../rbac/permission-scope';
import { planPushes } from '../notifications/push-dispatcher';
import { uuidToBin } from '../common/utils/uuid.util';
import { ChangeRoleDto } from './dto/change-role.dto';
import { RoleChangeService, planRoleChange } from './role-change.service';
import { UsersController } from './users.controller';

/** Employee ↔ Manager (D225), without deleting the account. */

const id = (n: number) => uuidToBin(`00000000-0000-7000-8000-${String(n).padStart(12, '0')}`);
const uid = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const COMPANY = id(1);
const OWNER = id(2);
const PERSON = id(3);
const A = id(10);
const B = id(11);
const C = id(12);
const ROLE = { store_manager: id(20), store_employee: id(21), owner: id(22) };

describe('the plan', () => {
  const at = (branchId: Buffer, role: string, n: number) => ({ id: id(100 + n), branchId, role });

  it('promotion makes the chosen stores managed, adds a new one and leaves the others', () => {
    const plan = planRoleChange([at(A, 'store_employee', 1), at(B, 'store_employee', 2)], 'store_manager', [A, C]);
    expect(plan.update.map((a) => a.branchId)).toEqual([A]);
    expect(plan.create).toEqual([C]);
    expect(plan.remove).toEqual([]);
  });

  it('demotion keeps the chosen stores as an Employee and leaves the stores no longer kept', () => {
    const plan = planRoleChange([at(A, 'store_manager', 1), at(B, 'store_manager', 2)], 'store_employee', [A]);
    expect(plan.update.map((a) => a.branchId)).toEqual([A]);
    expect(plan.remove.map((a) => a.branchId)).toEqual([B]);
  });

  it('nothing to do is nothing', () => {
    const plan = planRoleChange([at(A, 'store_manager', 1)], 'store_manager', [A]);
    expect(plan.update.length + plan.create.length + plan.remove.length).toBe(0);
  });
});

function harness(opts: { assignments: { branchId: Buffer; role: string }[]; seats?: boolean }) {
  const rows = opts.assignments.map((a, i) => ({ id: id(200 + i), branchId: a.branchId, roleId: ROLE[a.role as keyof typeof ROLE], role: a.role }));
  const grants = new Map<string, number>(rows.map((r) => [r.id.toString('hex'), 1]));
  const audits: any[] = [];
  const notes: any[] = [];
  const keyOf = (roleId: Buffer) => (Object.entries(ROLE).find(([, v]) => v.equals(roleId)) ?? [''])[0];
  const tx: any = {
    $queryRaw: async () => [],
    user: {
      findFirst: async () => ({ id: PERSON, name: 'Aminetou', isActive: true, userBranches: rows.map((r) => ({ id: r.id, branchId: r.branchId, role: { key: r.role } })) }),
    },
    branch: { findMany: async ({ where }: any) => where.id.in.filter((b: Buffer) => [A, B, C].some((x) => x.equals(b))).map((b: Buffer) => ({ id: b })) },
    role: { findMany: async () => [{ id: ROLE.store_manager, key: 'store_manager' }, { id: ROLE.store_employee, key: 'store_employee' }] },
    userBranch: {
      update: async ({ where, data }: any) => {
        const r = rows.find((x) => x.id.equals(where.id))!;
        r.roleId = data.roleId;
        r.role = keyOf(data.roleId);
      },
      create: async ({ data }: any) => void rows.push({ id: data.id, branchId: data.branchId, roleId: data.roleId, role: keyOf(data.roleId) }),
      delete: async ({ where }: any) => void rows.splice(rows.findIndex((x) => x.id.equals(where.id)), 1),
      findMany: async () => rows.map((r) => ({ branchId: r.branchId, role: { key: r.role } })),
    },
    userBranchPermission: {
      deleteMany: async ({ where }: any) => {
        const k = where.userBranchId.toString('hex');
        const n = grants.get(k) ?? 0;
        grants.set(k, 0);
        return { count: n };
      },
    },
    notification: { create: async ({ data }: any) => void notes.push(data) },
  };
  const db = { $transaction: async (fn: any) => fn(tx) };
  const tenant = { requireUserId: () => OWNER, companyId: () => COMPANY };
  const audit = { recordTx: async (_tx: unknown, p: unknown) => void audits.push(p) };
  const entitlement = { maySeat: jest.fn(async () => ({ allowed: opts.seats ?? true, full: opts.seats === false ? [uid(12)] : [] })) };
  return { service: new RoleChangeService(db as never, tenant as never, audit as never, entitlement as never), rows, audits, notes, entitlement, grants, tx };
}

describe('changing a role', () => {
  it('is the Owner’s alone (user.manage)', () => {
    expect(Reflect.getMetadata(REQUIRE_PERMISSIONS_KEY, UsersController.prototype.changeRole)).toEqual(['user.manage']);
  });

  it('accepts only Manager or Employee, with at least one store', () => {
    const errors = (body: object) => validateSync(plainToInstance(ChangeRoleDto, body)).map((e) => e.property);
    expect(errors({ role: 'owner', branchIds: [uid(10)] })).toEqual(['role']);
    expect(errors({ role: 'administrator', branchIds: [uid(10)] })).toEqual(['role']);
    expect(errors({ role: 'store_manager', branchIds: [] })).toEqual(['branchIds']);
    expect(errors({ role: 'store_manager', branchIds: [uid(10)] })).toEqual([]);
  });

  it('promotes an Employee to Manager of the chosen stores, audits and tells the person', async () => {
    const h = harness({ assignments: [{ branchId: A, role: 'store_employee' }] });
    const out = await h.service.change(uid(3), { role: 'store_manager', branchIds: [uid(10)] });
    expect(out.assignments).toEqual([{ branchId: uid(10), role: 'store_manager' }]);
    expect(h.audits[0]).toMatchObject({ entityType: 'User', reason: 'Promoted to Manager', before: { assignments: [{ role: 'store_employee' }] } });
    expect(h.notes[0]).toMatchObject({ targetUserId: PERSON, type: 'staff.role_changed', payload: { role: 'store_manager' } });
  });

  it('demotes a Manager: the kept store becomes Employee, the others are left, manager-only grants are pruned', async () => {
    const h = harness({ assignments: [{ branchId: A, role: 'store_manager' }, { branchId: B, role: 'store_manager' }] });
    const out = await h.service.change(uid(3), { role: 'store_employee', branchIds: [uid(10)] });
    expect(out.assignments).toEqual([{ branchId: uid(10), role: 'store_employee' }]);
    expect(out.grantsRemoved).toBeGreaterThan(0);
    expect(h.rows).toHaveLength(1);
  });

  it('a new store for the person needs a free seat there; nothing changes without one', async () => {
    const h = harness({ assignments: [{ branchId: A, role: 'store_employee' }], seats: false });
    await expect(h.service.change(uid(3), { role: 'store_manager', branchIds: [uid(12)] })).rejects.toBeInstanceOf(ConflictException);
    expect(h.rows.map((r) => r.role)).toEqual(['store_employee']);
    expect(h.audits).toEqual([]);
  });

  it('never changes the Owner, and never one’s own role', async () => {
    const owner = harness({ assignments: [{ branchId: A, role: 'owner' }] });
    await expect(owner.service.change(uid(3), { role: 'store_employee', branchIds: [uid(10)] })).rejects.toBeInstanceOf(ForbiddenException);
    const self = harness({ assignments: [{ branchId: A, role: 'store_manager' }] });
    await expect(self.service.change(uid(2), { role: 'store_employee', branchIds: [uid(10)] })).rejects.toMatchObject({ response: { code: 'role_change_self' } });
  });

  it('refuses a store of another business, and a change that changes nothing', async () => {
    const h = harness({ assignments: [{ branchId: A, role: 'store_manager' }] });
    await expect(h.service.change(uid(3), { role: 'store_manager', branchIds: [uid(99)] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.service.change(uid(3), { role: 'store_manager', branchIds: [uid(10)] })).rejects.toMatchObject({ response: { code: 'role_unchanged' } });
  });
});

describe('who may change a role, and what it changes (D225)', () => {
  it('only the Owner holds user.manage; a Manager or an Employee cannot reach the route at all', () => {
    expect(ROLE_PERMISSIONS.owner).toContain('user.manage');
    expect(ROLE_PERMISSIONS.store_manager).not.toContain('user.manage');
    expect(ROLE_PERMISSIONS.store_employee).not.toContain('user.manage');
  });

  it('an Acting Owner holds it by delegation (Employee ↔ Manager is delegated), still never the Owner’s own role', async () => {
    expect(ACTING_OWNER_PERMISSIONS).toContain('user.manage');
    // Whoever calls, a person who is Owner in any store is refused, and nothing is written.
    const h = harness({ assignments: [{ branchId: A, role: 'owner' }, { branchId: B, role: 'store_manager' }] });
    await expect(h.service.change(uid(3), { role: 'store_employee', branchIds: [uid(11)] })).rejects.toMatchObject({ response: { code: 'owner_role_fixed' } });
    expect(h.rows.map((r) => r.role)).toEqual(['owner', 'store_manager']);
    expect(h.audits).toEqual([]);
    expect(h.notes).toEqual([]);
  });

  it('nobody can be made Owner here, whoever asks', () => {
    const errors = (body: object) => validateSync(plainToInstance(ChangeRoleDto, body)).map((e) => e.property);
    expect(errors({ role: 'owner', branchIds: [uid(10)] })).toEqual(['role']);
    expect(errors({ role: 'acting_owner', branchIds: [uid(10)] })).toEqual(['role']);
  });

  it('a promotion keeps the person’s other stores exactly as they were', async () => {
    const h = harness({ assignments: [{ branchId: A, role: 'store_employee' }, { branchId: B, role: 'store_employee' }] });
    const out = await h.service.change(uid(3), { role: 'store_manager', branchIds: [uid(10)] });
    expect(out.assignments).toEqual([
      { branchId: uid(10), role: 'store_manager' },
      { branchId: uid(11), role: 'store_employee' },
    ]);
    expect(out.grantsRemoved).toBe(0);
  });

  it('a demotion prunes, in the same transaction, the delegated grants an Employee may not hold (price editing), keeping the rest', async () => {
    const h = harness({ assignments: [{ branchId: A, role: 'store_manager' }] });
    const deleteMany = jest.spyOn(h.tx.userBranchPermission, 'deleteMany');
    await h.service.change(uid(3), { role: 'store_employee', branchIds: [uid(10)] });
    const kept = delegatedKeysKeptBy('store_employee');
    expect(kept).not.toContain('price.edit');
    expect(deleteMany).toHaveBeenCalledWith({ where: { userBranchId: id(200), permission: { key: { notIn: kept } } } });
  });

  it('the audit row carries every store before and after, and why', async () => {
    const h = harness({ assignments: [{ branchId: A, role: 'store_manager' }, { branchId: B, role: 'store_manager' }] });
    await h.service.change(uid(3), { role: 'store_employee', branchIds: [uid(10)] });
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toEqual({
      entityType: 'User',
      entityId: PERSON,
      action: 'update',
      before: { assignments: [{ branchId: uid(10), role: 'store_manager' }, { branchId: uid(11), role: 'store_manager' }] },
      after: { assignments: [{ branchId: uid(10), role: 'store_employee' }], grantsRemoved: 2 },
      reason: 'Made an Employee',
    });
  });

  it('the person is told (staff.role_changed); the one who made the change is never pushed their own action', async () => {
    const h = harness({ assignments: [{ branchId: A, role: 'store_employee' }] });
    await h.service.change(uid(3), { role: 'store_manager', branchIds: [uid(10)] });
    expect(h.notes).toHaveLength(1);
    const note = h.notes[0];
    expect(note).toMatchObject({ targetUserId: PERSON, actorUserId: OWNER, type: 'staff.role_changed', payload: { role: 'store_manager', branchIds: [uid(10)], actorId: uid(2) } });
    const pushes = planPushes({
      notification: { id: note.id, type: note.type, actionLink: null, actorUserId: note.actorUserId },
      storeName: null,
      // Even if the actor were in the audience, at the most talkative level: the self-action rule removes them.
      audience: [
        { userId: PERSON, level: 'important' },
        { userId: OWNER, level: 'all' },
      ],
      devices: [
        { id: id(300), userId: PERSON, token: 'person-phone', locale: 'fr' },
        { id: id(301), userId: OWNER, token: 'owner-phone', locale: 'en' },
      ],
    });
    expect(pushes.map((p) => p.token)).toEqual(['person-phone']);
  });

  it('re-applying the same role is a no-op: refused as unchanged, with no write, no audit and no notification', async () => {
    const h = harness({ assignments: [{ branchId: A, role: 'store_manager' }, { branchId: B, role: 'store_employee' }] });
    const writes = [
      jest.spyOn(h.tx.userBranch, 'update'),
      jest.spyOn(h.tx.userBranch, 'create'),
      jest.spyOn(h.tx.userBranch, 'delete'),
      jest.spyOn(h.tx.userBranchPermission, 'deleteMany'),
    ];
    await expect(h.service.change(uid(3), { role: 'store_manager', branchIds: [uid(10)] })).rejects.toMatchObject({ response: { code: 'role_unchanged' } });
    for (const w of writes) expect(w).not.toHaveBeenCalled();
    expect(h.audits).toEqual([]);
    expect(h.notes).toEqual([]);
    expect(h.entitlement.maySeat).not.toHaveBeenCalled();
  });

  it('concurrent changes serialise: the person’s row is locked FOR UPDATE before anything is read', async () => {
    const h = harness({ assignments: [{ branchId: A, role: 'store_employee' }] });
    const order: string[] = [];
    let lockedId: unknown;
    h.tx.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      order.push(`lock:${strings.join('?')}`);
      lockedId = values[0];
      return [];
    };
    const read = h.tx.user.findFirst;
    h.tx.user.findFirst = async (...args: unknown[]) => {
      order.push('read');
      return read(...args);
    };
    await h.service.change(uid(3), { role: 'store_manager', branchIds: [uid(10)] });
    expect(order[0]).toBe('lock:SELECT id FROM users WHERE id = ? FOR UPDATE');
    expect(order[1]).toBe('read');
    expect(lockedId).toEqual(PERSON);
  });

  it('two changes in a row behave as the lock makes them: the second reads what the first set and changes nothing', async () => {
    const h = harness({ assignments: [{ branchId: A, role: 'store_employee' }] });
    await h.service.change(uid(3), { role: 'store_manager', branchIds: [uid(10)] });
    await expect(h.service.change(uid(3), { role: 'store_manager', branchIds: [uid(10)] })).rejects.toMatchObject({ response: { code: 'role_unchanged' } });
    expect(h.rows).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
    expect(h.notes).toHaveLength(1);
  });
});
