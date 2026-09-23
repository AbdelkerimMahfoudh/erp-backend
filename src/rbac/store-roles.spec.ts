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
    // 40 → 42 in Milestone D — `expense.submit` / `expense.review`. The split
    // the seed comment above used to say the model could not express.
    // `expense.manage` is unchanged and still Owner-only.
    //
    // 42 → 44 in Milestone E — `closing.count` and `debt.manage`. The first is
    // the E0 audit's finding: `closing.perform` both recorded the count and
    // locked the day, so an Employee could not report a count at all. The
    // second is deliberately NOT part of `closing.perform`, which a Manager
    // holds — deciding a named person owes the business money is Owner-only.
    //
    // 44 → 45 in Milestone F — `goal.manage`. One key, not two, because READING
    // a goal is deliberately ungated: an employee with a personal target must
    // be able to see it, and `report.view` would hand them the shop's profit
    // reporting at the same time.
    //
    // 45 → 56 in Milestone H — eleven consignment keys. Narrow on purpose:
    // consignment mixes operational acts (hand a phone over) with company-level
    // authority (choose a partner, write off a debt), and one broad key would
    // let whoever ships stock also decide who the business trades with.
    //
    // 56 → 61 in Milestone I — five loan keys. An Employee gets NONE of them:
    // a loan can be against an employee, and showing them the ledger would show
    // them their colleagues' debts.
    //
    // The Owner holds every permission by construction, so this number moving
    // is the signal that a phase added authority — it should never move by
    // accident, and it moving LATE means a phase shipped a drift.
    // 61 → 62 in 4a — `customer.manage`.
    // 62 → 63 in 0076 — `closing.start_early`.
    expect(ROLE_PERMISSIONS.owner.length).toBe(63);
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

  it('may SUBMIT an expense, and neither review nor manage one', () => {
    /**
     * This comment used to say the model could not distinguish "submit an
     * expense" from "manage expenses", so the narrower reading won. Milestone D
     * made the model able to express it, so the employee gains exactly the
     * narrow half: they report what they spent.
     *
     * Submitting does NOT reveal the shop's other expenses — the list scopes a
     * submitter to their own rows. Reviewing stays Owner-only.
     */
    expect(has('store_employee', 'expense.submit')).toBe(true);
    expect(has('store_employee', 'expense.review')).toBe(false);
    expect(has('store_employee', 'expense.manage')).toBe(false);
  });

  it('may COUNT the drawer and may not sign the day off', () => {
    /**
     * The E0 audit's first finding, pinned. `closing.perform` recorded the
     * count AND locked the day, and the employee held neither — so the person
     * physically holding the drawer could not report what was in it without
     * somebody senior standing there.
     *
     * If these two ever end up in the same permission again, the employee
     * either loses the ability to count or gains the authority to close.
     */
    expect(has('store_employee', 'closing.count')).toBe(true);
    expect(has('store_employee', 'closing.perform')).toBe(false);
  });

  it('may HANDLE a consigned phone and never AGREE what it is worth', () => {
    /**
     * Milestone H's permission decision, pinned. Handing a phone over and
     * confirming one arrived are physical acts — the same reasoning that gives
     * an employee `transfer.ship` and `transfer.receive`.
     *
     * Agreeing what another business pays us is not an operational act, and
     * "employees can receive ordinary stock" is not a reason to hand them that.
     */
    expect(has('store_employee', 'consignment.custody.send')).toBe(true);
    expect(has('store_employee', 'consignment.custody.receive')).toBe(true);
    expect(has('store_employee', 'consignment.request')).toBe(false);
    expect(has('store_employee', 'consignment.review')).toBe(false);
    expect(has('store_employee', 'consignment.sell')).toBe(false);
  });

  it('is never able to decide who owes the shop money', () => {
    // Being the person a shortage is attributed to and being the person who
    // decides that attribution must never be the same permission.
    expect(has('store_employee', 'debt.manage')).toBe(false);
    expect(has('store_manager', 'debt.manage')).toBe(false);
    expect(has('owner', 'debt.manage')).toBe(true);
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
      'report.view',
    ]) {
      expect(has('store_manager', perm)).toBe(true);
    }
  });

  it('signs the day off only as one of the Owner’s two named delegates (0076)', () => {
    // Counting stays; closing, reopening and reclosing arrive per branch, per
    // assignment, by an explicit Owner grant — never from the base role.
    expect(has('store_manager', 'closing.count')).toBe(true);
    expect(has('store_manager', 'closing.perform')).toBe(false);
    expect(has('store_manager', 'closing.start_early')).toBe(false);
    expect(has('store_employee', 'closing.start_early')).toBe(false);
    expect(has('owner', 'closing.start_early')).toBe(true);
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

describe('inter-store trust is company-level, not branch-level (Milestone H)', () => {
  it('only the Owner decides which businesses this shop deals with', () => {
    /**
     * `connection.manage` covers connecting to, blocking and unblocking another
     * company. A Store Manager runs the branch; choosing the partners is not a
     * branch decision, and a manager who could block a store could also cut off
     * a creditor.
     */
    expect(has('owner', 'connection.manage')).toBe(true);
    expect(has('store_manager', 'connection.manage')).toBe(false);
    expect(has('store_employee', 'connection.manage')).toBe(false);
  });

  it('only the Owner forgives money owed, or vouches that it arrived', () => {
    /**
     * The same split every other money workflow uses. A manager may REPORT a
     * payment; confirming one and writing one off are the Owner's.
     */
    expect(has('owner', 'consignment.forgive')).toBe(true);
    expect(has('store_manager', 'consignment.forgive')).toBe(false);

    expect(has('owner', 'consignment.payment.confirm')).toBe(true);
    expect(has('store_manager', 'consignment.payment.confirm')).toBe(false);
    expect(has('store_manager', 'consignment.payment.report')).toBe(true);
  });

  it('a manager runs the operational half end to end', () => {
    for (const perm of [
      'consignment.request',
      'consignment.review',
      'consignment.custody.send',
      'consignment.custody.receive',
      'consignment.sell',
      'consignment.return.confirm',
    ]) {
      expect(has('store_manager', perm)).toBe(true);
    }
  });
});

describe('money owed is not an employee matter (Milestone I)', () => {
  it('gives a Store Employee no loan permission at all', () => {
    /**
     * A loan can be against an EMPLOYEE — `counterparties` carries an
     * `employee` kind for exactly that. Giving employees the loan list would
     * show them their colleagues' debts, which is a privacy failure dressed up
     * as a feature.
     */
    for (const perm of [
      'loan.view',
      'loan.manage',
      'loan.payment.report',
      'loan.payment.confirm',
      'loan.forgive',
    ]) {
      expect(has('store_employee', perm)).toBe(false);
    }
  });

  it('lets a Manager see balances and report a payment, and decide nothing', () => {
    expect(has('store_manager', 'loan.view')).toBe(true);
    expect(has('store_manager', 'loan.payment.report')).toBe(true);

    // Agreeing that this business owes another business money is not a branch
    // decision, and confirming or forgiving are Owner calls everywhere else.
    expect(has('store_manager', 'loan.manage')).toBe(false);
    expect(has('store_manager', 'loan.payment.confirm')).toBe(false);
    expect(has('store_manager', 'loan.forgive')).toBe(false);
  });
});
