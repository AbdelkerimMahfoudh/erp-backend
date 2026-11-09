// GENERATED from erp-mobile lib/report-document.ts at 5dcfb74 by scripts/sync-report-pdf.mjs — do not edit; sync again.
/* eslint-disable */
// @ts-nocheck
/**
 * The report documents the server assembles for the in-app PDFs (backend
 * `src/reports/report-documents.ts`, docs/66): the daily report of one business
 * date and the monthly report of one calendar month.
 *
 * Every figure here is the server's. The phone lays the document out and never
 * adds anything up — a section the person may not see is absent (`null`, or a
 * result with `status: 'hidden'`) because the server left it out.
 *
 * The same document is the contract a later server-side delivery would read
 * (postponed — docs/21 D111); nothing in it belongs to the phone.
 */

export const REPORT_DOCUMENT_VERSION = 1;

export interface ReportIdentity {
  company: string;
  branch: string;
  /** D225: the Arabic names, null until given; an Arabic report prints them. Absent from an older server. */
  companyAr?: string | null;
  branchAr?: string | null;
  timezone: string;
}

export interface Tally {
  count: number;
  amount: number;
}

export interface RefundFigures {
  /** Confirmed in the period: the money that left. */
  confirmed: Tally;
  /** Reported, waiting for a manager or the Owner — not an outflow. Now, all dates. */
  awaitingConfirmation: Tally;
  /** Approved and not yet confirmed: still owed to customers. Now, all dates. */
  outstanding: Tally;
}

export interface DocumentWarning {
  code: string;
  severity: 'info' | 'warning' | 'error';
  params?: Record<string, string | number>;
}

export type DayStanding = 'open' | 'counting' | 'counted' | 'closed' | 'reopened' | 'needs_review' | 'inactive';
export type Verification = 'counted' | 'skipped' | 'not_verified' | 'attested' | 'stale' | 'not_counted';
export type ChannelKind = 'cash' | 'account' | 'unattributed';

export type DailyResult =
  | { status: 'hidden' }
  | { status: 'cannot_calculate'; missingCostLines: number }
  | {
      status: 'ok';
      netSales: number;
      costOfUnitsSold: number;
      grossProfit: number;
      variableExpenses: number;
      resultBeforeFixed: number;
      fixedExpenses: number;
      maintenanceNet?: number;
      resultAfterExpenses: number;
    };

export interface DailyReportDocument {
  kind: 'daily';
  version: number;
  identity: ReportIdentity;
  date: string;
  window: { startsAt: string; endsAt: string };
  generatedAt: string;
  isToday: boolean;
  standing: DayStanding;
  basis: {
    source: 'live' | 'snapshot';
    closedAt: string | null;
    closedBy: string | null;
    reclosed: boolean;
    acknowledgedUnverified: boolean;
    reason: string | null;
  };
  sections: { sales: boolean; expenses: boolean; result: boolean; refunds: boolean };
  sales: {
    invoices: { count: number; value: number; items: number };
    cancellations: { count: number; value: number; items: number };
    returns: { count: number; value: number };
    net: { count: number; items: number; value: number };
    collected: number;
    owed: number;
  } | null;
  result: DailyResult;
  expenses: {
    total: number;
    recorded: number;
    reversed: number;
    variable: number;
    fixed: number;
    salaries: number;
    count: number;
    byCategory: { category: string; amount: number; count: number }[];
  } | null;
  money: {
    basis: 'recorded_movement_not_balance';
    channels: { kind: ChannelKind; label: string; in: number; out: number; net: number }[];
    totals: { in: number; out: number; net: number; olderDebts: number };
  };
  checks: { kind: ChannelKind; label: string; expected: number; counted: number | null; difference: number | null; verification: Verification }[];
  refunds: RefundFigures | null;
  receivables: { amount: number; sales: number };
  warnings: DocumentWarning[];
}

export type MonthlyResult =
  | { status: 'hidden' }
  | {
      status: 'ok';
      netSales: number;
      costOfUnitsSold: number;
      grossProfit: number;
      variableExpenses: number;
      resultBeforeFixed: number;
      fixedExpenses: number;
      salaries: number;
      netOperatingProfit: number;
    };

export interface MonthlyReportDocument {
  kind: 'monthly';
  /** Money from repairs (D227). Cost and profit only with cost.view; absent from an older server. */
  maintenance?: { revenue: number; cost?: number; profit?: number };
  version: number;
  identity: ReportIdentity;
  month: string;
  from: string;
  to: string;
  complete: boolean;
  generatedAt: string;
  sections: { result: boolean; refunds: boolean };
  sales: {
    invoices: { count: number; value: number; items: number };
    cancellations: { count: number; value: number; items: number };
    returns: { count: number; value: number };
    net: { count: number; items: number; value: number };
  };
  result: MonthlyResult;
  expenses: { total: number; variable: number; fixedOther: number; salaries: number; count: number };
  refunds: RefundFigures | null;
  receivables: {
    sales: { amount: number; sales: number };
    loansReceivable: number;
    loansPayable: number;
    consignmentReceivable: number;
  };
  commissions: { recorded: false };
  days: { date: string; count: number; items: number; netSales: number }[];
  warnings: DocumentWarning[];
}

export type ReportDocument = DailyReportDocument | MonthlyReportDocument;

/** What to ask the server for: one business date, or one month (none = the current one). */
export type ReportRequest = { kind: 'daily'; date?: string } | { kind: 'monthly'; month?: string };

/** The one endpoint each document comes from — a GET, and nothing else. */
export function reportDocumentPath(request: ReportRequest): string {
  if (request.kind === 'daily') return request.date ? `/reports/daily?date=${encodeURIComponent(request.date)}` : '/reports/daily';
  return request.month ? `/reports/monthly?month=${encodeURIComponent(request.month)}` : '/reports/monthly';
}

/**
 * A document this app version can print: the right kind and the contract version it
 * was written for. Anything else is refused whole rather than printed half-understood.
 */
export function isPrintableDocument(doc: unknown, kind: ReportRequest['kind']): doc is ReportDocument {
  if (!doc || typeof doc !== 'object') return false;
  const d = doc as { kind?: unknown; version?: unknown; identity?: unknown };
  return d.kind === kind && d.version === REPORT_DOCUMENT_VERSION && typeof d.identity === 'object' && d.identity !== null;
}
