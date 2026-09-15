/**
 * The export contract: six reports, and what each one is allowed to say.
 *
 * A column is declared here or it does not exist. That is the point — the
 * writer is handed a list of columns that a specific caller is allowed to see,
 * not an entity with some fields removed afterwards. Serialising first and
 * filtering second is how a CSV becomes the hole the rest of the gating is
 * missing from: `CostGatingInterceptor` maps over a response object, and a
 * `text/csv` body streamed from a controller is a string by then, with no keys
 * left to strip.
 *
 * ## Period versus as-of
 *
 * Three of these reports measure a WINDOW — what was sold, and what it earned.
 * Three describe RIGHT NOW — what is on the shelf, what is owed. Giving the
 * second kind a date range would invite somebody to read a current balance as
 * money that moved last week, which is the same mistake `SummaryService`
 * already refuses to make. So `scope` is declared per report and the file says
 * which one it is, in its own header block.
 *
 * ## Financial columns
 *
 * `financial: true` marks a column that reveals cost, profit or valuation. The
 * authority for which fields those are is `FINANCIAL_FIELDS` — the same set the
 * interceptor uses — and a test asserts that every financial column's id is in
 * it. One list, two consumers; a new financial field cannot be added to the
 * strip list and forgotten here.
 */

import { FINANCIAL_FIELDS } from '../common/interceptors/financial-fields';
import { count, isoDate, money, text } from './report-values';

export const REPORT_KINDS = [
  'profit-by-product',
  'profit-by-employee',
  'profit-by-branch',
  'movers',
  'dead-stock',
  'debtors-creditors',
] as const;

export type ReportKind = (typeof REPORT_KINDS)[number];

export function isReportKind(value: string): value is ReportKind {
  return (REPORT_KINDS as readonly string[]).includes(value);
}

/** How the report is bounded in time. Written into the file's header block. */
export type ReportScope =
  /** Measures a window of trading. Takes `days`. */
  | 'period'
  /** Describes the present. Takes no date range; the file records when it was taken. */
  | 'as_of';

export interface ReportColumn {
  /**
   * The field id. For a financial column this MUST be a key in
   * `FINANCIAL_FIELDS`, so the two lists cannot drift.
   */
  id: string;
  /** Translation key under `report.column.` in the header dictionary. */
  key: string;
  /** Reveals cost, profit or valuation — dropped without `cost.view`. */
  financial?: boolean;
  /**
   * Identity only: a name, a label, an id. A report left with nothing but
   * these after gating has nothing to report, and is refused rather than
   * returned empty — see `substantive` below.
   */
  identity?: boolean;
  /** Monetary, so the header names MRU and the cell carries no symbol. */
  currency?: boolean;
  cell: (row: Record<string, unknown>) => string;
}

export interface ReportDefinition {
  kind: ReportKind;
  scope: ReportScope;
  /** Permissions required IN ADDITION to `report.view`. */
  requires: readonly string[];
  /**
   * A deliberate ranking the report keeps. `null` means the export is the
   * complete filtered set. Where this is set, the file says so and the reader
   * knows they are holding a top-N rather than everything.
   */
  ranking: string | null;
  columns: readonly ReportColumn[];
}

const num = (r: Record<string, unknown>, k: string): number | null => {
  const v = r[k];
  return typeof v === 'number' ? v : null;
};
const str = (r: Record<string, unknown>, k: string): string | null => {
  const v = r[k];
  return typeof v === 'string' ? v : null;
};

/** Columns shared by the three product-shaped reports. */
const PRODUCT_IDENTITY: ReportColumn[] = [
  { id: 'productLabel', key: 'product', identity: true, cell: (r) => text(str(r, 'label')) },
  { id: 'trackingType', key: 'trackingType', identity: true, cell: (r) => text(str(r, 'trackingType')) },
];

export const REPORTS: Record<ReportKind, ReportDefinition> = {
  /**
   * What each product earned. `AnalyticsService.productPerformance`, which is
   * already profit-ranked — the same rows the dashboard's "most profitable"
   * card shows the top five of.
   */
  'profit-by-product': {
    kind: 'profit-by-product',
    scope: 'period',
    requires: [],
    ranking: null,
    columns: [
      ...PRODUCT_IDENTITY,
      { id: 'qtySold', key: 'qtySold', cell: (r) => count(num(r, 'qtySold')) },
      { id: 'revenue', key: 'revenue', currency: true, cell: (r) => money(num(r, 'revenue')) },
      { id: 'cogs', key: 'cogs', financial: true, currency: true, cell: (r) => money(num(r, 'cogs')) },
      { id: 'grossProfit', key: 'grossProfit', financial: true, currency: true, cell: (r) => money(num(r, 'grossProfit')) },
    ],
  },

  /**
   * Per-seller totals, live over `sales` rather than the rollups — attribution
   * is a fact about the sale row, and the rollups do not carry a seller.
   */
  'profit-by-employee': {
    kind: 'profit-by-employee',
    scope: 'period',
    requires: [],
    ranking: null,
    columns: [
      { id: 'employeeName', key: 'employee', identity: true, cell: (r) => text(str(r, 'name')) },
      { id: 'salesCount', key: 'salesCount', cell: (r) => count(num(r, 'salesCount')) },
      { id: 'revenue', key: 'revenue', currency: true, cell: (r) => money(num(r, 'revenue')) },
      { id: 'margin', key: 'margin', financial: true, currency: true, cell: (r) => money(num(r, 'margin')) },
    ],
  },

  /**
   * Always company-wide, exactly as `branchComparison` computes it: comparing
   * branches is the question, so scoping it to the active branch would answer
   * a different one. The file's header block says so.
   */
  'profit-by-branch': {
    kind: 'profit-by-branch',
    scope: 'period',
    requires: [],
    ranking: null,
    columns: [
      { id: 'branchName', key: 'branch', identity: true, cell: (r) => text(str(r, 'name')) },
      { id: 'revenue', key: 'revenue', currency: true, cell: (r) => money(num(r, 'revenue')) },
      { id: 'grossProfit', key: 'grossProfit', financial: true, currency: true, cell: (r) => money(num(r, 'grossProfit')) },
      { id: 'netProfit', key: 'netProfit', financial: true, currency: true, cell: (r) => money(num(r, 'netProfit')) },
    ],
  },

  /**
   * The same rows as `profit-by-product`, ranked by QUANTITY rather than
   * profit — which is what "movers" means and why it is a separate report
   * rather than a sort option: a shop asks "what is shifting?" and "what is
   * earning?" as different questions, and they have different answers.
   *
   * `sold30d` is the velocity figure the dashboard uses, carried through
   * unchanged so the file and the screen cannot disagree.
   */
  movers: {
    kind: 'movers',
    scope: 'period',
    requires: [],
    ranking: null,
    columns: [
      ...PRODUCT_IDENTITY,
      { id: 'qtySold', key: 'qtySold', cell: (r) => count(num(r, 'qtySold')) },
      { id: 'sold30d', key: 'sold30d', cell: (r) => count(num(r, 'sold30d')) },
      { id: 'lastSoldAt', key: 'lastSoldAt', cell: (r) => isoDate(r.lastSoldAt as Date | null) },
      { id: 'revenue', key: 'revenue', currency: true, cell: (r) => money(num(r, 'revenue')) },
      { id: 'grossProfit', key: 'grossProfit', financial: true, currency: true, cell: (r) => money(num(r, 'grossProfit')) },
    ],
  },

  /**
   * Stock that has not sold since the shop's own `dead_stock_days` setting.
   * As-of, not a window: it describes what is on the shelf now.
   *
   * The export is COMPLETE. The dashboard's ten is a card's worth.
   */
  'dead-stock': {
    kind: 'dead-stock',
    scope: 'as_of',
    requires: [],
    ranking: null,
    columns: [
      ...PRODUCT_IDENTITY,
      { id: 'inStock', key: 'inStock', cell: (r) => count(num(r, 'inStock')) },
      { id: 'lastSoldAt', key: 'lastSoldAt', cell: (r) => isoDate(r.lastSoldAt as Date | null) },
      { id: 'inventoryValue', key: 'inventoryValue', financial: true, currency: true, cell: (r) => money(num(r, 'inventoryValue')) },
    ],
  },

  /**
   * Who owes the shop, and who the shop owes — in one file with the direction
   * on every row, because the two are read together and a reader holding two
   * files has to remember which is which.
   *
   * `direction` is `owed_to_us` or `owed_by_us`, from THIS company's point of
   * view, exactly as `LoansService` resolves it. `source` says whether the row
   * came from, so a total can be taken per source
   * without joining two accounting ideas that are not the same idea.
   *
   * Gated beyond `report.view`: a balance names a counterparty and what they
   * owe. `loan.view` is the shop's own debt ledger permission and is required
   * here for the same reason it is required to open the screen.
   */
  'debtors-creditors': {
    kind: 'debtors-creditors',
    scope: 'as_of',
    requires: ['loan.view'],
    ranking: null,
    columns: [
      { id: 'direction', key: 'direction', identity: true, cell: (r) => text(str(r, 'direction')) },
      { id: 'source', key: 'source', identity: true, cell: (r) => text(str(r, 'source')) },
      { id: 'counterparty', key: 'counterparty', identity: true, cell: (r) => text(str(r, 'counterparty')) },
      { id: 'status', key: 'status', identity: true, cell: (r) => text(str(r, 'status')) },
      { id: 'since', key: 'since', cell: (r) => isoDate(r.since as Date | null) },
      { id: 'outstanding', key: 'outstanding', currency: true, cell: (r) => money(num(r, 'outstanding')) },
    ],
  },
};

/**
 * The columns a caller may actually receive.
 *
 * Financial columns are dropped ENTIRELY — not blanked. A blank cell under a
 * `grossProfit` header tells the reader a number exists and is being withheld,
 * and invites them to go and find it; the column simply not being there is the
 * honest shape of what they are allowed to know.
 */
export function authorizedColumns(
  definition: ReportDefinition,
  permissions: ReadonlySet<string>,
): ReportColumn[] {
  const seesMoney = permissions.has('cost.view');
  return definition.columns.filter((c) => seesMoney || !c.financial);
}

/**
 * Does anything worth reporting survive the gating?
 *
 * A profit report stripped down to a list of product names is not a smaller
 * report — it is a different, useless one, and handing it over as though the
 * export succeeded is the misleading substitute this must not return. The
 * caller is refused instead, and told which permission the report needs.
 */
export function substantive(columns: readonly ReportColumn[]): boolean {
  return columns.some((c) => !c.identity);
}

/** Every financial column id must be a field the interceptor also strips. */
export function financialColumnDrift(): string[] {
  const drifted: string[] = [];
  for (const definition of Object.values(REPORTS)) {
    for (const column of definition.columns) {
      if (column.financial && !FINANCIAL_FIELDS.has(column.id)) drifted.push(column.id);
    }
  }
  return drifted;
}
