/**
 * One warning contract, shared by the magnitude checks (A1) and the anomaly
 * rules (A3).
 *
 * A warning is **advisory**. It never blocks, never alters a value, and never
 * authorises anything. The only thing it changes is that a mutation carrying
 * warnings must be re-submitted with an acknowledgement — see
 * `acknowledgement.ts` for why that acknowledgement is bound to the exact
 * payload rather than to the user.
 *
 * ## What may travel in a warning
 *
 * Only the fields below, and every one of them is chosen to be safe to show to
 * whoever triggered it. In particular a warning must never carry:
 *
 * - a cost or margin the caller is not permitted to see — the reference is
 *   described rather than quoted when it is derived from cost;
 * - another tenant's figures, ever;
 * - a raw internal identifier. Binary ids stay on the server.
 *
 * The message is a **key plus parameters**, not a sentence. The server does not
 * know the reader's language, and a server-rendered English string is how an
 * Arabic interface ends up with English in the middle of it.
 */

export type WarningSeverity =
  /** Worth a glance. Shown, not confirmed. */
  | 'info'
  /** Worth stopping for. Requires a deliberate acknowledgement to proceed. */
  | 'caution';

/**
 * Every warning this system can raise.
 *
 * A closed union rather than free strings: a typo in a code is then a compile
 * error rather than a warning that silently never matches a translation.
 */
export type WarningCode =
  // A1 — order of magnitude
  | 'magnitude.sale_price'
  | 'magnitude.intake_cost'
  | 'magnitude.configured_price'
  | 'magnitude.expense_amount'
  | 'magnitude.debt_payment'
  // A3 — deterministic anomalies
  | 'anomaly.low_stock'
  | 'anomaly.dead_stock'
  | 'anomaly.overdue_debt'
  | 'anomaly.seller_margin_drop'
  | 'anomaly.cash_shortfall'
  | 'anomaly.below_cost_cluster';

/**
 * A value safe to interpolate into a translated sentence.
 *
 * Numbers and short strings only. Anything richer would be a shape the client
 * has to understand, and a shape is where an unreviewed field slips through.
 */
export type WarningParam = string | number;

export interface Warning {
  code: WarningCode;
  severity: WarningSeverity;
  /**
   * The i18n key the client renders. Always derivable from `code`, sent
   * explicitly so a client never has to build one by string concatenation.
   */
  messageKey: string;
  /** Interpolated into the translated message. Safe values only. */
  params: Record<string, WarningParam>;
  /**
   * Which input this is about, in the caller's own terms — `lines.0.price`.
   * Null for a warning about the request as a whole, which is every anomaly.
   */
  field: string | null;
  /** What the caller submitted, echoed so the message can quote it. */
  submitted: number | null;
  /**
   * What the value was compared against, **described rather than quoted** when
   * the reference is cost-derived and the caller may not see cost.
   *
   * `{ kind: 'configured_price', amount: 17000 }` for something they may see;
   * `{ kind: 'unit_cost', amount: null }` for something they may not. The
   * client says "lower than the cost" without ever learning the cost.
   */
  reference: WarningReference | null;
}

export interface WarningReference {
  kind:
    | 'configured_price'
    | 'median_sale_price'
    | 'weighted_average_cost'
    | 'previous_price'
    | 'median_expense'
    | 'outstanding_balance'
    | 'unit_cost';
  /** Null when the caller is not permitted to see this figure. */
  amount: number | null;
  /** How many observations the reference is built from, where that applies. */
  sample: number | null;
}

/**
 * What a mutation returns when it has something to say but has changed nothing.
 *
 * **Nothing is persisted.** A warned request is a request that has not happened
 * yet — the caller has to come back with an acknowledgement. Writing the row
 * and warning afterwards would make the warning decorative.
 */
export interface WarningResponse {
  /** Always `warnings_pending`, so a client can branch on one field. */
  status: 'warnings_pending';
  warnings: Warning[];
  /** Opaque. Bound to actor, tenant, operation, payload and expiry. */
  acknowledgementToken: string;
  /** ISO-8601. Short — see `ACKNOWLEDGEMENT_TTL_SECONDS`. */
  expiresAt: string;
}

export const isWarningResponse = (value: unknown): value is WarningResponse =>
  typeof value === 'object' &&
  value !== null &&
  (value as { status?: unknown }).status === 'warnings_pending';

/** `magnitude.sale_price` → `warning.magnitude.salePrice`. */
export function messageKeyFor(code: WarningCode): string {
  const camel = code.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return `warning.${camel}`;
}
