import { ReturnsController } from './returns.controller';
import { REQUIRE_PERMISSIONS_KEY } from '../rbac/require-permissions.decorator';
import { isCompanyPermission } from '../rbac/permission-scope';
import { ROLE_PERMISSIONS } from '../../prisma/seed-data/permissions';

/**
 * Who may do what in a return (I2).
 *
 * The legacy endpoint's failure was that one blunt permission covered raising,
 * deciding and refunding. Six narrow keys replace it, and this file pins both
 * halves of that split: which key each route demands, and which role holds it.
 */

const permissionsOn = (handler: unknown): string[] =>
  Reflect.getMetadata(REQUIRE_PERMISSIONS_KEY, handler as object) ?? [];

describe('every route demands exactly one narrow permission', () => {
  const cases: [keyof ReturnsController, string][] = [
    ['list', 'return.view'],
    ['detail', 'return.view'],
    ['create', 'return.request'],
    ['investigate', 'return.review'],
    ['addAdjustment', 'return.review'],
    ['removeAdjustment', 'return.review'],
  ];

  for (const [method, key] of cases) {
    it(`${String(method)} requires ${key}`, () => {
      expect(permissionsOn(ReturnsController.prototype[method])).toEqual([key]);
    });
  }

  /**
   * Custody intake is guarded on `return.request`, not `return.review`, and
   * that is deliberate: the employee who takes the complaint is the one handed
   * the phone. Making them wait for a manager would either stall the customer
   * or produce a record that says the phone arrived later than it did.
   */
  it('custody intake is available to the employee who takes the phone', () => {
    expect(permissionsOn(ReturnsController.prototype.receiveCustody)).toEqual(['return.request']);
  });

  /**
   * `PermissionsGuard` requires ALL listed keys, so adding `cost.view` to any
   * of these would lock the whole workflow for a role that merely cannot see
   * profit — the `transfer.cancel_own` lesson.
   */
  it('no route also demands cost.view', () => {
    for (const [method] of cases) {
      expect(permissionsOn(ReturnsController.prototype[method])).not.toContain('cost.view');
    }
  });
});

describe('every return permission is branch-scoped', () => {
  const KEYS = [
    'return.view',
    'return.request',
    'return.review',
    'return.approve',
    'return.reject',
    'return.exception',
  ];

  /**
   * This is what makes the guard sufficient. A company-wide permission survives
   * the no-branch-header filter, so a caller with no header would keep it and
   * read every branch's returns.
   */
  it('none is in COMPANY_PERMISSIONS', () => {
    for (const key of KEYS) {
      expect(isCompanyPermission(key)).toBe(false);
    }
  });
});

describe('the role matrix splits raising from deciding', () => {
  it('an employee may raise and follow a return, and nothing else', () => {
    const employee = ROLE_PERMISSIONS.store_employee;
    expect(employee).toEqual(expect.arrayContaining(['return.view', 'return.request']));
    for (const key of ['return.review', 'return.approve', 'return.reject', 'return.exception']) {
      expect(employee).not.toContain(key);
    }
  });

  it('a manager runs the workflow but cannot grant an exception', () => {
    const manager = ROLE_PERMISSIONS.store_manager;
    expect(manager).toEqual(
      expect.arrayContaining(['return.view', 'return.request', 'return.review', 'return.approve', 'return.reject']),
    );
    // The whole point of splitting approve from exception: stepping outside the
    // promise the customer was given is the Owner's call.
    expect(manager).not.toContain('return.exception');
  });

  it('the owner holds all six', () => {
    for (const key of ['return.view', 'return.request', 'return.review', 'return.approve', 'return.reject', 'return.exception']) {
      expect(ROLE_PERMISSIONS.owner).toContain(key);
    }
  });

  /**
   * The retired key. It guards no route, and I2 must not have quietly revived
   * it as a shortcut.
   */
  it('nothing depends on the retired sale.return permission', () => {
    const routes = [
      ReturnsController.prototype.list,
      ReturnsController.prototype.detail,
      ReturnsController.prototype.create,
      ReturnsController.prototype.receiveCustody,
      ReturnsController.prototype.investigate,
      ReturnsController.prototype.addAdjustment,
      ReturnsController.prototype.removeAdjustment,
    ];
    for (const route of routes) {
      expect(permissionsOn(route)).not.toContain('sale.return');
    }
  });
});
