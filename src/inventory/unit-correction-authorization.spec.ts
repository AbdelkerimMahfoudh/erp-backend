import { InventoryController } from './inventory.controller';
import { REQUIRE_PERMISSIONS_KEY } from '../rbac/require-permissions.decorator';
import { isCompanyPermission } from '../rbac/permission-scope';

/**
 * Who may correct a unit.
 *
 * `PATCH /units/:id` mutates inventory, so it carries `unit.add` — the same
 * branch-scoped key that receives stock and marks a unit faulty. Guarding it
 * with a weaker or company-wide key would let a caller correct stock in a branch
 * they are not assigned to. Correcting the COST additionally needs `cost.view`,
 * but that is a field-level gate enforced inside the service, not a route gate:
 * adding it here would lock the whole correction for someone who may fix an IMEI
 * but not see cost — the same lesson as sale reads.
 */

const permissionsOn = (handler: unknown): string[] =>
  Reflect.getMetadata(REQUIRE_PERMISSIONS_KEY, handler as object) ?? [];

describe('correcting a unit requires unit.add', () => {
  it('guards the correction route', () => {
    expect(permissionsOn(InventoryController.prototype.correct)).toEqual(['unit.add']);
  });

  it('unit.add is branch-scoped, so it cannot be exercised on an unassigned branch', () => {
    expect(isCompanyPermission('unit.add')).toBe(false);
  });

  it('does not put cost.view on the route (it is a field gate, not an access gate)', () => {
    expect(permissionsOn(InventoryController.prototype.correct)).not.toContain('cost.view');
  });
});
