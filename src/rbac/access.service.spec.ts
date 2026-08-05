import { ForbiddenException } from '@nestjs/common';
import { AccessService } from './access.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';

/**
 * The branch-safety boundary and per-branch delegation (F1 Stage 2).
 *
 * With a branch context the resolver returns the role's permissions at that
 * branch PLUS any delegated grant — but a grant counts only on a store_manager
 * assignment and only for a delegatable permission. WITHOUT a branch context it
 * returns company-wide permissions only, so branch-scoped authority (role or
 * delegated) never leaks across branches.
 */

const USER = newUuidV7Bin();
const BRANCH_A = newUuidV7Bin();
const BRANCH_B = newUuidV7Bin();
const UB_A = newUuidV7Bin(); // assignment in branch A
const UB_B = newUuidV7Bin(); // assignment in branch B
const ROLE_MANAGER = newUuidV7Bin();
const ROLE_EMPLOYEE = newUuidV7Bin();

// Neither role has price.edit by role — it arrives only via a grant.
const ROLE_PERMS: { roleId: Buffer; key: string }[] = [
  { roleId: ROLE_MANAGER, key: 'sale.create' },
  { roleId: ROLE_MANAGER, key: 'settings.manage' }, // a company-wide perm
  { roleId: ROLE_EMPLOYEE, key: 'sale.create' },
];

interface Assignment {
  id: Buffer;
  branchId: Buffer;
  roleId: Buffer;
  roleKey: string;
}
interface Grant {
  userBranchId: Buffer;
  key: string;
}

function makeService(assignments: Assignment[], grants: Grant[] = []) {
  const db: any = {
    userBranch: {
      findMany: jest.fn(async ({ where }: any) =>
        assignments
          .filter((a) => where.branchId === undefined || a.branchId.equals(where.branchId))
          .map((a) => ({ id: a.id, roleId: a.roleId, role: { key: a.roleKey } })),
      ),
    },
    rolePermission: {
      findMany: jest.fn(async ({ where }: any) => {
        const roleIds: Buffer[] = where.roleId.in;
        return ROLE_PERMS.filter((p) => roleIds.some((r) => r.equals(p.roleId))).map((p) => ({
          permission: { key: p.key },
        }));
      }),
    },
    userBranchPermission: {
      findMany: jest.fn(async ({ where }: any) => {
        const ids: Buffer[] = where.userBranchId.in;
        return grants
          .filter((g) => ids.some((i) => i.equals(g.userBranchId)))
          .map((g) => ({ permission: { key: g.key } }));
      }),
    },
  };
  return new AccessService(db as never);
}

const managerInA: Assignment = { id: UB_A, branchId: BRANCH_A, roleId: ROLE_MANAGER, roleKey: 'store_manager' };
const employeeInB: Assignment = { id: UB_B, branchId: BRANCH_B, roleId: ROLE_EMPLOYEE, roleKey: 'store_employee' };

describe('branch-safety boundary', () => {
  it('returns the role permissions for the branch when a branch is given', async () => {
    const svc = makeService([managerInA, employeeInB]);
    expect(await svc.getEffectivePermissions(USER, BRANCH_A)).toEqual(
      new Set(['sale.create', 'settings.manage']),
    );
    expect(await svc.getEffectivePermissions(USER, BRANCH_B)).toEqual(new Set(['sale.create']));
  });

  it('without a branch, keeps ONLY company-wide permissions', async () => {
    const svc = makeService([managerInA, employeeInB]);
    const perms = await svc.getEffectivePermissions(USER);
    expect(perms).toEqual(new Set(['settings.manage']));
    expect(perms.has('sale.create')).toBe(false);
  });

  it('403s for a branch the user is not assigned to', async () => {
    const svc = makeService([managerInA]);
    await expect(svc.getEffectivePermissions(USER, BRANCH_B)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('grants nothing when the user has no assignments', async () => {
    expect(await makeService([]).getEffectivePermissions(USER)).toEqual(new Set());
  });
});

describe('per-branch delegated grants (Stage 2)', () => {
  it('a manager with a price.edit grant HAS it — but only in the granted branch', async () => {
    const svc = makeService([managerInA, employeeInB], [{ userBranchId: UB_A, key: 'price.edit' }]);

    expect((await svc.getEffectivePermissions(USER, BRANCH_A)).has('price.edit')).toBe(true);
    // Same person, other branch (employee there, no grant): unprivileged.
    expect((await svc.getEffectivePermissions(USER, BRANCH_B)).has('price.edit')).toBe(false);
  });

  it('a delegated grant never leaks to the no-branch (company) resolution', async () => {
    const svc = makeService([managerInA], [{ userBranchId: UB_A, key: 'price.edit' }]);
    expect((await svc.getEffectivePermissions(USER)).has('price.edit')).toBe(false);
  });

  it('a grant on a non-manager assignment is ignored (employee cannot receive; downgrade neutralizes)', async () => {
    // Same assignment id UB_A but the role is now store_employee.
    const downgraded: Assignment = { ...managerInA, roleId: ROLE_EMPLOYEE, roleKey: 'store_employee' };
    const svc = makeService([downgraded], [{ userBranchId: UB_A, key: 'price.edit' }]);
    expect((await svc.getEffectivePermissions(USER, BRANCH_A)).has('price.edit')).toBe(false);
  });

  it('a grant of a non-delegatable permission is never honoured, even on a manager', async () => {
    const svc = makeService(
      [managerInA],
      [
        { userBranchId: UB_A, key: 'discount.override' },
        { userBranchId: UB_A, key: 'user.manage' },
      ],
    );
    const perms = await svc.getEffectivePermissions(USER, BRANCH_A);
    expect(perms.has('discount.override')).toBe(false);
    expect(perms.has('user.manage')).toBe(false);
  });
});
