import { ROLE_PERMISSIONS, ROLE_LABELS, STORE_FACING_ROLES, type RoleKey } from '../../prisma/seed-data/permissions';

/**
 * The store-facing role matrix (0016).
 *
 * `sales_employee` and `warehouse_employee` split one real job, and that split
 * is what produced the 403 where the person responsible for receiving
 * merchandise could not call the purchase endpoint. They are now one
 * `store_employee`.
 *
 * These assert the *decisions*, not the implementation: which permissions a
 * role does and does not carry. Authorization is permission-based everywhere —
 * nothing compares a role NAME — so this table is the whole contract.
 */

const has = (role: RoleKey, perm: string) => ROLE_PERMISSIONS[role].includes(perm);

describe('store-facing roles', () => {
  it('offers exactly Owner, Store Manager and Store Employee', () => {
    expect(STORE_FACING_ROLES).toEqual(['owner', 'store_manager', 'store_employee']);
    // The internal SaaS role must never appear in store onboarding.
    expect(STORE_FACING_ROLES).not.toContain('administrator');
  });

  it('labels every store-facing role', () => {
    for (const role of STORE_FACING_ROLES) {
      expect(ROLE_LABELS[role]).toBeTruthy();
    }
    expect(ROLE_LABELS.store_manager).toBe('Store Manager');
    expect(ROLE_LABELS.store_employee).toBe('Store Employee');
  });

  it('leaves Owner untouched with full access', () => {
    expect(ROLE_PERMISSIONS.owner.length).toBe(17);
    expect(has('owner', 'cost.view')).toBe(true);
    expect(has('owner', 'expense.manage')).toBe(true);
    expect(has('owner', 'settings.manage')).toBe(true);
  });
});

describe('Store Employee', () => {
  it('can do the operational job: sell, receive, transfer, add stock', () => {
    expect(has('store_employee', 'sale.create')).toBe(true);
    expect(has('store_employee', 'sale.return')).toBe(true);
    // The permission whose absence caused the receiving 403.
    expect(has('store_employee', 'purchase.manage')).toBe(true);
    expect(has('store_employee', 'unit.add')).toBe(true);
    expect(has('store_employee', 'unit.transfer')).toBe(true);
  });

  it('sees cost — an approved decision', () => {
    expect(has('store_employee', 'cost.view')).toBe(true);
  });

  it('sees cost WITHOUT gaining profit reporting', () => {
    // The whole point of keeping these separate: cost visibility must not drag
    // dashboards along with it.
    expect(has('store_employee', 'cost.view')).toBe(true);
    expect(has('store_employee', 'report.view')).toBe(false);
  });

  it('has no expense authority', () => {
    // The model cannot yet distinguish "submit an expense" from "manage
    // expenses", so the narrower reading wins. See docs/21.
    expect(has('store_employee', 'expense.manage')).toBe(false);
  });

  it('has no administrative or approval authority', () => {
    for (const perm of [
      'user.manage',
      'settings.manage',
      'branch.manage',
      'integrations.manage',
      'discount.override',
      'closing.perform',
    ]) {
      expect(has('store_employee', perm)).toBe(false);
    }
  });

  it('covers everything both legacy employee roles could do', () => {
    // The merge must not quietly remove an ability either role already had,
    // or a migrated user would lose access to their own job.
    const legacy = new Set([
      ...ROLE_PERMISSIONS.sales_employee,
      ...ROLE_PERMISSIONS.warehouse_employee,
    ]);
    for (const perm of legacy) {
      expect(has('store_employee', perm)).toBe(true);
    }
  });
});

describe('Store Manager', () => {
  it('has the operational and approval baseline plus cost', () => {
    for (const perm of [
      'sale.create',
      'sale.return',
      'cost.view',
      'purchase.manage',
      'supplier.manage',
      'unit.transfer',
      'closing.perform',
      'report.view',
      'discount.override',
    ]) {
      expect(has('store_manager', perm)).toBe(true);
    }
  });

  it('includes everything a Store Employee can do', () => {
    for (const perm of ROLE_PERMISSIONS.store_employee) {
      expect(has('store_manager', perm)).toBe(true);
    }
  });

  it('has no expense authority — narrower than the old branch_manager', () => {
    // branch_manager carried expense.manage. The approved decisions describe a
    // narrower manager, and inheriting a power merely because it existed would
    // be inventing a business rule.
    expect(ROLE_PERMISSIONS.branch_manager).toContain('expense.manage');
    expect(has('store_manager', 'expense.manage')).toBe(false);
  });

  it('has no platform or security administration', () => {
    for (const perm of ['user.manage', 'settings.manage', 'branch.manage', 'integrations.manage']) {
      expect(has('store_manager', perm)).toBe(false);
    }
  });

  it('has no permanent price-edit authority', () => {
    // There is no price-edit permission to grant: editing stays Owner-delegated
    // and is blocked on per-user overrides, which do not exist yet.
    const all = new Set(Object.values(ROLE_PERMISSIONS).flat());
    expect([...all].some((p) => p.includes('price'))).toBe(false);
  });
});

describe('legacy roles', () => {
  it('are still defined so existing rows stay valid', () => {
    // Retiring them is a separate migration, safe only once nothing references
    // them AND the seed no longer writes them.
    expect(ROLE_PERMISSIONS.sales_employee).toBeDefined();
    expect(ROLE_PERMISSIONS.warehouse_employee).toBeDefined();
    expect(ROLE_PERMISSIONS.branch_manager).toBeDefined();
    expect(ROLE_PERMISSIONS.administrator).toBeDefined();
  });

  it('are not offered anywhere store-facing', () => {
    for (const legacy of ['sales_employee', 'warehouse_employee', 'branch_manager', 'administrator']) {
      expect(STORE_FACING_ROLES).not.toContain(legacy);
    }
  });
});
