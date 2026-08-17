// Reference data seeded in ALL environments: the 19-permission catalog (R7;
// `price.edit` added in F1 Stage 2) and the role -> permission matrix (D11).

export type RoleKey =
  | 'owner'
  | 'store_manager'
  | 'store_employee'
  | 'administrator'
  | 'branch_manager'
  | 'sales_employee'
  | 'warehouse_employee';

export const PERMISSIONS: { key: string; label: string }[] = [
  { key: 'sale.create',         label: 'Create sales' },
  { key: 'sale.return',         label: 'Process returns' },
  { key: 'sale.view',           label: 'View sales history' },
  { key: 'return.policy.override', label: 'Change the return policy at sale time' },
  // I2 — the reviewed return workflow. Six narrow keys instead of one blunt
  // `sale.return`: raising a complaint, investigating it and deciding it are
  // three different authorities held by three different people.
  { key: 'return.view',         label: 'View returns' },
  { key: 'return.request',      label: 'Raise a return request' },
  { key: 'return.review',       label: 'Investigate and assign responsibility' },
  { key: 'return.approve',      label: 'Approve a return (creates a refund obligation)' },
  { key: 'return.reject',       label: 'Reject a return' },
  { key: 'return.exception',    label: 'Approve outside policy, or against customer damage' },
  // I3 — refund settlement. Reporting and confirming are deliberately separate
  // authorities: the person who says money left the till must not be the person
  // who certifies it.
  { key: 'refund.report',       label: 'Report that a refund was handed to the customer' },
  { key: 'refund.confirm',      label: 'Confirm a refund was actually paid' },
  /**
   * J1 — paying a supplier. These were granted by migration `0039` but never
   * added here, so a freshly SEEDED company could not report or confirm a
   * supplier payment while a MIGRATED one could. The drift test did not catch
   * it because `0039` was missing from its own list of later grants; both are
   * fixed together.
   */
  { key: 'supplier.payment.report',  label: 'Report that a supplier was paid' },
  { key: 'supplier.payment.confirm', label: 'Confirm a supplier payment was actually made' },
  /**
   * Milestone B — correcting a CONFIRMED payment. Two keys, because asking for
   * a correction and authorising one are different authorities: approval is
   * what actually puts money back into a settled liability.
   */
  { key: 'financial.correction.request', label: 'Request a correction to a confirmed payment' },
  { key: 'financial.correction.approve', label: 'Approve a correction to a confirmed payment' },
  { key: 'cost.view',           label: 'View cost & profit' },
  { key: 'discount.apply',      label: 'Apply discounts (within limit)' },
  { key: 'discount.override',   label: 'Override discount limits' },
  { key: 'unit.add',            label: 'Add inventory units' },
  { key: 'unit.transfer',       label: 'Transfer stock between branches' },
  { key: 'import.run',          label: 'Run Excel/CSV inventory import' },
  { key: 'purchase.manage',     label: 'Manage purchases' },
  { key: 'supplier.manage',     label: 'Manage suppliers' },
  /**
   * Milestone D — the split the model could not previously express. The note
   * below used to say so; now it can, so it does.
   */
  { key: 'expense.submit',      label: 'Submit an expense for review' },
  { key: 'expense.review',      label: 'Confirm or reject a submitted expense' },
  { key: 'expense.manage',      label: 'Manage expenses' },
  /**
   * Milestone E — the E0 audit's first finding. `closing.perform` recorded the
   * count AND locked the day, and only Owner and Manager held it, so the
   * Employee actually holding the drawer could not report what was in it
   * without somebody senior standing there. Counting and signing off are now
   * two separate acts with two separate keys.
   */
  { key: 'closing.count',       label: 'Enter an end-of-day count' },
  { key: 'closing.perform',     label: 'Perform & lock daily closing' },
  /**
   * Deliberately NOT folded into `closing.perform`, which a Manager holds.
   * Deciding that a named person owes the business money, or writing that debt
   * off, is the Owner's call and nobody else's.
   */
  { key: 'debt.manage',         label: 'Assign, collect or forgive a cash discrepancy' },
  /**
   * Milestone F. SETTING a target is deciding what the shop is aiming at, so
   * this is Owner and Manager. READING one is deliberately not gated at all —
   * an employee with a personal target must be able to see it, and gating it on
   * `report.view` would hand them the shop's profit reporting at the same time.
   */
  { key: 'goal.manage',         label: 'Set and archive goals' },
  /**
   * Milestone H — inter-store consignment. Narrow keys, because consignment
   * mixes operational acts (hand a phone over, confirm one arrived) with
   * company-level authority (decide who this business trades with, write off
   * money owed). Granting them together would let whoever ships stock also
   * choose the partners.
   */
  { key: 'connection.manage',   label: 'Connect to, block or unblock another store' },
  { key: 'consignment.view',    label: 'See consignments' },
  { key: 'consignment.request', label: 'Propose sending stock on consignment' },
  { key: 'consignment.review',  label: 'Accept, counter or dispute a consignment proposal' },
  { key: 'consignment.custody.send',    label: 'Record handing a consigned phone over' },
  { key: 'consignment.custody.receive', label: 'Confirm physically receiving a consigned phone' },
  { key: 'consignment.sell',    label: 'Sell a phone held on consignment' },
  { key: 'consignment.payment.report',  label: 'Report a consignment payment' },
  { key: 'consignment.payment.confirm', label: 'Confirm a consignment payment arrived' },
  { key: 'consignment.return.confirm',  label: 'Confirm a consigned phone came back' },
  { key: 'consignment.forgive', label: 'Forgive part or all of a consignment balance' },
  /**
   * Milestone I — money loans. A loan is money with no goods attached, so the
   * split follows the money rules rather than the stock rules: reporting a
   * payment is operational, confirming one and writing one off are not.
   */
  { key: 'loan.view',           label: 'See money owed and lent' },
  { key: 'loan.manage',         label: 'Propose, accept, counter or dispute a loan' },
  { key: 'loan.payment.report', label: 'Report a loan payment' },
  { key: 'loan.payment.confirm',label: 'Confirm a loan payment arrived' },
  { key: 'loan.forgive',        label: 'Forgive part or all of a loan' },
  { key: 'report.view',         label: 'View reports' },
  { key: 'branch.manage',       label: 'Manage branches' },
  { key: 'user.manage',         label: 'Manage users' },
  { key: 'settings.manage',     label: 'Manage settings' },
  { key: 'integrations.manage', label: 'Manage integrations (WhatsApp, FCM)' },
  // F1 Stage 2. Owner-held by role; delegatable per branch to a Store Manager
  // (the ONLY delegatable permission — see rbac/permission-scope.ts). It edits
  // normal prices and never authorizes a below-cost sale, which stays gated on
  // `discount.override` (Owner-only, never delegatable).
  { key: 'price.edit',          label: 'Edit item prices' },
  // G1. Final catalog administration: create/edit product + category METADATA.
  // Deliberately NOT price, cost, supplier, expense, report, user or settings
  // authority — and it must never imply `price.edit`.
  { key: 'catalog.manage',      label: 'Manage the product catalog' },

  /**
   * H1.2 — the transfer split.
   *
   * `unit.transfer` used to guard request, ship, receive AND cancel alike, and
   * all three roles held it, so one employee assigned to both branches could
   * move stock end to end with nobody else involved. A workflow with one
   * permission has no separation of duties: it has to be designed in.
   *
   * `transfer.cancel_own` is deliberately its own key rather than a condition
   * layered on `transfer.cancel`. An employee may withdraw a request they made
   * and nothing else; expressing that as "cancel, but only sometimes" is how a
   * later refactor quietly widens it.
   */
  { key: 'transfer.view',       label: 'View stock transfers' },
  { key: 'transfer.request',    label: 'Request a stock transfer' },
  { key: 'transfer.approve',    label: 'Approve or reject a transfer request' },
  { key: 'transfer.ship',       label: 'Ship an approved transfer' },
  { key: 'transfer.receive',    label: 'Receive a transfer at the destination' },
  { key: 'transfer.cancel',     label: 'Cancel any transfer before shipment' },
  { key: 'transfer.cancel_own', label: 'Withdraw your own pending request' },
];

export const ALL_PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

// Money-sensitive permissions — cost visibility, below-cost override, and price
// editing — are NOT granted to the Administrator by default; it is a
// technical/setup role (D11), not a commercial one.
const ADMIN_KEYS = ALL_PERMISSION_KEYS.filter(
  (k) => k !== 'cost.view' && k !== 'discount.override' && k !== 'price.edit',
);

/**
 * Store-facing roles. Authorization is permission-based everywhere — nothing in
 * the codebase compares against a role NAME — so this table is the single
 * definition of what each role can do.
 */
export const ROLE_PERMISSIONS: Record<RoleKey, string[]> = {
  owner: ALL_PERMISSION_KEYS,

  /**
   * Store Manager — the operational and approval baseline, plus cost.
   *
   * Deliberately WITHOUT `expense.manage`: the approved decisions describe a
   * narrower manager, and inventing spend authority from a permission that
   * merely happened to exist would be inventing a business rule.
   *
   * Deliberately WITHOUT `discount.override` either. That permission is not
   * about discounts — `assertBelowCostAllowed` uses it as the gate for SELLING
   * BELOW COST. Granting it to every manager would hand out permanent
   * below-cost authority by default. It becomes an Owner-delegated per-user
   * grant once overrides exist.
   *
   * Price editing has no permission to grant at all; it stays Owner-delegated.
   */
  store_manager: [
    'sale.create', 'sale.return', 'cost.view', 'discount.apply',
    /**
     * I1: reading sale history, and changing the return policy AT SALE TIME.
     * Overriding an EXPIRED deadline after the fact is a different, Owner-only
     * authority and is deliberately not granted here.
     */
    'sale.view', 'return.policy.override',
    /**
     * I2: a manager runs the return workflow end to end — but NOT
     * `return.exception`. Approving outside the window the shop promised, or
     * overriding customer-caused damage, is the Owner's call. That is the whole
     * point of splitting approval from exception.
     */
    'return.view', 'return.request', 'return.review', 'return.approve', 'return.reject',
    // I3: a manager may both report and confirm a refund.
    'refund.report', 'refund.confirm',
    // J1: a manager may both report and confirm a supplier payment.
    'supplier.payment.report', 'supplier.payment.confirm',
    // D: a manager may report what they spent, and never confirm it.
    'expense.submit',
    /**
     * Milestone B: a manager may ASK for a confirmed payment to be corrected,
     * and may never approve one. Approval is Owner-only — it restores a
     * liability that was already settled, which is the most consequential
     * action in the application.
     */
    'financial.correction.request',
    'unit.add', 'import.run',
    // E: a manager may count as well as sign off. `debt.manage` is NOT here —
    // holding a named person responsible for a shortage is the Owner's call.
    // F: a manager sets the targets their branch is working toward.
    'goal.manage',
    /**
     * H: a manager runs consignment end to end operationally — proposing,
     * reviewing, custody both ways, selling and reporting a payment.
     *
     * Deliberately WITHOUT `connection.manage`: choosing which businesses this
     * shop deals with is company-level trust, not branch operation. Deliberately
     * WITHOUT `consignment.forgive` and `consignment.payment.confirm`: writing
     * off money owed, and vouching that money arrived, are Owner calls
     * everywhere else in this system and stay so here.
     */
    'consignment.view', 'consignment.request', 'consignment.review',
    'consignment.custody.send', 'consignment.custody.receive', 'consignment.sell',
    'consignment.payment.report', 'consignment.return.confirm',
    /**
     * I: a manager sees the balances and reports a payment, and decides
     * nothing. Deliberately WITHOUT `loan.manage` — agreeing that this
     * business owes another business money is not a branch decision.
     */
    'loan.view', 'loan.payment.report',
    'purchase.manage', 'supplier.manage', 'closing.count', 'closing.perform', 'report.view',
    // H1.2: the approval authority, branch-scoped like everything else. A
    // manager approves and cancels within the branch they are managing.
    'transfer.view', 'transfer.request', 'transfer.approve',
    'transfer.ship', 'transfer.receive',
    /**
     * BOTH cancel keys, and they mean different things.
     * `transfer.cancel_own` is the ROUTE key — may reach the cancel endpoint at
     * all. `transfer.cancel` is the BREADTH key — may cancel anybody's transfer,
     * not only their own. A manager needs the route key to get in and the
     * breadth key to act broadly; an employee holds only the route key, so the
     * service confines them to their own pending request.
     */
    'transfer.cancel', 'transfer.cancel_own',
    // G1: final catalog administration. Granted by migration 0026 as well as
    // here, and it carries no pricing authority — `price.edit` stays delegated
    // per branch by an Owner.
    'catalog.manage',
  ],

  /**
   * Store Employee — one job, replacing the artificial sales/warehouse split
   * that produced a 403 when the person responsible for receiving tried to
   * receive.
   *
   * Has `cost.view` (an approved decision: employees see product cost and the
   * last selling price) but NOT `report.view` — cost visibility must not drag
   * profit dashboards along with it, which is exactly why they are separate.
   *
   * Three permissions were audited OUT because their real behaviour is final
   * authority, not the operational work the role needs:
   *
   *   sale.return  — `returnUnit` voids the sale line, restocks the unit and
   *                  computes a REFUND. That completes a return; the approved
   *                  rule is that an employee only requests one. Needs a future
   *                  `return.request`.
   *   import.run   — reserved for activating imported inventory. Needs the
   *                  future `import.prepare` / `import.approve` split.
   *   expense.manage — the model cannot express "submit" separately from
   *                  "manage", so the narrower reading wins.
   *
   * `discount.apply` is retained because it cannot bypass the cost floor:
   * below-cost selling is gated independently on `discount.override`, which
   * this role does not have.
   */
  store_employee: [
    'sale.create', 'cost.view', 'discount.apply',
    'unit.add', 'purchase.manage',
    /**
     * J1: the person at the counter who hands the money over is the one who
     * knows it happened, so they REPORT — and never confirm their own payout.
     *
     * Neither correction key is here, deliberately. An employee who reported a
     * payment must not be able to open the process that unwinds it.
     */
    'supplier.payment.report',
    // D: the person who spent the money reports it. Reviewing is the Owner's.
    'expense.submit',
    /**
     * E: the person holding the drawer counts it. That is the whole reason
     * `closing.count` exists — before it, the only closing permission also
     * LOCKED the day, so an employee could not report a count at all.
     *
     * Signing the day off stays with `closing.perform`, which they do not hold.
     */
    'closing.count',
    /**
     * H: the two PHYSICAL acts and nothing else — hand a phone over, confirm
     * one arrived. The same reasoning that gives them `transfer.ship` and
     * `transfer.receive`.
     *
     * Deliberately WITHOUT `consignment.request` or `consignment.review`:
     * agreeing what another business pays us is not an operational act, and
     * "employees can receive ordinary stock" is not a reason to hand them that.
     */
    'consignment.view', 'consignment.custody.send', 'consignment.custody.receive',
    /**
     * H1.2. An employee does the daily stock movement — asks for a transfer,
     * sends it once approved, receives one arriving — but never approves,
     * rejects, or cancels somebody else's request. `transfer.cancel_own` lets
     * them withdraw their own request before a manager has acted on it.
     */
    'transfer.view', 'transfer.request', 'transfer.ship',
    'transfer.receive', 'transfer.cancel_own',
    // I1: an employee may browse the branch's own sale history. Deliberately
    // NOT `report.view` — seeing what was sold is not seeing profit — and NOT
    // `return.policy.override`, which is authority rather than operation.
    'sale.view',
    /**
     * I2: the person who takes the complaint at the counter records it and can
     * follow it. Deciding it is somebody else's job, deliberately — an employee
     * holds neither review, approve, reject nor exception.
     */
    'return.view', 'return.request',
    // I3: an employee reports the payout. Confirming it is somebody else's job,
    // which is the whole reason the settlement has two steps.
    'refund.report'
  ],

  administrator: ADMIN_KEYS,
  branch_manager: [
    'sale.create', 'sale.return', 'cost.view', 'discount.apply',
    'discount.override', 'unit.add', 'unit.transfer', 'import.run',
    'purchase.manage', 'supplier.manage', 'expense.manage',
    'closing.perform', 'report.view',
  ],
  sales_employee: ['sale.create', 'sale.return', 'discount.apply', 'unit.add'],
  warehouse_employee: ['unit.add', 'unit.transfer', 'import.run'],
};

/** Only these three are shown in store-facing onboarding. */
export const STORE_FACING_ROLES: RoleKey[] = ['owner', 'store_manager', 'store_employee'];

export const ROLE_LABELS: Record<RoleKey, string> = {
  owner: 'Owner',
  store_manager: 'Store Manager',
  store_employee: 'Store Employee',
  administrator: 'Administrator',
  branch_manager: 'Branch Manager',
  sales_employee: 'Sales Employee',
  warehouse_employee: 'Warehouse Employee',
};

// Default company/branch settings (R6) — sensible defaults, tunable later.
export const DEFAULT_SETTINGS: { key: string; value: unknown }[] = [
  { key: 'low_stock_threshold', value: 3 },
  { key: 'dead_stock_days', value: 60 },
  { key: 'discount_monitoring_enabled', value: false },
  { key: 'discount_limits_by_role', value: { sales_employee: 5, branch_manager: 15 } },
  {
    key: 'health_score_weights',
    value: {
      profit_trend: 0.25, cash_flow: 0.15, stock_coverage: 0.2,
      overdue_debts: 0.15, dead_stock: 0.1, velocity: 0.15,
    },
  },
  { key: 'invoice_no_format', value: '{branch}-{seq:00000}' },
  // `whatsapp_schedule` was removed in 0019. Owner-facing WhatsApp preferences
  // are typed columns on `company_settings` now; keeping a second, unvalidated
  // copy here would give "is the summary on?" two different answers.
];
