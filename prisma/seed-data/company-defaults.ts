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
