/**
 * A day's net figures as a SQL expression over a `daily_rollups` row. Goals, which used this in production, are dormant
 * (D227); the reporting specs keep it as an independent cross-check of the rollup's columns.
 */

export const ADJUSTMENT: Readonly<Record<GoalMetricKey, string>> = {
  gross_profit: '(`cancelled_revenue` - `cancelled_cogs`) + `returns_gross_profit`',
  revenue: '`cancelled_revenue` + (`returns_revenue` - `returns_adjustments`)',
  sales_count: '`cancelled_count`',
  units_sold: '`cancelled_qty` + `returns_count`',
};

/**
 * Which rollup column each metric reads.
 *
 * The single mapping, in one place. `daily_rollups` already accounts for
 * returns, so a goal and the day's analytics cannot disagree about the same
 * period — which is the drift Milestone E spent a whole checkpoint pinning shut
 * for the reconciliation equation.
 */
export const METRIC_COLUMN = {
  gross_profit: 'gross_profit',
  revenue: 'revenue',
  sales_count: 'sales_count',
  units_sold: 'qty_sold',
} as const;

export type GoalMetricKey = keyof typeof METRIC_COLUMN;

/** Whether a metric counts money, so a screen knows to format it as such. */
