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
  { key: 'cost.view',           label: 'View cost & profit' },
  { key: 'discount.apply',      label: 'Apply discounts (within limit)' },
  { key: 'discount.override',   label: 'Override discount limits' },
  { key: 'unit.add',            label: 'Add inventory units' },
  { key: 'unit.transfer',       label: 'Transfer stock between branches' },
  { key: 'import.run',          label: 'Run Excel/CSV inventory import' },
  { key: 'purchase.manage',     label: 'Manage purchases' },
  { key: 'supplier.manage',     label: 'Manage suppliers' },
  { key: 'expense.manage',      label: 'Manage expenses' },
  { key: 'closing.perform',     label: 'Perform & lock daily closing' },
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
    'unit.add', 'import.run',
    'purchase.manage', 'supplier.manage', 'closing.perform', 'report.view',
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
     * H1.2. An employee does the daily stock movement — asks for a transfer,
     * sends it once approved, receives one arriving — but never approves,
     * rejects, or cancels somebody else's request. `transfer.cancel_own` lets
     * them withdraw their own request before a manager has acted on it.
     */
    'transfer.view', 'transfer.request', 'transfer.ship',
    'transfer.receive', 'transfer.cancel_own',
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
