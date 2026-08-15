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

  it('leaves Owner with full access, now including price.edit', () => {
    // 19 before H1.2, plus the seven transfer keys that replaced the blanket one.
    // 26 → 28 in I1, 28 → 34 in I2, 34 → 36 in I3 (`refund.report`,
    // `refund.confirm`): the six return-workflow keys.
    //
    // 36 → 38 in J1 — `supplier.payment.report` / `.confirm`. These were LATE:
    // migration 0039 granted them and the seed matrix never did, so this count
    // did not move when it should have. Corrected in Milestone B.
    //
    // 38 → 40 in Milestone B — `financial.correction.request` / `.approve`.
    //
    // The Owner holds every permission by construction, so this number moving
    // is the signal that a phase added authority — it should never move by
    // accident, and it moving LATE means a phase shipped a drift.
    expect(ROLE_PERMISSIONS.owner.length).toBe(40);
    expect(has('owner', 'cost.view')).toBe(true);
    expect(has('owner', 'expense.manage')).toBe(true);
    expect(has('owner', 'settings.manage')).toBe(true);
    expect(has('owner', 'price.edit')).toBe(true);
  });

  it('price.edit is Owner-held by role and NOT in any other role baseline', () => {
    // It reaches a Store Manager only through an Owner-created per-branch grant
    // (F1 Stage 2), never by role. Administrator is money-sensitive-excluded.
    expect(has('owner', 'price.edit')).toBe(true);
    expect(has('store_manager', 'price.edit')).toBe(false);
    expect(has('store_employee', 'price.edit')).toBe(false);
    expect(has('administrator', 'price.edit')).toBe(false);
  });
});

describe('Store Employee', () => {
  it('can do the operational job: sell, receive, transfer, add stock', () => {
    expect(has('store_employee', 'sale.create')).toBe(true);
    // The permission whose absence caused the receiving 403.
    expect(has('store_employee', 'purchase.manage')).toBe(true);
    expect(has('store_employee', 'unit.add')).toBe(true);
    // H1.2 split `unit.transfer` apart; the employee keeps the doing, not the
    // deciding.
    expect(has('store_employee', 'transfer.request')).toBe(true);
    expect(has('store_employee', 'transfer.ship')).toBe(true);
    expect(has('store_employee', 'transfer.receive')).toBe(true);
    expect(has('store_employee', 'unit.transfer')).toBe(false);
  });

  it('cannot approve, reject, or cancel somebody else’s transfer', () => {
    /**
     * The H0 audit measured the old behaviour: one permission guarded request,
     * ship, receive and cancel, and every role held it, so an employee assigned
     * to both branches could move stock end to end with nobody else involved.
     * This is the separation of duties that replaced it.
     */
    expect(has('store_employee', 'transfer.approve')).toBe(false);
    expect(has('store_employee', 'transfer.cancel')).toBe(false);
    // They may still withdraw their OWN pending request.
    expect(has('store_employee', 'transfer.cancel_own')).toBe(true);
  });

  it('cannot COMPLETE a return — only a Manager or Owner may', () => {
    // `returnUnit` voids the sale line, restocks the unit and computes a refund.
    // That is final authority, not the request the approved rule describes.
    expect(has('store_employee', 'sale.return')).toBe(false);
  });

  it('cannot activate an import', () => {
    // The approved rule gives the employee preparation only; import.run is
    // reserved for activation.
    expect(has('store_employee', 'import.run')).toBe(false);
  });

  it('cannot sell below cost — the floor is gated on a permission it lacks', () => {
    // discount.apply is safe to hold precisely because the cost floor is
    // enforced independently, on discount.override.
    expect(has('store_employee', 'discount.apply')).toBe(true);
    expect(has('store_employee', 'discount.override')).toBe(false);
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

  it('keeps every legacy ability EXCEPT the two the audit removed', () => {
    // The merge must not quietly drop day-to-day abilities, or a migrated user
    // loses access to their own job. Two are withheld deliberately because
    // their real behaviour is final authority — see the tests above.
    /**
     * `unit.transfer` joins them, for a different reason: the ABILITY is
     * retained, it is just no longer one blanket key. H1.2 replaced it with
     * `transfer.request` / `ship` / `receive` (plus `cancel_own`), which the
     * employee holds — see the split tests above. Nothing was taken away here
     * except the authority to approve and to cancel other people's work.
     */
    const AUDITED_OUT = new Set(['sale.return', 'import.run', 'unit.transfer']);
    const legacy = new Set([
      ...ROLE_PERMISSIONS.sales_employee,
      ...ROLE_PERMISSIONS.warehouse_employee,
    ]);

    for (const perm of legacy) {
      expect(has('store_employee', perm)).toBe(!AUDITED_OUT.has(perm));
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
      'transfer.approve',
      'transfer.ship',
      'transfer.receive',
      'transfer.cancel',
      'closing.perform',
      'report.view',
    ]) {
      expect(has('store_manager', perm)).toBe(true);
    }
  });

  it('cannot sell below cost without explicit Owner delegation', () => {
    // discount.override reads like a discount setting but is the below-cost
    // gate. Every manager holding it permanently would be blanket authority.
    expect(has('store_manager', 'discount.override')).toBe(false);
  });

  it('includes everything a Store Employee can do', () => {
    for (const perm of ROLE_PERMISSIONS.store_employee) {
      expect(has('store_manager', perm)).toBe(true);
    }
  });

  it('holds BOTH cancel keys, because they mean different things', () => {
    /**
     * `transfer.cancel_own` is the route key — without it the guard refuses
     * before the service is ever consulted, and a live run proved a manager
     * could not cancel at all. `transfer.cancel` is the breadth key that lets
     * them cancel somebody else's transfer.
     */
    expect(has('store_manager', 'transfer.cancel_own')).toBe(true);
    expect(has('store_manager', 'transfer.cancel')).toBe(true);
    // The employee has the route key only, which is what confines them.
    expect(has('store_employee', 'transfer.cancel_own')).toBe(true);
    expect(has('store_employee', 'transfer.cancel')).toBe(false);
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

  it('has no permanent price-edit authority — it is Owner-delegated per branch', () => {
    // price.edit exists now (F1 Stage 2) but reaches a Store Manager only through
    // an Owner-created per-branch grant, never as a role baseline.
    expect(has('store_manager', 'price.edit')).toBe(false);
    expect(has('store_employee', 'price.edit')).toBe(false);
    // Only the Owner holds it by role.
    const holders = (Object.keys(ROLE_PERMISSIONS) as (keyof typeof ROLE_PERMISSIONS)[]).filter(
      (role) => ROLE_PERMISSIONS[role].includes('price.edit'),
    );
    expect(holders).toEqual(['owner']);
  });
});

describe('catalog.manage (G1)', () => {
  it('is held by Owner and Store Manager, never by Store Employee', () => {
    // Final catalog administration is a manager decision. An employee may browse
    // the catalog, but must not create or reshape product/category metadata —
    // which they COULD before G1, because creation was guarded by `unit.add`.
    expect(has('owner', 'catalog.manage')).toBe(true);
    expect(has('store_manager', 'catalog.manage')).toBe(true);
    expect(has('store_employee', 'catalog.manage')).toBe(false);
  });

  it('does not drag pricing or any other authority along with it', () => {
    // The whole point of a narrow permission: holding it must not imply money,
    // supplier, expense, report, user or settings authority.
    expect(has('store_manager', 'catalog.manage')).toBe(true);
    for (const perm of [
      'price.edit',
      'discount.override',
      'expense.manage',
      'user.manage',
      'settings.manage',
      'branch.manage',
      'integrations.manage',
    ]) {
      expect(has('store_manager', perm)).toBe(false);
    }
  });

  it('is not money-sensitive, so the Administrator convention keeps it', () => {
    // ADMIN_KEYS excludes only cost/below-cost/price. Catalog metadata is setup
    // work, which is exactly what the internal technical role is for.
    expect(has('administrator', 'catalog.manage')).toBe(true);
    expect(has('administrator', 'price.edit')).toBe(false);
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
