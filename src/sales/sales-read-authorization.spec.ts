import { SalesController } from './sales.controller';
import { REQUIRE_PERMISSIONS_KEY } from '../rbac/require-permissions.decorator';
import { isCompanyPermission } from '../rbac/permission-scope';

/**
 * Who may read a sale (I1-CP3).
 *
 * `GET /sales` and `GET /sales/:id` previously carried NO permission decorator
 * at all. `PermissionsGuard` returns `true` immediately for such a route, so
 * every signed-in user could read the company's entire sales history — and,
 * through the detail route, its cost and margin.
 *
 * The check has two halves, and one without the other is worthless:
 *
 *   1. The routes require `sale.view`.
 *   2. `sale.view` is **branch-scoped** — absent from `COMPANY_PERMISSIONS`.
 *      `getEffectivePermissions` refuses a branch the caller is not assigned to,
 *      and when there is no branch header at all it keeps only company-wide
 *      keys. A permission that was company-wide would survive that filter and
 *      hand back every branch's sales to anyone holding it.
 */

const permissionsOn = (handler: unknown): string[] =>
  Reflect.getMetadata(REQUIRE_PERMISSIONS_KEY, handler as object) ?? [];

describe('reading sales requires sale.view', () => {
  it('guards the history list', () => {
    expect(permissionsOn(SalesController.prototype.list)).toEqual(['sale.view']);
  });

  it('guards the sale detail', () => {
    expect(permissionsOn(SalesController.prototype.get)).toEqual(['sale.view']);
  });

  /**
   * `PermissionsGuard` requires ALL listed keys, so adding `cost.view` here
   * would lock the whole screen for an employee instead of hiding two numbers
   * on it. Cost gating is a response filter, not an access decision — the
   * `transfer.cancel_own` lesson, in a different place.
   */
  it('does not also demand cost.view, which would lock out every employee', () => {
    for (const handler of [SalesController.prototype.list, SalesController.prototype.get]) {
      expect(permissionsOn(handler)).not.toContain('cost.view');
    }
  });
});

describe('sale.view is branch-scoped, which is what makes the guard enough', () => {
  it('is not a company-wide permission', () => {
    expect(isCompanyPermission('sale.view')).toBe(false);
  });

  it('neither is the sale-time policy override', () => {
    expect(isCompanyPermission('return.policy.override')).toBe(false);
  });
});

describe('the disabled legacy return is not guarded, because it guards nothing', () => {
  it('carries no permission requirement', () => {
    expect(permissionsOn(SalesController.prototype.legacyReturnDisabled)).toEqual([]);
  });
});
