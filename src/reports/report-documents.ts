import type { DayStanding, Verification } from '../closing/closing-lifecycle';
import type { GatedReport, ReportChannel } from '../closing/closing-report';
import type { PeriodFigures } from '../analytics/period-figures';
import { sumFigures } from '../analytics/period-figures';
import type { PeriodSummary } from '../analytics/summary.service';

/**
 * The two report documents (docs/66): the daily report of one business date and the
 * monthly report of one calendar month, each as ONE versioned contract. The app renders it
 * as a PDF; a later server-side delivery (postponed — docs/21 D111) can render or summarise
 * the same document without assembling anything again.
 *
 * **Not a second reporting system.** Every figure is copied from a calculation the server
 * already owns:
 *
 *   daily    the Daily closing's report (closing-report.ts), gated for the caller, or the
 *            snapshot the day was closed on
 *   monthly  the period summary's profit and expenses (summary.service.ts, from the daily
 *            rollups) and the dated period figures (period-figures.ts) for the counts and the
 *            day-by-day sales
 *   both     the returns workflow's refund summary (approved − confirmed, derived from
 *            immutable rows) and the open sale balances
 *
 * The only arithmetic here is the monthly split of expenses that the rollup already keeps
 * net of reversals — variable = total − fixed, other fixed = fixed − salaries — and the
 * result before fixed costs, gross profit − variable. `monthlyDocument` checks that the parts
 * add back up to the summary's own net result, and that the rollup and the dated figures
 * agree on sales and refunds; a disagreement is printed as a warning, never smoothed over.
 *
 * **What it never carries:** an id of any kind (channel keys and account ids are dropped),
 * a note, a person's contact detail, or a cost or profit figure for somebody without
 * `cost.view` — the result is `{ status: 'hidden' }` here, and the global cost gating strips
 * the same keys again on the way out.
 */

export const REPORT_DOCUMENT_VERSION = 1 as const;

/** Who the report is about: names only. */
export interface ReportIdentity {
  company: string;
  branch: string;
  /** The company's zone, in which every business date and time is meant. */
  timezone: string;
}

export interface Tally {
  count: number;
  amount: number;
}

/**
 * The refund figures of the returns workflow (I3). Three moments, kept apart because
 * collapsing them is how a refund gets counted twice: an approval creates what is owed
 * (and already moved profit), a report is a claim with no money moved, a confirmation is
 * the money leaving.
 */
export interface RefundFigures {
  /** Confirmed in the period, on their confirmation date: the money that left. */
  confirmed: Tally;
  /** Reported and waiting for a manager or the Owner — NOT an outflow. Now, all dates. */
  awaitingConfirmation: Tally;
  /** Approved and not yet confirmed: what is still owed to customers. Now, all dates. */
  outstanding: Tally;
}

/** The refund summary as `ReturnsService.refundSummary` returns it — the part read here. */
export interface RefundSummarySource {
  outstandingLiability: Tally;
  awaitingConfirmation: Tally;
  confirmed: { count: number; total: number };
}

export function refundFigures(s: RefundSummarySource): RefundFigures {
  return {
    confirmed: { count: s.confirmed.count, amount: s.confirmed.total },
    awaitingConfirmation: { count: s.awaitingConfirmation.count, amount: s.awaitingConfirmation.amount },
    outstanding: { count: s.outstandingLiability.count, amount: s.outstandingLiability.amount },
  };
}

/** Open sale balances at the branch — customers and partner stores alike — now. */
export interface Receivables {
  amount: number;
  sales: number;
}

export interface DocumentWarning {
  code: string;
  severity: 'info' | 'warning' | 'error';
  params?: Record<string, string | number>;
}

// ── Daily ────────────────────────────────────────────────────────────────────

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
      /** Gross profit − variable expenses: the day's operating result before fixed costs (docs/21 §10). */
      resultBeforeFixed: number;
      /** Fixed costs whose due date is this day (Milestone D), in full. */
      fixedExpenses: number;
      resultAfterExpenses: number;
    };

export interface DailyDocument {
  kind: 'daily';
  version: typeof REPORT_DOCUMENT_VERSION;
  identity: ReportIdentity;
  /** The business date. */
  date: string;
  /** The instants it spans — from 06:00 local to the next 06:00, unless the Owner started a day early. */
  window: { startsAt: string; endsAt: string };
  generatedAt: string;
  isToday: boolean;
  standing: DayStanding;
  /** Live figures, or the figures exactly as the day was closed. */
  basis: {
    source: 'live' | 'snapshot';
    closedAt: string | null;
    closedBy: string | null;
    reclosed: boolean;
    /** Closed with channels nobody checked, after saying so. */
    acknowledgedUnverified: boolean;
    reason: string | null;
  };
  sections: { sales: boolean; expenses: boolean; result: boolean; refunds: boolean };
  sales: {
    invoices: { count: number; value: number; items: number };
    cancellations: { count: number; value: number; items: number };
    returns: { count: number; value: number };
    /** Invoices − cancellations (docs/53 R5, R6); value − returns − cancellations. */
    net: { count: number; items: number; value: number };
    /** Received against this day's sales by the end of the day. */
    collected: number;
    /** Still owed on this day's sales. */
    owed: number;
  } | null;
  result: DailyResult;
  expenses: {
    /** Recorded − reversed. */
    total: number;
    recorded: number;
    reversed: number;
    variable: number;
    fixed: number;
    salaries: number;
    count: number;
    byCategory: { category: string; amount: number; count: number }[];
  } | null;
  /** What staff recorded through each channel — never a provider's balance. */
  money: {
    basis: 'recorded_movement_not_balance';
    channels: { kind: ChannelKind; label: string; in: number; out: number; net: number }[];
    totals: { in: number; out: number; net: number; olderDebts: number };
  };
  /** Each channel's expected figure against its count, when somebody counted. */
  checks: {
    kind: ChannelKind;
    label: string;
    /** Cash: what the drawer should hold. An account: the recorded movement of the day, not a balance. */
    expected: number;
    counted: number | null;
    difference: number | null;
    verification: Verification;
  }[];
  refunds: RefundFigures | null;
  receivables: Receivables;
  warnings: DocumentWarning[];
}

/** `ClosingService.report()` as the document reads it: the gated report and how it was frozen. */
export type DailyReportSource = GatedReport & {
  source: 'live' | 'snapshot';
  snapshot: {
    kind: string;
    at: Date | string;
    by: string | null;
    verification: { acknowledged: boolean; reason: string | null };
  } | null;
};

export interface DailyDocumentInput {
  identity: ReportIdentity;
  report: DailyReportSource;
  /** Null when the caller may not see returns (`return.view`). */
  refunds: RefundSummarySource | null;
  receivables: Receivables;
  generatedAt: Date;
}

const kindOf = (c: Pick<ReportChannel, 'channel' | 'isUnattributed'>): ChannelKind =>
  c.channel === 'cash' ? 'cash' : c.isUnattributed ? 'unattributed' : 'account';

export function dailyDocument(i: DailyDocumentInput): DailyDocument {
  const r = i.report;
  const channelByKey = new Map(r.money.channels.map((c) => [c.key, c]));
  const snap = r.source === 'snapshot' ? r.snapshot : null;

  return {
    kind: 'daily',
    version: REPORT_DOCUMENT_VERSION,
    identity: i.identity,
    date: r.date,
    window: r.window,
    generatedAt: i.generatedAt.toISOString(),
    isToday: r.isToday,
    standing: r.standing,
    basis: {
      source: r.source,
      closedAt: snap ? new Date(snap.at).toISOString() : null,
      closedBy: snap?.by ?? null,
      reclosed: snap?.kind === 'reclosed',
      acknowledgedUnverified: snap?.verification.acknowledged ?? false,
      reason: snap?.verification.reason ?? null,
    },
    sections: {
      sales: r.sales !== null,
      expenses: r.expenses !== null,
      result: r.result.status !== 'hidden',
      refunds: i.refunds !== null,
    },
    sales: r.sales
      ? {
          invoices: { count: r.sales.count, value: r.sales.value, items: r.sales.itemsSold },
          cancellations: { count: r.sales.cancellations.count, value: r.sales.cancellations.value, items: r.sales.cancellations.items },
          returns: { count: r.sales.returns.count, value: r.sales.returns.netRefundDue },
          // A close stored before docs/53 R5/R6 has no defined count: the invoices are what it counted.
          net: { count: r.sales.salesCount ?? r.sales.count, items: r.sales.unitsSold ?? r.sales.itemsSold, value: r.sales.netSalesValue },
          collected: r.sales.collected.total,
          owed: r.sales.owed,
        }
      : null,
    result: dailyResult(r.result),
    expenses: r.expenses
      ? {
          total: r.expenses.total,
          recorded: r.expenses.recorded,
          reversed: r.expenses.reversed,
          variable: r.expenses.variable,
          fixed: r.expenses.fixed,
          salaries: r.expenses.salaries,
          count: r.expenses.count,
          byCategory: r.expenses.byCategory.map((c) => ({ category: c.category, amount: c.amount, count: c.count })),
        }
      : null,
    money: {
      basis: 'recorded_movement_not_balance',
      // The channels the Daily closing shows: every one that can be counted, and any other that moved.
      channels: r.money.channels
        .filter((c) => c.countable || c.net !== 0)
        .map((c) => ({ kind: kindOf(c), label: c.label, in: c.in.total, out: c.out.total, net: c.net })),
      totals: { in: r.money.totals.in, out: r.money.totals.out, net: r.money.totals.net, olderDebts: r.money.totals.olderDebts },
    },
    checks: [
      {
        kind: 'cash' as const,
        label: r.money.channels.find((c) => c.channel === 'cash')?.label ?? 'Cash',
        expected: r.expected.cash.expected,
        counted: r.expected.cash.counted,
        difference: r.expected.cash.difference,
        verification: r.expected.cash.verification,
      },
      ...r.expected.accounts.map((a) => {
        const channel = channelByKey.get(a.key);
        return {
          kind: channel ? kindOf(channel) : ('account' as const),
          label: a.label,
          expected: a.expectedMovement,
          counted: a.counted,
          difference: a.difference,
          verification: a.verification,
        };
      }),
    ],
    refunds: i.refunds ? refundFigures(i.refunds) : null,
    receivables: i.receivables,
    // The warnings the caller may see, without the section tag (an internal routing detail).
    warnings: r.warnings.map((w) => ({ code: w.code, severity: w.severity, ...(w.params ? { params: w.params } : {}) })),
  };
}

function dailyResult(result: GatedReport['result']): DailyResult {
  if (result.status === 'hidden') return { status: 'hidden' };
  if (result.status === 'cannot_calculate') return { status: 'cannot_calculate', missingCostLines: result.missingCostLines };
  return {
    status: 'ok',
    netSales: result.netSales ?? 0,
    costOfUnitsSold: result.costOfUnitsSold ?? 0,
    grossProfit: result.grossProfit ?? 0,
    variableExpenses: result.variableExpenses,
    resultBeforeFixed: result.resultBeforeFixed ?? 0,
    fixedExpenses: result.fixedExpenses,
    resultAfterExpenses: result.resultAfterExpenses ?? 0,
  };
}

// ── Monthly ──────────────────────────────────────────────────────────────────

export type MonthlyResult =
  | { status: 'hidden' }
  | {
      status: 'ok';
      netSales: number;
      costOfUnitsSold: number;
      grossProfit: number;
      variableExpenses: number;
      /** Gross profit − variable expenses. */
      resultBeforeFixed: number;
      /** Rent and the other fixed costs, salaries apart. */
      fixedExpenses: number;
      salaries: number;
      /** Gross profit − every expense: the month's net result. */
      netOperatingProfit: number;
    };

export interface MonthlyDocument {
  kind: 'monthly';
  version: typeof REPORT_DOCUMENT_VERSION;
  identity: ReportIdentity;
  /** YYYY-MM. */
  month: string;
  from: string;
  /** The month's last day, or today's business date while the month is still running. */
  to: string;
  /** False while the month is still running: the figures are month to date. */
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
    /** Open sale balances at this branch, now. */
    sales: Receivables;
    /** The whole business, now: loans and consignment are not kept per branch. */
    loansReceivable: number;
    loansPayable: number;
    consignmentReceivable: number;
  };
  /** External commissions have no record anywhere in the application yet. */
  commissions: { recorded: false };
  /** Each day of the month that carries a sale, a cancellation or a return — chronological. */
  days: { date: string; count: number; items: number; netSales: number }[];
  warnings: DocumentWarning[];
}

export interface MonthlyDocumentInput {
  identity: ReportIdentity;
  range: MonthRange;
  /** The period summary, computed in full (the cost gating strips it on the way out, not here). */
  summary: Pick<PeriodSummary, 'profit' | 'expenseDetail' | 'balances' | 'cash'>;
  /** The dated figures of each day of the range (`figuresByDay`). */
  days: Map<string, PeriodFigures>;
  refunds: RefundSummarySource | null;
  receivables: Receivables;
  costView: boolean;
  generatedAt: Date;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
/** Two money figures from two sources agree when they are within half a khoums. */
const agree = (a: number, b: number): boolean => Math.abs(a - b) < 0.005;

export function monthlyDocument(i: MonthlyDocumentInput): MonthlyDocument {
  const total = sumFigures([...i.days.values()]);
  const p = i.summary.profit;
  const e = i.summary.expenseDetail;
  // The rollup keeps all three net of reversals, so the split is exact (Milestone D: a salary is always fixed).
  const variable = round2(e.total - e.fixed);
  const fixedOther = round2(e.fixed - e.salaries);
  const resultBeforeFixed = round2(p.grossProfit - variable);

  const warnings: DocumentWarning[] = [];
  if (!i.range.complete) warnings.push({ code: 'month_in_progress', severity: 'info', params: { to: i.range.to } });
  // Two sources of the same facts: the daily rollups (profit, expenses, refunds paid) and the dated records.
  const disagreements = [
    !agree(p.netRevenue, total.net.salesValue),
    !agree(p.grossSales, total.invoices.value),
    !agree(e.total, total.expenses.net),
    i.refunds !== null && !agree(i.summary.cash.refundsPaid, i.refunds.confirmed.total),
    // The parts must add back to the summary's own net result.
    !agree(round2(resultBeforeFixed - fixedOther - e.salaries), p.netOperatingProfit),
  ].filter(Boolean).length;
  if (disagreements > 0) warnings.push({ code: 'figures_disagree', severity: 'error', params: { count: disagreements } });

  return {
    kind: 'monthly',
    version: REPORT_DOCUMENT_VERSION,
    identity: i.identity,
    month: i.range.month,
    from: i.range.from,
    to: i.range.to,
    complete: i.range.complete,
    generatedAt: i.generatedAt.toISOString(),
    sections: { result: i.costView, refunds: i.refunds !== null },
    sales: {
      invoices: { count: total.invoices.count, value: total.invoices.value, items: total.invoices.units },
      cancellations: { count: total.cancellations.count, value: total.cancellations.value, items: total.cancellations.units },
      returns: { count: total.returns.count, value: total.returns.value },
      net: { count: total.net.salesCount, items: total.net.units, value: total.net.salesValue },
    },
    result: i.costView
      ? {
          status: 'ok',
          netSales: p.netRevenue,
          costOfUnitsSold: p.netCogs,
          grossProfit: p.grossProfit,
          variableExpenses: variable,
          resultBeforeFixed,
          fixedExpenses: fixedOther,
          salaries: e.salaries,
          netOperatingProfit: p.netOperatingProfit,
        }
      : { status: 'hidden' },
    expenses: { total: e.total, variable, fixedOther, salaries: e.salaries, count: e.count },
    refunds: i.refunds ? refundFigures(i.refunds) : null,
    receivables: {
      sales: i.receivables,
      loansReceivable: i.summary.balances.loansReceivable,
      loansPayable: i.summary.balances.loansPayable,
      consignmentReceivable: i.summary.balances.consignmentBalance,
    },
    commissions: { recorded: false },
    days: [...i.days.entries()]
      .filter(([, f]) => f.invoices.count + f.cancellations.count + f.returns.count > 0)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, f]) => ({ date, count: f.net.salesCount, items: f.net.units, netSales: f.net.salesValue })),
    warnings,
  };
}

// ── The month ────────────────────────────────────────────────────────────────

export interface MonthRange {
  month: string;
  from: string;
  to: string;
  complete: boolean;
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/**
 * The days a monthly report covers: the whole month once it is over, the month to date
 * (today's business date included) while it runs. A month that has not begun is refused,
 * and so is anything that is not `YYYY-MM`. No month means the current one.
 */
export function monthRange(month: string | undefined, today: string): MonthRange {
  const current = today.slice(0, 7);
  const m = month ?? current;
  const match = MONTH.exec(m);
  if (!match) throw new RangeError('month must be YYYY-MM');
  if (m > current) throw new RangeError('That month has not begun');
  if (Number(match[1]) < 2000) throw new RangeError('month must be YYYY-MM');
  const year = Number(match[1]);
  const monthIndex = Number(match[2]);
  // Day 0 of the next month is the last day of this one.
  const lastDay = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  const end = `${m}-${String(lastDay).padStart(2, '0')}`;
  const complete = m < current;
  return { month: m, from: `${m}-01`, to: complete ? end : today, complete };
}
