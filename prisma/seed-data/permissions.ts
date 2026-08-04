// Reference data seeded in ALL environments: the 17-permission catalog (R7)
// and the role -> permission matrix for the five roles (D11).

export type RoleKey =
  | 'owner'
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

export const ROLE_PERMISSIONS: Record<RoleKey, string[]> = {
  owner: ALL_PERMISSION_KEYS,
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

export const ROLE_LABELS: Record<RoleKey, string> = {
  owner: 'Owner',
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
