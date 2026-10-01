import { buildChannels, type MovementRow } from '../closing/channels';
import { assembleReport, gateReport, type ChannelCountState, type ReportInputs, type ReportPermissions } from '../closing/closing-report';
import { profit } from '../analytics/accounting-rules';
import { emptyInvoices, emptyReturns, type PeriodFigures } from '../analytics/period-figures';
import { stripFinancialFields } from '../common/interceptors/financial-fields';
import {
  dailyDocument,
  monthlyDocument,
  monthRange,
  REPORT_DOCUMENT_VERSION,
  type DailyReportSource,
  type MonthlyDocumentInput,
  type RefundSummarySource,
} from './report-documents';

/**
 * The report documents (docs/66) — the contract the in-app PDFs print.
 *
 * The daily document is built from a REAL report: `assembleReport` and `gateReport` run on a
 * worked day, exactly as `ClosingService.report()` runs them, so a change to the closing's
 * figures shows up here. Every figure the document carries is checked against arithmetic
 * done by hand below, never against the code under test.
 */

const BANKILY = 'b0000000-0000-7000-8000-000000000001';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const COST_KEYS = ['costOfUnitsSold', 'grossProfit', 'resultBeforeFixed', 'resultAfterExpenses', 'netOperatingProfit', 'netCogs', 'cogs', 'margin', 'profit'];

const IDENTITY = { company: 'Tech <Plus>', branch: 'Main Store', timezone: 'Africa/Nouakchott' };
const GENERATED = new Date('2026-10-01T19:30:00.000Z');

/**
 * Main Store, 2026-10-01.
 *   Sales: 3 invoices, 45 500, 7 items, recorded cost 36 250 (32 500 received for them).
 *   A sale of an earlier day cancelled today: 5 000, 1 item, cost 4 000.
 *   A return approved today: gross 9 000, adjustments 500 → 8 500 off; cost credited 7 000.
 *   Expenses: transport 800 + food 400 (variable, cash); rent 15 000 (fixed, due today, Bankily).
 *   Money: cash in 19 000, a refund confirmed in cash 6 000, the expenses; Bankily in 10 500, rent out.
 */
const movements: MovementRow[] = [
  { channel: 'cash', accountId: null, component: 'salesIn', amount: 15_000 },
  { channel: 'cash', accountId: null, component: 'salesIn', amount: 4_000 },
  { channel: 'account', accountId: BANKILY, component: 'salesIn', amount: 10_500 },
  { channel: 'cash', accountId: null, component: 'refundsOut', amount: 6_000 },
  { channel: 'cash', accountId: null, component: 'expensesOut', amount: 1_200 },
  { channel: 'account', accountId: BANKILY, component: 'expensesOut', amount: 15_000 },
];

function inputs(over: Partial<ReportInputs> = {}): ReportInputs {
  return {
    date: '2026-10-01',
    today: '2026-10-01',
    timezone: 'UTC',
    window: { startsAt: '2026-10-01T06:00:00.000Z', endsAt: '2026-10-02T06:00:00.000Z' },
    standing: 'open',
    sales: { count: 3, value: 45_500, itemsSold: 7, cost: 36_250, missingCostLines: 0 },
    returns: { count: 1, grossRefund: 9_000, adjustments: 500, netRefundDue: 8_500, costCredited: 7_000, missingCostLines: 0 },
    cancellations: { count: 1, value: 5_000, items: 1, cost: 4_000, missingCostLines: 0, ofTheseSales: 0 },
    collected: { atCheckout: 25_500, laterSameDay: 7_000, corrections: 0 },
    channels: buildChannels(movements, [{ id: BANKILY, label: 'Bankily', isActive: true, sortOrder: 1 }], 20_000),
    splits: new Map([
      ['cash:NONE', { todaysSales: 15_000, olderDebts: 4_000 }],
      [`account:${BANKILY}`, { todaysSales: 10_500, olderDebts: 0 }],
    ]),
    expenses: [
      { id: 'e1', category: 'Rent', expenseClass: 'fixed', isSalary: false, amount: 15_000, method: 'account', accountLabel: 'Bankily' },
      { id: 'e2', category: 'Transport', expenseClass: 'variable', isSalary: false, amount: 800, method: 'cash', accountLabel: null },
      { id: 'e3', category: 'Food', expenseClass: 'variable', isSalary: false, amount: 400, method: 'cash', accountLabel: null },
    ],
    expenseReversals: [],
    counts: new Map<string, ChannelCountState>([
      ['cash:NONE', { verification: 'counted', counted: 31_500, countedAt: new Date('2026-10-01T20:00:00Z'), skipReason: null }],
    ]),
    opening: { amount: 20_000, anchorDate: '2026-09-30', anchorVerified: true, carriedDays: 0 },
    pending: { refundReports: { count: 1, amount: 2_000 }, expenseReports: { count: 0, amount: 0 } },
    openDiscrepancies: 0,
    previousDay: { businessDate: '2026-09-30', standing: 'closed', needsReview: false },
    closeKind: 'first',
    ...over,
  };
}

const OWNER: ReportPermissions = { count: true, reportView: true, perform: true, costView: true };
const NO_COST: ReportPermissions = { count: true, reportView: true, perform: false, costView: false };

function source(perms: ReportPermissions = OWNER, over: Partial<ReportInputs> = {}, frozen: Partial<DailyReportSource> = {}): DailyReportSource {
  const gated = gateReport(assembleReport(inputs(over)), perms, perms.perform);
  return { ...gated, source: 'live', snapshot: null, ...frozen };
}

const REFUNDS: RefundSummarySource = {
  confirmed: { count: 1, total: 6_000 },
  awaitingConfirmation: { count: 1, amount: 2_000 },
  outstandingLiability: { count: 2, amount: 10_500 },
};

describe('the daily document', () => {
  const doc = dailyDocument({ identity: IDENTITY, report: source(), refunds: REFUNDS, receivables: { amount: 13_000, sales: 1 }, generatedAt: GENERATED });

  it('names the shop, the branch, the business date, its window and when it was generated — the contract version too', () => {
    expect(doc).toMatchObject({
      kind: 'daily',
      version: REPORT_DOCUMENT_VERSION,
      identity: IDENTITY,
      date: '2026-10-01',
      window: { startsAt: '2026-10-01T06:00:00.000Z', endsAt: '2026-10-02T06:00:00.000Z' },
      generatedAt: '2026-10-01T19:30:00.000Z',
      isToday: true,
      standing: 'open',
      basis: { source: 'live', closedAt: null, closedBy: null, reclosed: false, acknowledgedUnverified: false, reason: null },
    });
  });

  it('sales: invoices, the cancellation and the return each on their own line; net = 45 500 − 8 500 − 5 000', () => {
    expect(doc.sales).toEqual({
      invoices: { count: 3, value: 45_500, items: 7 },
      cancellations: { count: 1, value: 5_000, items: 1 },
      returns: { count: 1, value: 8_500 },
      net: { count: 3 - 1, items: 7 - 1, value: 45_500 - 8_500 - 5_000 },
      collected: 25_500 + 7_000,
      owed: 45_500 - 32_500,
    });
  });

  it('result: cost 36 250 − 7 000 − 4 000; gross profit; variable 1 200 before fixed; the rent due today after', () => {
    const net = 45_500 - 8_500 - 5_000;
    const cost = 36_250 - 7_000 - 4_000;
    expect(doc.result).toEqual({
      status: 'ok',
      netSales: net,
      costOfUnitsSold: cost,
      grossProfit: net - cost,
      variableExpenses: 1_200,
      resultBeforeFixed: net - cost - 1_200,
      fixedExpenses: 15_000,
      resultAfterExpenses: net - cost - 1_200 - 15_000,
    });
  });

  it('a result below zero stays below zero: 6 750 gross − 1 200 variable − 15 000 rent', () => {
    expect(doc.result.status === 'ok' && doc.result.resultAfterExpenses).toBe(-9_450);
  });

  it('expenses: the total, the variable and fixed parts and the categories — never a line id', () => {
    expect(doc.expenses).toMatchObject({ total: 16_200, recorded: 16_200, reversed: 0, variable: 1_200, fixed: 15_000, salaries: 0, count: 3 });
    expect(doc.expenses?.byCategory.map((c) => c.category).sort()).toEqual(['Food', 'Rent', 'Transport']);
  });

  it('money: recorded movement per channel, said to be no balance; the expected drawer and its count', () => {
    expect(doc.money.basis).toBe('recorded_movement_not_balance');
    expect(doc.money.channels).toEqual([
      { kind: 'cash', label: expect.any(String), in: 19_000, out: 7_200, net: 11_800 },
      { kind: 'account', label: 'Bankily', in: 10_500, out: 15_000, net: -4_500 },
    ]);
    expect(doc.money.totals).toEqual({ in: 29_500, out: 22_200, net: 7_300, olderDebts: 4_000 });
    expect(doc.checks[0]).toEqual({ kind: 'cash', label: expect.any(String), expected: 20_000 + 11_800, counted: 31_500, difference: -300, verification: 'counted' });
    expect(doc.checks[1]).toMatchObject({ kind: 'account', label: 'Bankily', expected: -4_500, counted: null, difference: null, verification: 'not_counted' });
  });

  it('refunds: what left (confirmed), what is only reported (no outflow) and what is still owed — apart', () => {
    expect(doc.refunds).toEqual({
      confirmed: { count: 1, amount: 6_000 },
      awaitingConfirmation: { count: 1, amount: 2_000 },
      outstanding: { count: 2, amount: 10_500 },
    });
    expect(doc.receivables).toEqual({ amount: 13_000, sales: 1 });
  });

  it('carries no id of any kind: no channel key, no account id, no expense or correction id', () => {
    const json = JSON.stringify(doc);
    expect(json).not.toMatch(UUID);
    for (const key of ['"key"', '"accountId"', '"id"', '"correctionId"', '"expenseId"', '"lines"', '"reversals"', 'skipReason']) expect(json).not.toContain(key);
  });

  it('warnings keep their code, severity and words, not their routing section', () => {
    expect(doc.warnings.length).toBeGreaterThan(0);
    expect(doc.warnings).toContainEqual({ code: 'pending_refund_reports', severity: 'warning', params: { count: 1, amount: 2_000 } });
    expect(JSON.stringify(doc.warnings)).not.toContain('"section"');
  });

  it('without cost.view: no result, and not one cost or profit key anywhere — before and after the global gating', () => {
    const hidden = dailyDocument({ identity: IDENTITY, report: source(NO_COST), refunds: REFUNDS, receivables: { amount: 0, sales: 0 }, generatedAt: GENERATED });
    expect(hidden.result).toEqual({ status: 'hidden' });
    expect(hidden.sections).toEqual({ sales: true, expenses: true, result: false, refunds: true });
    const json = JSON.stringify(hidden);
    for (const k of COST_KEYS) expect(json).not.toContain(`"${k}"`);
    expect(stripFinancialFields(hidden)).toEqual(hidden);
  });

  it('the cost gating strips every cost and profit key of an Owner document too — the second line of defence lines up', () => {
    const stripped = JSON.stringify(stripFinancialFields(doc));
    for (const k of ['costOfUnitsSold', 'grossProfit', 'resultBeforeFixed', 'resultAfterExpenses']) expect(stripped).not.toContain(`"${k}"`);
  });

  it('a result that cannot be calculated says so with the count of lines missing a cost', () => {
    const d = dailyDocument({
      identity: IDENTITY,
      report: source(OWNER, { sales: { count: 1, value: 1_000, itemsSold: 1, cost: 0, missingCostLines: 1 } }),
      refunds: null,
      receivables: { amount: 0, sales: 0 },
      generatedAt: GENERATED,
    });
    expect(d.result).toEqual({ status: 'cannot_calculate', missingCostLines: 1 });
    expect(d.refunds).toBeNull();
    expect(d.sections.refunds).toBe(false);
  });

  it('a closed day prints the figures it was closed on: when, by whom, and whether unchecked channels were acknowledged', () => {
    const d = dailyDocument({
      identity: IDENTITY,
      report: source(OWNER, { standing: 'closed', closeKind: 'already_locked' }, {
        source: 'snapshot',
        snapshot: { kind: 'reclosed', at: new Date('2026-10-01T21:04:00.000Z'), by: 'Amina', verification: { acknowledged: true, reason: 'Bankily app down' } },
      }),
      refunds: REFUNDS,
      receivables: { amount: 0, sales: 0 },
      generatedAt: GENERATED,
    });
    expect(d.standing).toBe('closed');
    expect(d.basis).toEqual({ source: 'snapshot', closedAt: '2026-10-01T21:04:00.000Z', closedBy: 'Amina', reclosed: true, acknowledgedUnverified: true, reason: 'Bankily app down' });
  });

  it('an empty day is all zeros, never absent', () => {
    const d = dailyDocument({
      identity: IDENTITY,
      report: source(OWNER, {
        sales: { count: 0, value: 0, itemsSold: 0, cost: 0, missingCostLines: 0 },
        returns: { count: 0, grossRefund: 0, adjustments: 0, netRefundDue: 0, costCredited: 0, missingCostLines: 0 },
        cancellations: { count: 0, value: 0, items: 0, cost: 0, missingCostLines: 0, ofTheseSales: 0 },
        collected: { atCheckout: 0, laterSameDay: 0, corrections: 0 },
        channels: buildChannels([], [], 0),
        splits: new Map(),
        expenses: [],
        counts: new Map(),
        opening: { amount: 0, anchorDate: null, anchorVerified: false, carriedDays: 0 },
        pending: { refundReports: { count: 0, amount: 0 }, expenseReports: { count: 0, amount: 0 } },
      }),
      refunds: { confirmed: { count: 0, total: 0 }, awaitingConfirmation: { count: 0, amount: 0 }, outstandingLiability: { count: 0, amount: 0 } },
      receivables: { amount: 0, sales: 0 },
      generatedAt: GENERATED,
    });
    expect(d.sales).toEqual({ invoices: { count: 0, value: 0, items: 0 }, cancellations: { count: 0, value: 0, items: 0 }, returns: { count: 0, value: 0 }, net: { count: 0, items: 0, value: 0 }, collected: 0, owed: 0 });
    expect(d.result).toMatchObject({ status: 'ok', netSales: 0, grossProfit: 0, resultAfterExpenses: 0 });
    expect(d.money.channels.map((c) => c.kind)).toEqual(['cash']);
  });

  it('a close stored before the defined counts falls back to the invoices it counted', () => {
    const s = source();
    const legacy = { ...s, sales: { ...s.sales!, salesCount: undefined as never, unitsSold: undefined as never } };
    const d = dailyDocument({ identity: IDENTITY, report: legacy, refunds: null, receivables: { amount: 0, sales: 0 }, generatedAt: GENERATED });
    expect(d.sales?.net).toEqual({ count: 3, items: 7, value: 32_000 });
  });

  it('is deterministic: the same report gives the same document', () => {
    const again = dailyDocument({ identity: IDENTITY, report: source(), refunds: REFUNDS, receivables: { amount: 13_000, sales: 1 }, generatedAt: GENERATED });
    expect(again).toEqual(doc);
  });
});

// ── Monthly ──────────────────────────────────────────────────────────────────

function day(over: { invoices?: Partial<PeriodFigures['invoices']>; cancellations?: Partial<PeriodFigures['cancellations']>; returns?: Partial<PeriodFigures['returns']>; expenses?: Partial<PeriodFigures['expenses']> }): PeriodFigures {
  const invoices = { ...emptyInvoices(), ...over.invoices };
  const cancellations = { ...emptyInvoices(), ...over.cancellations };
  const returns = { ...emptyReturns(), ...over.returns };
  const expenses = { recorded: 0, recordedCount: 0, reversed: 0, reversedCount: 0, net: 0, ...over.expenses };
  return {
    invoices,
    cancellations,
    returns,
    expenses,
    net: {
      salesValue: invoices.value - returns.value - cancellations.value,
      salesCount: invoices.count - cancellations.count,
      units: invoices.units - cancellations.units,
      phones: invoices.phones - cancellations.phones,
    },
  };
}

/**
 * September 2026 at Main Store, from the dated records:
 *   09-03  2 invoices, 120 000, 3 items
 *   09-14  1 invoice 80 000, 1 item; the 09-03 sale of 20 000 (1 item) cancelled
 *   09-20  a return approved: 30 000 net refund due
 *   09-30  only expenses (no sales line)
 * The rollups agree: revenue 200 000, cost 150 000 − 15 000 cancelled − 22 000 returned,
 * expenses 68 000 = variable 8 000 + rent 25 000 + salaries 35 000; refunds paid 30 000.
 */
const SEPT = new Map<string, PeriodFigures>([
  ['2026-09-20', day({ returns: { count: 1, value: 30_000, grossRefund: 30_000 } })],
  ['2026-09-03', day({ invoices: { count: 2, value: 120_000, units: 3 }, expenses: { recorded: 8_000, recordedCount: 2, net: 8_000 } })],
  ['2026-09-14', day({ invoices: { count: 1, value: 80_000, units: 1 }, cancellations: { count: 1, value: 20_000, units: 1 } })],
  ['2026-09-30', day({ expenses: { recorded: 60_000, recordedCount: 2, net: 60_000 } })],
]);

const SUMMARY: MonthlyDocumentInput['summary'] = {
  profit: profit({ grossSales: 200_000, returnsRevenue: 30_000, cogs: 150_000, returnsCogs: 22_000, cancelledRevenue: 20_000, cancelledCogs: 15_000, expenses: 68_000 }),
  expenseDetail: { total: 68_000, fixed: 60_000, salaries: 35_000, count: 4 },
  balances: { loansReceivable: 5_000, loansPayable: 12_000, consignmentBalance: 7_500 },
  cash: { inflow: 0, outflow: 0, net: 0, salesReceived: 200_000, refundsPaid: 30_000, supplierPaymentsConfirmed: 0, expensesCash: 0 },
};

function monthly(over: Partial<MonthlyDocumentInput> = {}) {
  return monthlyDocument({
    identity: IDENTITY,
    range: monthRange('2026-09', '2026-10-01'),
    summary: SUMMARY,
    days: SEPT,
    refunds: { confirmed: { count: 1, total: 30_000 }, awaitingConfirmation: { count: 0, amount: 0 }, outstandingLiability: { count: 1, amount: 4_000 } },
    receivables: { amount: 41_000, sales: 3 },
    costView: true,
    generatedAt: GENERATED,
    ...over,
  });
}

describe('the monthly document', () => {
  const doc = monthly();

  it('covers the whole of a past month and says so', () => {
    expect(doc).toMatchObject({ kind: 'monthly', version: REPORT_DOCUMENT_VERSION, month: '2026-09', from: '2026-09-01', to: '2026-09-30', complete: true, identity: IDENTITY });
    expect(doc.warnings).toEqual([]);
  });

  it('sales and items from the dated records: 3 invoices − 1 cancellation; 200 000 − 30 000 − 20 000', () => {
    expect(doc.sales).toEqual({
      invoices: { count: 3, value: 200_000, items: 4 },
      cancellations: { count: 1, value: 20_000, items: 1 },
      returns: { count: 1, value: 30_000 },
      net: { count: 2, items: 3, value: 150_000 },
    });
  });

  it('result: gross profit, variable expenses, then rent and other fixed and salaries apart, to the net result', () => {
    const netSales = 200_000 - 30_000 - 20_000;
    const cost = 150_000 - 22_000 - 15_000;
    const gross = netSales - cost;
    expect(doc.result).toEqual({
      status: 'ok',
      netSales,
      costOfUnitsSold: cost,
      grossProfit: gross,
      variableExpenses: 8_000,
      resultBeforeFixed: gross - 8_000,
      fixedExpenses: 25_000,
      salaries: 35_000,
      netOperatingProfit: gross - 8_000 - 25_000 - 35_000,
    });
    expect(doc.expenses).toEqual({ total: 68_000, variable: 8_000, fixedOther: 25_000, salaries: 35_000, count: 4 });
  });

  it('refunds and what is owed: confirmed outflow, liability, the branch’s open sales and the business’s loans and consignment', () => {
    expect(doc.refunds).toEqual({ confirmed: { count: 1, amount: 30_000 }, awaitingConfirmation: { count: 0, amount: 0 }, outstanding: { count: 1, amount: 4_000 } });
    expect(doc.receivables).toEqual({ sales: { amount: 41_000, sales: 3 }, loansReceivable: 5_000, loansPayable: 12_000, consignmentReceivable: 7_500 });
  });

  it('commissions are said to be unrecorded, never printed as zero', () => {
    expect(doc.commissions).toEqual({ recorded: false });
  });

  it('the day-by-day sales: chronological, only days with a sale, a cancellation or a return, adding up to the month', () => {
    expect(doc.days).toEqual([
      { date: '2026-09-03', count: 2, items: 3, netSales: 120_000 },
      { date: '2026-09-14', count: 0, items: 0, netSales: 60_000 },
      { date: '2026-09-20', count: 0, items: 0, netSales: -30_000 },
    ]);
    expect(doc.days.reduce((n, d) => n + d.netSales, 0)).toBe(doc.sales.net.value);
    expect(doc.days.reduce((n, d) => n + d.count, 0)).toBe(doc.sales.net.count);
  });

  it('without cost.view: the result is hidden and no cost or profit key exists; expenses stay', () => {
    const hidden = monthly({ costView: false });
    expect(hidden.result).toEqual({ status: 'hidden' });
    expect(hidden.sections.result).toBe(false);
    const json = JSON.stringify(hidden);
    for (const k of COST_KEYS) expect(json).not.toContain(`"${k}"`);
    expect(hidden.expenses.salaries).toBe(35_000);
  });

  it('the cost gating strips the Owner’s cost and profit keys as a second line', () => {
    const stripped = JSON.stringify(stripFinancialFields(doc));
    for (const k of ['costOfUnitsSold', 'grossProfit', 'resultBeforeFixed', 'netOperatingProfit']) expect(stripped).not.toContain(`"${k}"`);
  });

  it('two sources that disagree are printed as a disagreement, never smoothed over', () => {
    const lagging = monthly({ summary: { ...SUMMARY, profit: profit({ grossSales: 180_000, returnsRevenue: 30_000, cogs: 140_000, returnsCogs: 22_000, cancelledRevenue: 20_000, cancelledCogs: 15_000, expenses: 68_000 }) } });
    expect(lagging.warnings).toContainEqual({ code: 'figures_disagree', severity: 'error', params: { count: 2 } });
    const refundsApart = monthly({ summary: { ...SUMMARY, cash: { ...SUMMARY.cash, refundsPaid: 0 } } });
    expect(refundsApart.warnings).toContainEqual({ code: 'figures_disagree', severity: 'error', params: { count: 1 } });
  });

  it('the month still running: to today, and said to be month to date', () => {
    const running = monthly({ range: monthRange(undefined, '2026-10-01'), days: new Map(), summary: { ...SUMMARY, profit: profit({ grossSales: 0, returnsRevenue: 0, cogs: 0, returnsCogs: 0, expenses: 0 }), expenseDetail: { total: 0, fixed: 0, salaries: 0, count: 0 }, cash: { ...SUMMARY.cash, refundsPaid: 0 } }, refunds: null });
    expect(running).toMatchObject({ month: '2026-10', from: '2026-10-01', to: '2026-10-01', complete: false });
    expect(running.warnings).toEqual([{ code: 'month_in_progress', severity: 'info', params: { to: '2026-10-01' } }]);
    expect(running.sales.net).toEqual({ count: 0, items: 0, value: 0 });
    expect(running.days).toEqual([]);
    expect(running.refunds).toBeNull();
  });

  it('large figures stay exact to the ouguiya', () => {
    const big = new Map([['2026-09-10', day({ invoices: { count: 812, value: 987_654_321.5, units: 1_204 }, expenses: { recorded: 123_456_789.25, net: 123_456_789.25 } })]]);
    const d = monthly({
      days: big,
      summary: {
        ...SUMMARY,
        profit: profit({ grossSales: 987_654_321.5, returnsRevenue: 0, cogs: 765_432_100.25, returnsCogs: 0, expenses: 123_456_789.25 }),
        expenseDetail: { total: 123_456_789.25, fixed: 100_000_000, salaries: 60_000_000, count: 90 },
        cash: { ...SUMMARY.cash, refundsPaid: 30_000 },
      },
    });
    expect(d.warnings).toEqual([]);
    expect(d.result).toMatchObject({ grossProfit: 222_222_221.25, variableExpenses: 23_456_789.25, fixedExpenses: 40_000_000, salaries: 60_000_000, netOperatingProfit: 98_765_432 });
  });

  it('carries no id', () => {
    expect(JSON.stringify(doc)).not.toMatch(UUID);
  });
});

describe('the month a report covers', () => {
  it('a past month is whole, to its last day — 28, 29, 30 or 31', () => {
    expect(monthRange('2026-02', '2026-10-01')).toEqual({ month: '2026-02', from: '2026-02-01', to: '2026-02-28', complete: true });
    expect(monthRange('2028-02', '2028-03-15')).toEqual({ month: '2028-02', from: '2028-02-01', to: '2028-02-29', complete: true });
    expect(monthRange('2026-09', '2026-10-01').to).toBe('2026-09-30');
    expect(monthRange('2025-12', '2026-01-02').to).toBe('2025-12-31');
  });

  it('the current month runs to today’s business date — the last day included only once it is today', () => {
    expect(monthRange('2026-10', '2026-10-17')).toEqual({ month: '2026-10', from: '2026-10-01', to: '2026-10-17', complete: false });
    expect(monthRange(undefined, '2026-10-31')).toEqual({ month: '2026-10', from: '2026-10-01', to: '2026-10-31', complete: false });
  });

  it('refuses a month that has not begun and anything that is not YYYY-MM', () => {
    expect(() => monthRange('2026-11', '2026-10-31')).toThrow(RangeError);
    for (const bad of ['2026-13', '2026-00', '2026-9', '26-09', '2026-09-01', '', '1999-12', 'abcd-ef']) expect(() => monthRange(bad, '2026-10-01')).toThrow(RangeError);
  });
});
