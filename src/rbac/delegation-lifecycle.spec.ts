import { AccessService } from './access.service';
import { pruneGrantsForRole, roleKeepsDelegatedGrants } from './delegation-lifecycle';
import { newUuidV7Bin } from '../common/utils/uuid.util';

/**
 * The downgrade → re-promotion invariant.
 *
 * A `price.edit` grant is an Owner's decision about a particular person doing a
 * particular job in a particular branch. If that person stops being the Store
 * Manager there, the decision has lapsed — and promoting them again months
 * later must not quietly resurrect it. Only a fresh Owner grant may.
 *
 * Two independent mechanisms enforce this, and both are tested here because
 * either one alone leaves a hole:
 *
 *  1. **Resolution** ignores a grant on a non-manager assignment. This makes a
 *     downgrade take effect instantly — but the row survives, so on its own it
 *     would let a re-promotion revive the grant.
 *  2. **Pruning** deletes the grants when the role changes away from manager,
 *     in the same transaction as the role change. This is what makes the lapse
 *     permanent.
 */

const USER = newUuidV7Bin();
const BRANCH_A = newUuidV7Bin();
const UB_A = newUuidV7Bin();
const ROLE_MANAGER = newUuidV7Bin();
const ROLE_EMPLOYEE = newUuidV7Bin();

describe('roleKeepsDelegatedGrants', () => {
  it('only a Store Manager may hold delegated grants', () => {
    expect(roleKeepsDelegatedGrants('store_manager')).toBe(true);
    for (const role of ['owner', 'store_employee', 'administrator', 'branch_manager']) {
      expect(roleKeepsDelegatedGrants(role)).toBe(false);
    }
  });

  it('the Owner is not an exception — they hold price.edit by ROLE, not by grant', () => {
    // Keeping a grant row on an Owner assignment would be dead state that
    // outlives any later change to the Owner's own permissions.
    expect(roleKeepsDelegatedGrants('owner')).toBe(false);
  });
});

describe('pruneGrantsForRole', () => {
  function client(count = 1) {
    const deleteMany = jest.fn(async () => ({ count }));
    return { client: { userBranchPermission: { deleteMany } }, deleteMany };
  }

  it('deletes the assignment grants when the role can no longer hold them', async () => {
    const { client: c, deleteMany } = client(1);

    const removed = await pruneGrantsForRole(c, UB_A, 'store_employee');

    expect(removed).toBe(1);
    expect(deleteMany).toHaveBeenCalledWith({ where: { userBranchId: UB_A } });
  });

  it('leaves a manager assignment alone — and does not even query', async () => {
    const { client: c, deleteMany } = client();

    expect(await pruneGrantsForRole(c, UB_A, 'store_manager')).toBe(0);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('is safe to call when there is nothing to prune', async () => {
    const { client: c } = client(0);
    expect(await pruneGrantsForRole(c, UB_A, 'store_employee')).toBe(0);
  });

  it('scopes the delete to ONE assignment, never the whole user', async () => {
    // A person may manage branch A and be an employee in branch B. Losing the
    // grant in B must not touch the one they legitimately hold in A.
    const { client: c, deleteMany } = client(1);

    await pruneGrantsForRole(c, UB_A, 'store_employee');

    const [[args]] = deleteMany.mock.calls as unknown as [[{ where: Record<string, unknown> }]];
    expect(Object.keys(args.where)).toEqual(['userBranchId']);
  });
});

describe('downgrade → re-promotion cannot revive a grant', () => {
  /** Resolver harness: role and grants are both mutable, like real life. */
  function makeService(state: { roleId: Buffer; roleKey: string; grants: string[] }) {
    const db: any = {
      userBranch: {
        findMany: jest.fn(async () => [
          { id: UB_A, roleId: state.roleId, role: { key: state.roleKey } },
        ]),
      },
      rolePermission: {
        findMany: jest.fn(async () => [{ permission: { key: 'sale.create' } }]),
      },
      userBranchPermission: {
        findMany: jest.fn(async () => state.grants.map((key) => ({ permission: { key } }))),
        deleteMany: jest.fn(async () => {
          const count = state.grants.length;
          state.grants = [];
          return { count };
        }),
      },
    };
    return { svc: new AccessService(db as never), db };
  }

  it('the full cycle: granted → downgraded → promoted again → still no price.edit', async () => {
    const state = { roleId: ROLE_MANAGER, roleKey: 'store_manager', grants: ['price.edit'] };
    const { svc, db } = makeService(state);

    // 1. Manager with the grant: has it.
    expect((await svc.getEffectivePermissions(USER, BRANCH_A)).has('price.edit')).toBe(true);

    // 2. Downgraded to employee — the role change prunes, as the CLI and any
    //    future role API must, inside the same transaction.
    state.roleId = ROLE_EMPLOYEE;
    state.roleKey = 'store_employee';
    await pruneGrantsForRole(db, UB_A, state.roleKey);
    expect((await svc.getEffectivePermissions(USER, BRANCH_A)).has('price.edit')).toBe(false);

    // 3. Promoted back to Store Manager. Same person, same assignment, same
    //    branch — and still no price.edit, because the grant is gone.
    state.roleId = ROLE_MANAGER;
    state.roleKey = 'store_manager';
    expect((await svc.getEffectivePermissions(USER, BRANCH_A)).has('price.edit')).toBe(false);

    // 4. Only a fresh Owner decision restores it.
    state.grants = ['price.edit'];
    expect((await svc.getEffectivePermissions(USER, BRANCH_A)).has('price.edit')).toBe(true);
  });

  it('even if pruning were skipped, resolution alone blocks the downgraded state', async () => {
    // Defence in depth: this is what protects a database where a grant row was
    // left behind by some path that forgot to prune.
    const state = { roleId: ROLE_EMPLOYEE, roleKey: 'store_employee', grants: ['price.edit'] };
    const { svc } = makeService(state);

    expect((await svc.getEffectivePermissions(USER, BRANCH_A)).has('price.edit')).toBe(false);
  });

  it('a stale row DOES revive on re-promotion if pruning is skipped — which is why it is not optional', async () => {
    // The failure this invariant exists to prevent, demonstrated. Resolution
    // cannot see the difference between a fresh grant and a stale one; only
    // deleting at role-change time can.
    const state = { roleId: ROLE_EMPLOYEE, roleKey: 'store_employee', grants: ['price.edit'] };
    const { svc } = makeService(state);
    expect((await svc.getEffectivePermissions(USER, BRANCH_A)).has('price.edit')).toBe(false);

    state.roleId = ROLE_MANAGER;
    state.roleKey = 'store_manager';

    expect((await svc.getEffectivePermissions(USER, BRANCH_A)).has('price.edit')).toBe(true);
  });
});
