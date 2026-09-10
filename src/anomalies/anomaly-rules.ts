import { Warning, WarningCode, WarningSeverity, messageKeyFor } from '../common/warnings/warning.types';

/**
 * The six deterministic anomaly rules (A3), as pure functions.
 *
 * ## The six, by name
 *
 * 1. `anomaly.low_stock` — stock about to run out, with how many days are left
 * 2. `anomaly.dead_stock` — stock that has not sold for the shop's own window
 * 3. `anomaly.overdue_debt` — customers past their due date
 * 4. `anomaly.seller_margin_drop` — one seller's margin halved *(Owner only)*
 * 5. `anomaly.cash_shortfall` — the drawer short repeatedly
 * 6. `anomaly.below_cost_cluster` — one seller selling below cost repeatedly *(Owner only)*
 *
 * There is no seventh, no score, no model and no external service. Every rule
 * is a comparison a shopkeeper could do on paper, and its warning carries the
 * numbers that produced it so the sentence is checkable.
 *
 * ## What these functions are NOT allowed to do
 *
 * **They never compute a metric.** Every input is a figure the app already
 * shows — a rollup, a valuation, a velocity row, a ledger balance, a closing
 * discrepancy. Anomaly detection becoming a second definition of profit, cost,
 * expected cash or stock is the failure this whole feature has to avoid, so
 * the arithmetic here is limited to dividing, comparing and counting what it
 * was handed.
 *
 * **They never block anything.** No anomaly refuses a sale, an intake or a
 * closing. They are read on a screen.
 *
 * ## Minimum samples
 *
 * Every rule that compares against history states its minimum, and below it
 * says nothing. Three closings is a pattern; one is a bad evening. Twenty
 * sales is a seller's normal; four is a quiet week. Without a floor, the rules
 * would fire loudest at the smallest shops, which is the opposite of useful.
 */

/** Five sales in the window before a rate of sale means anything. */
export const LOW_STOCK_MIN_SALES = 5;
/** How far ahead the low-stock rule looks. */
export const LOW_STOCK_DAYS_LEFT = 7;
/** Twenty sales in each window before two margins are comparable. */
export const MARGIN_MIN_SALES = 20;
/** Collapse means halved. Not a tuned constant — a plain, sayable threshold. */
export const MARGIN_COLLAPSE_RATIO = 0.5;
/** Three shortfalls in the window is a pattern; one is a bad evening. */
export const SHORTFALL_MIN_COUNT = 3;
/** Three below-cost sales by one person in the window. */
export const BELOW_COST_MIN_COUNT = 3;
/** Every "recent" window in these rules. */
export const ANOMALY_WINDOW_DAYS = 30;

/** An anomaly is a warning that can be dismissed, so it carries an identity. */
export interface Anomaly extends Warning {
  key: string;
}

/**
 * Build one anomaly.
 *
 * `subject` is what the anomaly is *about* — a product, a person — and becomes
 * part of the key so dismissing one product's low stock does not silence every
 * other product's.
 */
function anomaly(
  code: WarningCode,
  severity: WarningSeverity,
  params: Record<string, string | number>,
  subject?: string,
): Anomaly {
  return {
    key: subject ? `${code}:${subject}` : code,
    code,
    severity,
    messageKey: messageKeyFor(code),
    params,
    // An anomaly is about the shop, not about a field somebody typed.
    field: null,
    submitted: null,
    reference: null,
  };
}

// ── 1. Low stock, with days left ───────────────────────────────────────────

export interface LowStockInput {
  productId: string;
  label: string;
  inStock: number;
  /** Units sold in the window. The velocity row's own count. */
  soldInWindow: number;
}

/**
 * Running out, and roughly when.
 *
 * "Three left" is a number; "three left, about two days" is a decision. The
 * rate is units sold in the window divided by the window — the same figure the
 * dashboard's velocity row already holds — and below five sales there is no
 * rate worth quoting, so nothing is said.
 */
export function lowStockAnomalies(rows: readonly LowStockInput[]): Anomaly[] {
  const out: Anomaly[] = [];
  for (const row of rows) {
    if (row.soldInWindow < LOW_STOCK_MIN_SALES) continue;
    if (row.inStock <= 0) continue;
    const perDay = row.soldInWindow / ANOMALY_WINDOW_DAYS;
    const daysLeft = Math.floor(row.inStock / perDay);
    if (daysLeft > LOW_STOCK_DAYS_LEFT) continue;
    out.push(
      anomaly('anomaly.low_stock', 'info', { product: row.label, inStock: row.inStock, days: daysLeft }, row.productId),
    );
  }
  return out;
}

// ── 2. Dead stock ──────────────────────────────────────────────────────────

export interface DeadStockInput {
  productId: string;
  label: string;
  inStock: number;
  /** The shop's own `dead_stock_days` setting, already resolved. */
  days: number;
}

/**
 * Money sitting on a shelf.
 *
 * The window is the shop's own `dead_stock_days` setting, not a number chosen
 * here, and the list is the one `DashboardService.deadStock` already produces.
 * **No value travels**: what the shop paid for the stock is cost, and an
 * anomaly is read by whoever picks the phone up.
 */
export function deadStockAnomalies(rows: readonly DeadStockInput[]): Anomaly[] {
  return rows
    .filter((row) => row.inStock > 0)
    .map((row) =>
      anomaly('anomaly.dead_stock', 'info', { product: row.label, days: row.days }, row.productId),
    );
}

// ── 3. Overdue debt ────────────────────────────────────────────────────────

export interface OverdueDebtInput {
  count: number;
  amount: number;
}

/**
 * Customers past their due date.
 *
 * The definition is the app's existing one — a sale with a balance still owed
 * and a due date in the past, which is exactly what the health score's
 * `overdueDebts` component measures. A second definition of "overdue" is how
 * two screens end up disagreeing about who owes what.
 */
export function overdueDebtAnomalies(input: OverdueDebtInput): Anomaly[] {
  if (input.count <= 0) return [];
  return [
    anomaly('anomaly.overdue_debt', 'caution', { count: input.count, amount: round2(input.amount) }),
  ];
}

// ── 4. Seller margin collapse (Owner only) ────────────────────────────────

export interface SellerMarginInput {
  userId: string;
  name: string;
  current: { sales: number; revenue: number; margin: number };
  previous: { sales: number; revenue: number; margin: number };
}

/**
 * One person's margin has halved.
 *
 * Compared as a **rate**, margin over revenue, not as an amount: a seller
 * having a quieter month is not a collapse, and an amount would call it one.
 * Both windows need twenty sales, because two averages built from four sales
 * each are two coincidences.
 *
 * Owner-only, and gated on `cost.view` as well. A manager reading a
 * colleague's margin is a personnel problem the app should not create.
 */
export function sellerMarginAnomalies(rows: readonly SellerMarginInput[]): Anomaly[] {
  const out: Anomaly[] = [];
  for (const row of rows) {
    if (row.current.sales < MARGIN_MIN_SALES || row.previous.sales < MARGIN_MIN_SALES) continue;
    if (!(row.previous.revenue > 0) || !(row.current.revenue > 0)) continue;

    const before = row.previous.margin / row.previous.revenue;
    const after = row.current.margin / row.current.revenue;
    // A previously loss-making seller cannot "collapse" — there is nothing to
    // halve, and the comparison would report noise as news.
    if (before <= 0) continue;
    if (after > before * MARGIN_COLLAPSE_RATIO) continue;

    out.push(
      anomaly(
        'anomaly.seller_margin_drop',
        'info',
        { seller: row.name, before: percent(before), after: percent(after), days: ANOMALY_WINDOW_DAYS },
        row.userId,
      ),
    );
  }
  return out;
}

// ── 5. Repeated cash shortfall ────────────────────────────────────────────

export interface CashShortfallInput {
  /** Closings in the window whose count came up short. */
  count: number;
  /** The total shortage, as a positive amount. Cash, not cost. */
  amount: number;
}

/**
 * The drawer keeps coming up short.
 *
 * Counted from the discrepancies the closing workflow already raised — this
 * rule does not decide what "short" means, the closing does. Three in a month
 * is a pattern worth a sentence; one is an evening.
 */
export function cashShortfallAnomalies(input: CashShortfallInput): Anomaly[] {
  if (input.count < SHORTFALL_MIN_COUNT) return [];
  return [
    anomaly('anomaly.cash_shortfall', 'caution', {
      count: input.count,
      amount: round2(Math.abs(input.amount)),
      days: ANOMALY_WINDOW_DAYS,
    }),
  ];
}

// ── 6. Below-cost cluster (Owner only) ────────────────────────────────────

export interface BelowCostInput {
  userId: string;
  name: string;
  count: number;
}

/**
 * One person keeps selling below cost.
 *
 * Counted from approvals that were actually **spent on a sale** — asking is
 * not selling, and a rejected request is the system working. Three by the same
 * person in a month is worth the Owner's attention; it is not an accusation,
 * and the wording says what happened rather than what it means.
 */
export function belowCostAnomalies(rows: readonly BelowCostInput[]): Anomaly[] {
  return rows
    .filter((row) => row.count >= BELOW_COST_MIN_COUNT)
    .map((row) =>
      anomaly(
        'anomaly.below_cost_cluster',
        'caution',
        { seller: row.name, count: row.count, days: ANOMALY_WINDOW_DAYS },
        row.userId,
      ),
    );
}

// ── Shared ────────────────────────────────────────────────────────────────

/**
 * Which anomalies survive the dismissals in force.
 *
 * Suppression is by key, so dismissing one product's low stock silences that
 * product and nothing else.
 */
export function withoutDismissed(
  anomalies: readonly Anomaly[],
  suppressedKeys: ReadonlySet<string>,
): Anomaly[] {
  return anomalies.filter((a) => !suppressedKeys.has(a.key));
}

/** Cautions first; within a severity, the order the rules ran. */
export function orderAnomalies(anomalies: readonly Anomaly[]): Anomaly[] {
  return [...anomalies].sort((a, b) => rank(a.severity) - rank(b.severity));
}

const rank = (severity: WarningSeverity): number => (severity === 'caution' ? 0 : 1);

/** Codes that are worth interrupting somebody for. The other three are read. */
export const NOTIFYING_CODES: ReadonlySet<WarningCode> = new Set<WarningCode>([
  'anomaly.overdue_debt',
  'anomaly.cash_shortfall',
  'anomaly.below_cost_cluster',
]);

function percent(rate: number): number {
  return Math.round(rate * 1000) / 10;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
