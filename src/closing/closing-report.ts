import { createHash } from 'node:crypto';
import type { ChannelRow } from './channels';
import { isCountable } from './channels';
import type { DayStanding, Verification } from './closing-lifecycle';
import { closeVerification } from './closing-lifecycle';

/**
 * The Daily closing report, assembled from server records only (docs/51 §3, D1).
 *
 * Pure on purpose: every figure the Owner closes the day on is computed here from
 * the rows the service reads, and every total is checked against its own lines
 * before anybody sees it. The phone sums nothing.
 *
 * The five sections and their formulas (D = the business date, B = the branch):
 *
 *   Sales     value   = Σ sales.total                         (sales.business_date = D)
 *             returns = Σ return_reversals.net_refund_due      (approval_date = D)
 *             cancelled = Σ sales.total of sales cancelled on D (correction_date = D, any sale date — 0079)
 *             collected for these sales = Σ payments on D's sales with payments.business_date ≤ D
 *                                         + Σ legs of those payments posted by corrections ≤ D (in − out)
 *             still owed on these sales = value − collected − D's own sales cancelled by the end of D
 *   Money     per channel, from the one channel builder (channels.ts): in = payments + corrections in;
 *             out = confirmed refunds + stock paid + confirmed expenses + corrections out;
 *             payments split by whether the sale is D's (today's sales) or earlier (older debts)
 *   Expenses  recorded = confirmed, a variable one on its confirmation date, a fixed one on its due date;
 *             reversed = expense reversals approved on D;  total = recorded − reversed
 *   Result    net sales = value − returns − cancelled;
 *             cost of units sold = Σ sales.total_cost − Σ return line_cost − Σ cancelled sales' total_cost;
 *             gross profit = net sales − cost of units sold;  result after expenses = gross profit − expenses total
 *   Expected  cash = opening + cash in − cash out;  each account: recorded movement (in − out), never a balance
 */

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Below this a recorded cost is treated as missing — a zero cost is never a real one here (docs/51 §5). */
export const MISSING_COST_EPSILON = 0.005;

// ── What the service reads ───────────────────────────────────────────────────

export interface SalesFigures {
  count: number;
  value: number;
  itemsSold: number;
  /** Σ sales.total_cost of the date's sales (the recorded cost of units sold). */
  cost: number;
  /** Sold lines of the date whose recorded cost is missing (≤ 0.005). */
  missingCostLines: number;
}

export interface ReturnFigures {
  count: number;
  grossRefund: number;
  adjustments: number;
  netRefundDue: number;
  /** The recorded cost credited back by the approved returns. */
  costCredited: number;
  missingCostLines: number;
}

export interface CollectedForSales {
  /** Taken at the till with the sale. */
  atCheckout: number;
  /** Collected later against the same sales, still within the date. */
  laterSameDay: number;
  /**
   * What corrections posted by the end of the date did to that money (0079): a payment
   * never received, or a cancelled sale's money given back, is negative; a move between
   * channels nets to zero.
   */
  corrections: number;
}

/** Sales cancelled ON the date (0079), whatever day they were sold. */
export interface CancellationFigures {
  count: number;
  value: number;
  /** Their recorded cost, credited back. */
  cost: number;
  missingCostLines: number;
  /** The part of `value` that is the date's own sales. */
  ofTheseSales: number;
}

/** A confirmed expense reversed on the date (0079). */
export interface ExpenseReversalLine {
  correctionId: string;
  expenseId: string;
  category: string;
  expenseClass: 'variable' | 'fixed';
  isSalary: boolean;
  amount: number;
  method: 'cash' | 'account';
  accountLabel: string | null;
}

export interface ChannelSplit {
  /** Payments on this channel, dated D, against sales of D. */
  todaysSales: number;
  /** Payments on this channel, dated D, against sales of an earlier date. */
  olderDebts: number;
}

export interface ExpenseLine {
  id: string;
  category: string;
  expenseClass: 'variable' | 'fixed';
  isSalary: boolean;
  amount: number;
  method: 'cash' | 'account';
  accountLabel: string | null;
}

export interface ChannelCountState {
  verification: Verification;
  counted: number | null;
  countedAt: Date | null;
  skipReason: string | null;
}

export interface OpeningCash {
  amount: number;
  /** The last close whose cash was actually counted, or null: no counted opening yet. */
  anchorDate: string | null;
  anchorVerified: boolean;
  /** Days between the anchor and this date carried forward by their recorded movement. */
  carriedDays: number;
}

export interface ReportInputs {
  date: string;
  today: string;
  timezone: string;
  window: { startsAt: string; endsAt: string };
  standing: DayStanding;
  sales: SalesFigures;
  returns: ReturnFigures;
  cancellations: CancellationFigures;
  collected: CollectedForSales;
  channels: ChannelRow[];
  splits: Map<string, ChannelSplit>;
  expenses: ExpenseLine[];
  expenseReversals: ExpenseReversalLine[];
  counts: Map<string, ChannelCountState>;
  opening: OpeningCash;
  pending: { refundReports: { count: number; amount: number }; expenseReports: { count: number; amount: number } } | null;
  openDiscrepancies: number;
  previousDay: { businessDate: string; standing: DayStanding; needsReview: boolean } | null;
  closeKind: 'first' | 'reclose' | 'already_locked';
}

// ── What the caller may see (D6) ─────────────────────────────────────────────

export interface ReportPermissions {
  /** `closing.count` — the route itself; money and expected balances. */
  count: boolean;
  /** `report.view` — sales and expenses. */
  reportView: boolean;
  /** `closing.perform` — sales and expenses too, and the close. */
  perform: boolean;
  /** `cost.view` — with one of the two above, the result. */
  costView: boolean;
}

export function sectionsFor(p: ReportPermissions): { sales: boolean; expenses: boolean; result: boolean; close: boolean } {
  const figures = p.reportView || p.perform;
  return { sales: figures, expenses: figures, result: figures && p.costView, close: p.perform };
}

// ── The report ───────────────────────────────────────────────────────────────

export type WarningCode =
  | 'channels_not_verified'
  | 'channels_stale'
  | 'account_movement_not_balance'
  | 'unattributed_money'
  | 'pending_refund_reports'
  | 'pending_expense_reports'
  | 'cost_missing'
  | 'no_counted_opening'
  | 'opening_not_verified'
  | 'negative_expected'
  | 'open_discrepancies'
  | 'previous_day_needs_review'
  | 'overcollected'
  | 'changed_since_close'
  | 'figures_disagree';

export interface ReportWarning {
  code: WarningCode;
  severity: 'info' | 'warning' | 'error';
  /** Which section the warning describes: it is shown only to somebody allowed to see that section. */
  section: 'money' | 'sales' | 'expenses' | 'result' | 'day';
  params?: Record<string, string | number>;
}

export interface ReportChannel {
  key: string;
  channel: 'cash' | 'account';
  accountId: string | null;
  label: string;
  isUnattributed: boolean;
  countable: boolean;
  in: { todaysSales: number; olderDebts: number; correctionsIn: number; total: number };
  out: { refunds: number; stockPurchases: number; expenses: number; correctionsOut: number; total: number };
  net: number;
}

export interface ReportResult {
  status: 'ok' | 'cannot_calculate';
  reason: 'cost_missing' | null;
  missingCostLines: number;
  netSales: number | null;
  costOfUnitsSold: number | null;
  returnsCostCredited: number | null;
  /** The recorded cost of the sales cancelled on the date, credited back (0079). */
  cancelledCostCredited: number | null;
  grossProfit: number | null;
  variableExpenses: number;
  fixedExpenses: number;
  resultBeforeFixed: number | null;
  resultAfterExpenses: number | null;
  /** Fixed costs are counted in full on their due date (Milestone D), never spread over the month. */
  scope: 'fixed_costs_on_due_date';
}

export interface ClosingReport {
  date: string;
  today: string;
  isToday: boolean;
  timezone: string;
  window: { startsAt: string; endsAt: string };
  standing: DayStanding;
  sales: {
    count: number;
    value: number;
    itemsSold: number;
    returns: { count: number; grossRefund: number; adjustments: number; netRefundDue: number };
    /** Sales cancelled on the date (0079): their value comes off here, on this day, never on the day they were sold. */
    cancellations: { count: number; value: number };
    netSalesValue: number;
    collected: { atCheckout: number; laterSameDay: number; corrections: number; total: number };
    owed: number;
  };
  money: {
    channels: ReportChannel[];
    totals: { in: number; out: number; net: number; todaysSales: number; olderDebts: number };
    pending: ReportInputs['pending'];
  };
  expenses: {
    /** Recorded − reversed: what the date's expenses came to. */
    total: number;
    /** The confirmed expenses of the date, as recorded. */
    recorded: number;
    /** Confirmed expenses reversed on the date (0079), whatever day they were recorded. */
    reversed: number;
    reversals: ExpenseReversalLine[];
    cash: number;
    account: number;
    count: number;
    variable: number;
    fixed: number;
    salaries: number;
    byCategory: { category: string; amount: number; count: number }[];
    lines: ExpenseLine[];
  };
  result: ReportResult;
  expected: {
    cash: {
      opening: OpeningCash;
      in: number;
      out: number;
      expected: number;
      counted: number | null;
      difference: number | null;
      verification: Verification;
      countedAt: string | null;
    };
    accounts: {
      key: string;
      accountId: string | null;
      label: string;
      in: number;
      out: number;
      expectedMovement: number;
      counted: number | null;
      difference: number | null;
      verification: Verification;
      /** What the backend knows: the movement staff recorded, never the provider's balance. */
      basis: 'recorded_movement_not_balance';
    }[];
  };
  warnings: ReportWarning[];
  close: {
    kind: 'first' | 'reclose' | 'already_locked';
    requiresAcknowledgement: boolean;
    unverified: string[];
    verified: string[];
  };
}

const keyOfChannel = (c: { channel: string; accountId: string | null }) => `${c.channel}:${c.accountId ?? 'NONE'}`;

export function assembleReport(i: ReportInputs): ClosingReport {
  // ── Sales ──
  const collectedTotal = round2(i.collected.atCheckout + i.collected.laterSameDay + i.collected.corrections);
  // A sale of the date cancelled by its end is owed by nobody (0079).
  const owed = round2(i.sales.value - collectedTotal - i.cancellations.ofTheseSales);
  const netSalesValue = round2(i.sales.value - i.returns.netRefundDue - i.cancellations.value);

  // ── Money ──
  const channels: ReportChannel[] = i.channels.map((c) => {
    const key = keyOfChannel(c);
    const split = i.splits.get(key) ?? { todaysSales: 0, olderDebts: 0 };
    const inTotal = round2(c.salesIn + c.correctionsIn);
    const outTotal = round2(c.refundsOut + c.supplierOut + c.expensesOut + c.correctionsOut);
    return {
      key,
      channel: c.channel,
      accountId: c.accountId,
      label: c.labelSnapshot,
      isUnattributed: c.isUnattributed,
      countable: isCountable(c),
      in: { todaysSales: round2(split.todaysSales), olderDebts: round2(split.olderDebts), correctionsIn: c.correctionsIn, total: inTotal },
      out: { refunds: c.refundsOut, stockPurchases: c.supplierOut, expenses: c.expensesOut, correctionsOut: c.correctionsOut, total: outTotal },
      net: round2(inTotal - outTotal),
    };
  });
  const sum = (f: (c: ReportChannel) => number) => round2(channels.reduce((n, c) => n + f(c), 0));
  const totals = {
    in: sum((c) => c.in.total),
    out: sum((c) => c.out.total),
    net: sum((c) => c.net),
    todaysSales: sum((c) => c.in.todaysSales),
    olderDebts: sum((c) => c.in.olderDebts),
  };

  // ── Expenses ──
  const exp = (f: (l: ExpenseLine) => boolean) => round2(i.expenses.filter(f).reduce((n, l) => n + l.amount, 0));
  const categories = new Map<string, { amount: number; count: number }>();
  for (const l of i.expenses) {
    const c = categories.get(l.category) ?? { amount: 0, count: 0 };
    c.amount = round2(c.amount + l.amount);
    c.count += 1;
    categories.set(l.category, c);
  }
  const recorded = exp(() => true);
  const reversedBy = (f: (l: ExpenseReversalLine) => boolean) => round2(i.expenseReversals.filter(f).reduce((n, l) => n + l.amount, 0));
  const reversed = reversedBy(() => true);
  const expenses = {
    total: round2(recorded - reversed),
    recorded,
    reversed,
    reversals: i.expenseReversals,
    cash: exp((l) => l.method === 'cash'),
    account: exp((l) => l.method === 'account'),
    count: i.expenses.length,
    variable: exp((l) => l.expenseClass === 'variable'),
    fixed: exp((l) => l.expenseClass === 'fixed'),
    salaries: exp((l) => l.isSalary),
    byCategory: [...categories.entries()]
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category)),
    lines: i.expenses,
  };

  // ── Result (D7) ──
  const missingCostLines = i.sales.missingCostLines + i.returns.missingCostLines + i.cancellations.missingCostLines;
  const calculable = missingCostLines === 0;
  const costOfUnitsSold = round2(i.sales.cost - i.returns.costCredited - i.cancellations.cost);
  const grossProfit = round2(netSalesValue - costOfUnitsSold);
  const variableNet = round2(expenses.variable - reversedBy((l) => l.expenseClass === 'variable'));
  const fixedNet = round2(expenses.fixed - reversedBy((l) => l.expenseClass === 'fixed'));
  const result: ReportResult = {
    status: calculable ? 'ok' : 'cannot_calculate',
    reason: calculable ? null : 'cost_missing',
    missingCostLines,
    netSales: netSalesValue,
    costOfUnitsSold: calculable ? costOfUnitsSold : null,
    returnsCostCredited: calculable ? round2(i.returns.costCredited) : null,
    cancelledCostCredited: calculable ? round2(i.cancellations.cost) : null,
    grossProfit: calculable ? grossProfit : null,
    variableExpenses: variableNet,
    fixedExpenses: fixedNet,
    resultBeforeFixed: calculable ? round2(grossProfit - variableNet) : null,
    resultAfterExpenses: calculable ? round2(grossProfit - expenses.total) : null,
    scope: 'fixed_costs_on_due_date',
  };

  // ── Expected balances ──
  const cashRow = channels.find((c) => c.channel === 'cash')!;
  const cashCount = i.counts.get('cash:NONE') ?? null;
  const cashExpected = round2(i.opening.amount + cashRow.net);
  const cashVerification = cashCount?.verification ?? 'not_counted';
  const cashCounted = cashVerification === 'counted' ? cashCount!.counted : null;
  const accounts = channels
    .filter((c) => c.channel === 'account')
    .map((c) => {
      const s = i.counts.get(c.key) ?? null;
      const verification: Verification = c.countable ? (s?.verification ?? 'not_counted') : 'not_counted';
      const counted = verification === 'counted' ? s!.counted : null;
      return {
        key: c.key,
        accountId: c.accountId,
        label: c.label,
        in: c.in.total,
        out: c.out.total,
        expectedMovement: c.net,
        counted,
        difference: counted === null ? null : round2(counted - c.net),
        verification,
        basis: 'recorded_movement_not_balance' as const,
      };
    });

  // ── The close (D2) ──
  const verificationByKey = (c: ReportChannel): Verification =>
    c.channel === 'cash' ? cashVerification : (accounts.find((a) => a.key === c.key)?.verification ?? 'not_counted');
  const verdict = closeVerification(channels.map((c) => ({ key: c.key, countable: c.countable, verification: verificationByKey(c) })));

  // ── Warnings ──
  const warnings: ReportWarning[] = [];
  const unverifiedCountable = verdict.unverified;
  const stale = channels.filter((c) => c.countable && verificationByKey(c) === 'stale').map((c) => c.label);
  if (unverifiedCountable.length > 0) {
    warnings.push({ code: 'channels_not_verified', severity: 'warning', section: 'money', params: { count: unverifiedCountable.length } });
  }
  if (stale.length > 0) warnings.push({ code: 'channels_stale', severity: 'warning', section: 'money', params: { count: stale.length } });
  if (channels.some((c) => c.channel === 'account' && c.countable && (c.in.total !== 0 || c.out.total !== 0))) {
    warnings.push({ code: 'account_movement_not_balance', severity: 'info', section: 'money' });
  }
  const unattributed = channels.find((c) => c.isUnattributed && (c.in.total !== 0 || c.out.total !== 0));
  if (unattributed) warnings.push({ code: 'unattributed_money', severity: 'info', section: 'money', params: { amount: unattributed.net } });
  if (i.pending && i.pending.refundReports.count > 0) {
    warnings.push({ code: 'pending_refund_reports', severity: 'warning', section: 'money', params: { count: i.pending.refundReports.count, amount: i.pending.refundReports.amount } });
  }
  if (i.pending && i.pending.expenseReports.count > 0) {
    warnings.push({ code: 'pending_expense_reports', severity: 'info', section: 'expenses', params: { count: i.pending.expenseReports.count, amount: i.pending.expenseReports.amount } });
  }
  if (!calculable) warnings.push({ code: 'cost_missing', severity: 'warning', section: 'result', params: { count: missingCostLines } });
  if (i.opening.anchorDate === null) warnings.push({ code: 'no_counted_opening', severity: 'info', section: 'money' });
  else if (i.opening.carriedDays > 0) warnings.push({ code: 'opening_not_verified', severity: 'info', section: 'money', params: { anchorDate: i.opening.anchorDate, days: i.opening.carriedDays } });
  // An account's movement may be negative (more paid out than received); the drawer cannot hold less than nothing.
  if (cashExpected < 0) {
    warnings.push({ code: 'negative_expected', severity: 'warning', section: 'money', params: { amount: cashExpected } });
  }
  if (i.openDiscrepancies > 0) warnings.push({ code: 'open_discrepancies', severity: 'info', section: 'money', params: { count: i.openDiscrepancies } });
  if (i.previousDay?.needsReview) {
    warnings.push({ code: 'previous_day_needs_review', severity: 'info', section: 'day', params: { date: i.previousDay.businessDate } });
  }
  if (owed < -0.005) warnings.push({ code: 'overcollected', severity: 'warning', section: 'sales', params: { amount: -owed } });

  return {
    date: i.date,
    today: i.today,
    isToday: i.date === i.today,
    timezone: i.timezone,
    window: i.window,
    standing: i.standing,
    sales: {
      count: i.sales.count,
      value: round2(i.sales.value),
      itemsSold: i.sales.itemsSold,
      returns: {
        count: i.returns.count,
        grossRefund: round2(i.returns.grossRefund),
        adjustments: round2(i.returns.adjustments),
        netRefundDue: round2(i.returns.netRefundDue),
      },
      cancellations: { count: i.cancellations.count, value: round2(i.cancellations.value) },
      netSalesValue,
      collected: {
        atCheckout: round2(i.collected.atCheckout),
        laterSameDay: round2(i.collected.laterSameDay),
        corrections: round2(i.collected.corrections),
        total: collectedTotal,
      },
      owed,
    },
    money: { channels, totals, pending: i.pending },
    expenses,
    result,
    expected: {
      cash: {
        opening: i.opening,
        in: cashRow.in.total,
        out: cashRow.out.total,
        expected: cashExpected,
        counted: cashCounted,
        difference: cashCounted === null ? null : round2(cashCounted - cashExpected),
        verification: cashVerification,
        countedAt: cashVerification === 'counted' && cashCount?.countedAt ? cashCount.countedAt.toISOString() : null,
      },
      accounts,
    },
    warnings,
    close: { kind: i.closeKind, requiresAcknowledgement: verdict.requiresAcknowledgement, unverified: verdict.unverified, verified: verdict.verified },
  };
}

// ── Every total reconciles with its lines (§10) ──────────────────────────────

/**
 * The invariants the report must satisfy before anybody sees it. An empty list
 * means every total equals the sum of its own lines. A non-empty one is a defect
 * in the figures, never a rounding matter: the service logs it, warns, and a
 * close on such a report is refused.
 */
export function reportInvariants(
  r: ClosingReport,
  channels: ChannelRow[],
  splits: Map<string, ChannelSplit>,
  cancelledOfTheseSales = 0,
): string[] {
  const fail: string[] = [];
  const eq = (a: number, b: number) => Math.abs(round2(a) - round2(b)) < 0.005;
  if (!eq(r.sales.value, r.sales.collected.total + r.sales.owed + cancelledOfTheseSales)) fail.push('sales.value = collected + owed + own sales cancelled');
  if (!eq(r.sales.netSalesValue, r.sales.value - r.sales.returns.netRefundDue - r.sales.cancellations.value)) fail.push('net sales = value − returns − cancelled');
  for (const c of channels) {
    const key = keyOfChannel(c);
    const s = splits.get(key) ?? { todaysSales: 0, olderDebts: 0 };
    if (!eq(s.todaysSales + s.olderDebts, c.salesIn)) fail.push(`${key}: today's sales + older debts = sales in`);
  }
  if (!eq(r.money.totals.todaysSales + r.sales.collected.corrections, r.sales.collected.total)) {
    fail.push("Σ today's-sales money + their corrections = collected for these sales");
  }
  for (const c of r.money.channels) {
    if (!eq(c.net, c.in.total - c.out.total)) fail.push(`${c.key}: net = in − out`);
  }
  if (!eq(r.money.totals.net, r.money.totals.in - r.money.totals.out)) fail.push('money: net = in − out');
  const lines = r.expenses.lines.reduce((n, l) => n + l.amount, 0);
  if (!eq(r.expenses.recorded, lines)) fail.push('expenses.recorded = Σ lines');
  if (!eq(r.expenses.recorded, r.money.channels.reduce((n, c) => n + c.out.expenses, 0))) fail.push('expenses.recorded = Σ channel expenses out');
  if (!eq(r.expenses.recorded, r.expenses.cash + r.expenses.account)) fail.push('expenses: cash + account = recorded');
  if (!eq(r.expenses.reversed, r.expenses.reversals.reduce((n, l) => n + l.amount, 0))) fail.push('expenses.reversed = Σ reversals');
  if (!eq(r.expenses.total, r.expenses.recorded - r.expenses.reversed)) fail.push('expenses.total = recorded − reversed');
  if (!eq(r.expected.cash.expected, r.expected.cash.opening.amount + r.expected.cash.in - r.expected.cash.out)) fail.push('cash: expected = opening + in − out');
  if (r.result.status === 'ok') {
    if (!eq(r.result.grossProfit!, r.sales.netSalesValue - r.result.costOfUnitsSold!)) fail.push('gross profit = net sales − cost');
    if (!eq(r.result.resultAfterExpenses!, r.result.grossProfit! - r.expenses.total)) fail.push('result = gross profit − expenses');
  }
  return fail;
}

// ── Binding a close to what was seen (D5) ────────────────────────────────────

/**
 * A short fingerprint of every figure in the report. The phone sends back the
 * version it showed; if the day moved since, the close is refused with the new
 * report rather than signing off figures nobody looked at.
 */
export function reportVersion(r: ClosingReport): string {
  const figures = {
    s: r.sales,
    m: r.money.channels.map((c) => [c.key, c.in, c.out, c.net]),
    e: [r.expenses.total, r.expenses.lines.map((l) => [l.id, l.amount]), r.expenses.reversals.map((l) => [l.correctionId, l.amount])],
    x: [r.expected.cash.opening.amount, r.expected.cash.expected, r.expected.cash.verification, r.expected.accounts.map((a) => [a.key, a.expectedMovement, a.verification])],
    r: [r.result.status, r.result.costOfUnitsSold, r.result.grossProfit],
  };
  return createHash('sha256').update(JSON.stringify(figures)).digest('hex').slice(0, 16);
}

// ── Gating (D6) ──────────────────────────────────────────────────────────────

export type GatedReport = Omit<ClosingReport, 'sales' | 'expenses' | 'result' | 'close'> & {
  sales: ClosingReport['sales'] | null;
  expenses: ClosingReport['expenses'] | null;
  result: ReportResult | { status: 'hidden' };
  close: (ClosingReport['close'] & { canClose: boolean }) | null;
  sections: { sales: boolean; expenses: boolean; result: boolean; close: boolean };
};

/**
 * What one caller receives. Built explicitly — never by stripping keys afterwards —
 * so a section somebody may not see is absent from the response, not merely blank.
 * Money and expected balances: `closing.count`. Sales and expenses: `report.view`
 * or `closing.perform`. Result: additionally `cost.view`.
 */
export function gateReport(r: ClosingReport, p: ReportPermissions, canClose: boolean): GatedReport {
  const s = sectionsFor(p);
  const visible = (w: ReportWarning) =>
    w.section === 'money' || w.section === 'day' || (w.section === 'sales' && s.sales) || (w.section === 'expenses' && s.expenses) || (w.section === 'result' && s.result);
  return {
    ...r,
    sales: s.sales ? r.sales : null,
    expenses: s.expenses ? r.expenses : null,
    result: s.result ? r.result : { status: 'hidden' },
    warnings: r.warnings.filter(visible),
    close: s.close ? { ...r.close, canClose } : null,
    sections: s,
  };
}
