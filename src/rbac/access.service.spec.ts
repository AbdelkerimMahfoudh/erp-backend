import { ForbiddenException } from '@nestjs/common';
import { AccessService } from './access.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';

/**
 * The branch-safety boundary (F1 Stage 2 hardening).
 *
 * With a branch context the resolver returns everything the role has at that
 * branch. WITHOUT one it returns only company-wide permissions — branch-scoped
 * authority (an operational role permission, or a per-branch delegated grant)
 * never survives the cross-branch union, so it cannot apply company-wide.
 */

const USER = newUuidV7Bin();
const BRANCH_A = newUuidV7Bin();
const BRANCH_B = newUuidV7Bin();
const ROLE_MANAGER = newUuidV7Bin(); // branch A
const ROLE_EMPLOYEE = newUuidV7Bin(); // branch B

// Role A mixes branch-scoped perms (sale.create, price.edit) with a company one
// (settings.manage); role B has only a branch-scoped perm.
const ROLE_PERMS: { roleId: Buffer; key: string }[] = [
  { roleId: ROLE_MANAGER, key: 'sale.create' },
  { roleId: ROLE_MANAGER, key: 'price.edit' },
  { roleId: ROLE_MANAGER, key: 'settings.manage' },
  { roleId: ROLE_EMPLOYEE, key: 'sale.create' },
];

function makeService(assignments: { branchId: Buffer; roleId: Buffer }[]) {
  const db: any = {
    userBranch: {
      findMany: jest.fn(async ({ where }: any) => {
        return assignments
          .filter((a) => where.branchId === undefined || a.branchId.equals(where.branchId))
          .map((a) => ({ roleId: a.roleId }));
      }),
    },
    rolePermission: {
      findMany: jest.fn(async ({ where }: any) => {
        const roleIds: Buffer[] = where.roleId.in;
        return ROLE_PERMS.filter((p) => roleIds.some((r) => r.equals(p.roleId))).map((p) => ({
          permission: { key: p.key },
        }));
      }),
    },
  };
  return new AccessService(db as never);
}

const both = [
  { branchId: BRANCH_A, roleId: ROLE_MANAGER },
  { branchId: BRANCH_B, roleId: ROLE_EMPLOYEE },
];

describe('AccessService.getEffectivePermissions', () => {
  it('returns every role permission for the branch when a branch is given', async () => {
    const svc = makeService(both);
    const perms = await svc.getEffectivePermissions(USER, BRANCH_A);
    expect(perms).toEqual(new Set(['sale.create', 'price.edit', 'settings.manage']));
  });

  it('scopes to the OTHER branch independently (manager here, employee there)', async () => {
    const svc = makeService(both);
    expect(await svc.getEffectivePermissions(USER, BRANCH_B)).toEqual(new Set(['sale.create']));
  });

  it('without a branch, keeps ONLY company-wide permissions', async () => {
    const svc = makeService(both);
    const perms = await svc.getEffectivePermissions(USER);
    // settings.manage survives; sale.create and price.edit (branch-scoped) do not.
    expect(perms).toEqual(new Set(['settings.manage']));
    expect(perms.has('price.edit')).toBe(false);
    expect(perms.has('sale.create')).toBe(false);
  });

  it('never grants a branch-scoped permission company-wide, even held in one branch', async () => {
    // Manager in A only. Without a branch, price.edit must not appear.
    const svc = makeService([{ branchId: BRANCH_A, roleId: ROLE_MANAGER }]);
    expect((await svc.getEffectivePermissions(USER)).has('price.edit')).toBe(false);
    expect((await svc.getEffectivePermissions(USER, BRANCH_A)).has('price.edit')).toBe(true);
  });

  it('403s for a branch the user is not assigned to', async () => {
    const svc = makeService([{ branchId: BRANCH_A, roleId: ROLE_MANAGER }]);
    await expect(svc.getEffectivePermissions(USER, BRANCH_B)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('grants nothing when the user has no assignments', async () => {
    const svc = makeService([]);
    expect(await svc.getEffectivePermissions(USER)).toEqual(new Set());
  });
});
