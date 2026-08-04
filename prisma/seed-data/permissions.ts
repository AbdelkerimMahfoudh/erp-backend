// Reference data seeded in ALL environments: the 17-permission catalog (R7)
// and the role -> permission matrix for the five roles (D11).

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
];

export const ALL_PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

// Money visibility (`cost.view`) and `discount.override` are NOT granted to the
// Administrator by default — it is a technical/setup role (D11).
const ADMIN_KEYS = ALL_PERMISSION_KEYS.filter(
  (k) => k !== 'cost.view' && k !== 'discount.override',
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
    'unit.add', 'unit.transfer', 'import.run',
    'purchase.manage', 'supplier.manage', 'closing.perform', 'report.view',
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
    'unit.add', 'unit.transfer', 'purchase.manage',
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
  { key: 'whatsapp_schedule', value: { enabled: false, time: '21:00' } },
];
