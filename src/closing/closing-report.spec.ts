import { buildChannels, type MovementRow } from './channels';
import { NOT_VERIFIED_AT_CLOSE } from './closing-lifecycle';
import {
  assembleReport,
  gateReport,
  reportInvariants,
  reportVersion,
  type ChannelCountState,
  type ChannelSplit,
  type ExpenseLine,
  type ReportInputs,
} from './closing-report';

/**
 * A realistic worked day (docs/51 §3), and every line total recomputed INDEPENDENTLY
 * from the raw movements below — by plain arithmetic here, not by the code under test.
 *
 * Main Store, business date 2026-09-24. Accounts: Bankily, Masrivi.
 *
 * Sales of the date
 *   S1  phone          18 000   cash 10 000 + Bankily 8 000 at the till (split tender)   cost 14 000
 *   S2  phone          25 000   cash 5 000 at the till; 7 000 by Masrivi later the same day;
 *                               13 000 still owed                                        cost 21 000
 *   S3  5 cables       2 500    Bankily 2 500 at the till                                cost 1 250
 * Money on the date that is not the date's sales
 *   an older debt (sale of 2026-09-20) collected in cash                4 000
 *   a refund CONFIRMED in cash (approved on an earlier day)             6 000
 *   a refund APPROVED today, reported by an employee, NOT confirmed     8 500   (a claim — moves nothing)
 *   a return approved today: gross 9 000, adjustments 500, net 8 500, cost credited 7 000
 *   stock bought and paid by Bankily                                   12 000
 *   expenses confirmed: transport 800 cash, food 400 cash (variable); rent 15 000 by Masrivi, due today (fixed)
 *   a payment of yesterday recorded as cash that really reached Bankily, reclassified today   3 000
 * Opening drawer: counted 20 000 at the close of 2026-09-23.
 */
const BANKILY = 'b0000000-0000-7000-8000-000000000001';
const MASRIVI = 'b0000000-0000-7000-8000-000000000002';
const accounts = [
  { id: BANKILY, label: 'Bankily', isActive: true, sortOrder: 1 },
  { id: MASRIVI, label: 'Masrivi', isActive: true, sortOrder: 2 },
];

const cash = (component: MovementRow['component'], amount: number): MovementRow => ({ channel: 'cash', accountId: null, component, amount });
const acct = (accountId: string, component: MovementRow['component'], amount: number): MovementRow => ({ channel: 'account', accountId, component, amount });

// The raw movements, one row per recorded money event (what `channelMovements` returns after grouping).
const movements: MovementRow[] = [
  cash('salesIn', 10_000), // S1 cash
  cash('salesIn', 5_000), // S2 cash at the till
  cash('salesIn', 4_000), // older debt
  acct(BANKILY, 'salesIn', 8_000), // S1 Bankily
  acct(BANKILY, 'salesIn', 2_500), // S3
  acct(MASRIVI, 'salesIn', 7_000), // S2 later the same day
  cash('refundsOut', 6_000),
  acct(BANKILY, 'supplierOut', 12_000),
  cash('expensesOut', 800),
  cash('expensesOut', 400),
  acct(MASRIVI, 'expensesOut', 15_000),
  cash('correctionsOut', 3_000),
  acct(BANKILY, 'correctionsIn', 3_000),
];
const OPENING = 20_000;

const splits = new Map<string, ChannelSplit>([
  ['cash:NONE', { todaysSales: 15_000, olderDebts: 4_000 }],
  [`account:${BANKILY}`, { todaysSales: 10_500, olderDebts: 0 }],
  [`account:${MASRIVI}`, { todaysSales: 7_000, olderDebts: 0 }],
]);

const expenses: ExpenseLine[] = [
  { id: 'e1', category: 'Rent', expenseClass: 'fixed', isSalary: false, amount: 15_000, method: 'account', accountLabel: 'Masrivi' },
  { id: 'e2', category: 'Transport', expenseClass: 'variable', isSalary: false, amount: 800, method: 'cash', accountLabel: null },
  { id: 'e3', category: 'Food', expenseClass: 'variable', isSalary: false, amount: 400, method: 'cash', accountLabel: null },
];

function inputs(over: Partial<ReportInputs> = {}): ReportInputs {
  const channels = buildChannels(movements, accounts, OPENING);
  return {
    date: '2026-09-24',
    today: '2026-09-24',
    timezone: 'UTC',
    window: { startsAt: '2026-09-24T06:00:00.000Z', endsAt: '2026-09-25T06:00:00.000Z' },
    standing: 'counting',
    sales: { count: 3, value: 45_500, itemsSold: 7, cost: 36_250, missingCostLines: 0 },
    returns: { count: 1, grossRefund: 9_000, adjustments: 500, netRefundDue: 8_500, costCredited: 7_000, missingCostLines: 0 },
    collected: { atCheckout: 25_500, laterSameDay: 7_000 },
    channels,
    splits,
    expenses,
    counts: new Map<string, ChannelCountState>([
      ['cash:NONE', { verification: 'counted', counted: 28_500, countedAt: new Date('2026-09-24T21:00:00Z'), skipReason: null }],
      [`account:${MASRIVI}`, { verification: 'skipped', counted: null, countedAt: new Date('2026-09-24T21:01:00Z'), skipReason: 'App down' }],
    ]),
    opening: { amount: OPENING, anchorDate: '2026-09-23', anchorVerified: true, carriedDays: 0 },
    pending: { refundReports: { count: 1, amount: 8_500 }, expenseReports: { count: 0, amount: 0 } },
    openDiscrepancies: 0,
    previousDay: { businessDate: '2026-09-23', standing: 'closed', needsReview: false },
    closeKind: 'first',
    ...over,
  };
}

// ── The independent recomputation ────────────────────────────────────────────
const sum = (rows: MovementRow[]) => rows.reduce((n, r) => n + r.amount, 0);
const of = (pred: (r: MovementRow) => boolean) => sum(movements.filter(pred));
const IN = (r: MovementRow) => r.component === 'salesIn' || r.component === 'correctionsIn';
const isCash = (r: MovementRow) => r.channel === 'cash';

describe('a worked day, recomputed independently', () => {
  const report = assembleReport(inputs());
  const channels = buildChannels(movements, accounts, OPENING);

  it('reconciles: every total equals the sum of its own lines', () => {
    expect(reportInvariants(report, channels, splits)).toEqual([]);
  });

  it('sales: 3 sales, 45 500; 32 500 collected for them (25 500 at the till + 7 000 later the same day); 13 000 still owed', () => {
    expect(report.sales.count).toBe(3);
    expect(report.sales.value).toBe(18_000 + 25_000 + 2_500);
    expect(report.sales.collected).toEqual({ atCheckout: 10_000 + 8_000 + 5_000 + 2_500, laterSameDay: 7_000, total: 32_500 });
    expect(report.sales.owed).toBe(45_500 - 32_500);
    // A split tender is counted once in sales value, and once per channel in money — never twice anywhere.
    expect(report.sales.itemsSold).toBe(1 + 1 + 5);
  });

  it('returns are their own line: the net refund due reduces sales value, never the till', () => {
    expect(report.sales.returns).toEqual({ count: 1, grossRefund: 9_000, adjustments: 500, netRefundDue: 8_500 });
    expect(report.sales.netSalesValue).toBe(45_500 - 8_500);
  });

  it('money by channel: in, out and net, with the older debt apart from today’s sales', () => {
    const c = report.money.channels.find((x) => x.key === 'cash:NONE')!;
    expect(c.in).toEqual({ todaysSales: 15_000, olderDebts: 4_000, correctionsIn: 0, total: of((r) => isCash(r) && IN(r)) });
    expect(c.out.total).toBe(of((r) => isCash(r) && !IN(r)));
    expect(c.out).toEqual({ refunds: 6_000, stockPurchases: 0, expenses: 1_200, correctionsOut: 3_000, total: 10_200 });
    expect(c.net).toBe(19_000 - 10_200);

    const b = report.money.channels.find((x) => x.accountId === BANKILY)!;
    expect(b.in).toEqual({ todaysSales: 10_500, olderDebts: 0, correctionsIn: 3_000, total: 13_500 });
    expect(b.out).toEqual({ refunds: 0, stockPurchases: 12_000, expenses: 0, correctionsOut: 0, total: 12_000 });
    expect(b.net).toBe(1_500);

    const m = report.money.channels.find((x) => x.accountId === MASRIVI)!;
    expect(m.net).toBe(7_000 - 15_000);

    expect(report.money.totals).toEqual({
      in: of(IN),
      out: of((r) => !IN(r)),
      net: of(IN) - of((r) => !IN(r)),
      todaysSales: 32_500,
      olderDebts: 4_000,
    });
  });

  it('a reported refund is not money: the pending claim is a warning and in no channel', () => {
    expect(report.money.pending?.refundReports).toEqual({ count: 1, amount: 8_500 });
    expect(report.money.channels.reduce((n, c) => n + c.out.refunds, 0)).toBe(6_000);
    expect(report.warnings.map((w) => w.code)).toContain('pending_refund_reports');
  });

  it('expenses: 16 200 confirmed to this date — a fixed rent on its due date, never a refund or the stock bought', () => {
    expect(report.expenses.total).toBe(15_000 + 800 + 400);
    expect(report.expenses.cash).toBe(1_200);
    expect(report.expenses.account).toBe(15_000);
    expect(report.expenses.variable).toBe(1_200);
    expect(report.expenses.fixed).toBe(15_000);
    expect(report.expenses.byCategory[0]).toEqual({ category: 'Rent', amount: 15_000, count: 1 });
    // Stock purchasing (12 000) is money out, never an expense and never cost of units sold.
    expect(report.expenses.total).not.toBe(15_000 + 800 + 400 + 12_000);
  });

  it('result: gross profit 7 750; 6 550 before the fixed rent; −8 450 after every expense recorded to the date', () => {
    const netSales = 45_500 - 8_500;
    const cost = 14_000 + 21_000 + 1_250 - 7_000;
    expect(report.result.status).toBe('ok');
    expect(report.result.netSales).toBe(netSales);
    expect(report.result.costOfUnitsSold).toBe(cost);
    expect(report.result.grossProfit).toBe(netSales - cost);
    expect(report.result.resultBeforeFixed).toBe(netSales - cost - 1_200);
    expect(report.result.resultAfterExpenses).toBe(netSales - cost - 16_200);
    expect(report.result.scope).toBe('fixed_costs_on_due_date');
  });

  it('expected balances: the drawer is opening + cash in − cash out; an account is recorded movement, never a balance', () => {
    expect(report.expected.cash.opening.amount).toBe(OPENING);
    expect(report.expected.cash.expected).toBe(OPENING + of((r) => isCash(r) && IN(r)) - of((r) => isCash(r) && !IN(r)));
    expect(report.expected.cash.expected).toBe(28_800);
    // A real count stays a count, with its difference.
    expect(report.expected.cash).toMatchObject({ counted: 28_500, difference: -300, verification: 'counted' });
    const bankily = report.expected.accounts.find((a) => a.accountId === BANKILY)!;
    expect(bankily).toMatchObject({ expectedMovement: 1_500, counted: null, difference: null, verification: 'not_counted', basis: 'recorded_movement_not_balance' });
    const masrivi = report.expected.accounts.find((a) => a.accountId === MASRIVI)!;
    // A person's skip is not a verification, and it is never shown as matched or zero.
    expect(masrivi).toMatchObject({ expectedMovement: -8_000, counted: null, difference: null, verification: 'skipped' });
  });

  it('closing it needs an acknowledgement for the two accounts nobody checked; the counted drawer needs none', () => {
    expect(report.close.verified).toEqual(['cash:NONE']);
    expect(report.close.unverified.sort()).toEqual([`account:${BANKILY}`, `account:${MASRIVI}`].sort());
    expect(report.close.requiresAcknowledgement).toBe(true);
    expect(report.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['channels_not_verified', 'account_movement_not_balance']));
  });
});

describe('what cannot be calculated is said, never zeroed', () => {
  it('one sold line with no recorded cost makes the whole result "cannot calculate yet"', () => {
    const r = assembleReport(inputs({ sales: { count: 3, value: 45_500, itemsSold: 7, cost: 22_250, missingCostLines: 1 } }));
    expect(r.result.status).toBe('cannot_calculate');
    expect(r.result.reason).toBe('cost_missing');
    expect(r.result.missingCostLines).toBe(1);
    for (const k of ['costOfUnitsSold', 'grossProfit', 'resultBeforeFixed', 'resultAfterExpenses', 'returnsCostCredited'] as const) {
      expect(r.result[k]).toBeNull();
    }
    expect(r.warnings.map((w) => w.code)).toContain('cost_missing');
  });

  it('a return whose line had no cost does the same', () => {
    const r = assembleReport(inputs({ returns: { count: 1, grossRefund: 9_000, adjustments: 500, netRefundDue: 8_500, costCredited: 0, missingCostLines: 1 } }));
    expect(r.result.status).toBe('cannot_calculate');
    expect(r.result.grossProfit).toBeNull();
  });

  it('no counted opening yet is said, and the drawer starts from zero rather than a guess', () => {
    const r = assembleReport(inputs({ opening: { amount: 0, anchorDate: null, anchorVerified: false, carriedDays: 0 } }));
    expect(r.expected.cash.opening.anchorDate).toBeNull();
    expect(r.warnings.map((w) => w.code)).toContain('no_counted_opening');
  });

  it('a drawer below zero is flagged', () => {
    const r = assembleReport(inputs({ opening: { amount: -20_000, anchorDate: null, anchorVerified: false, carriedDays: 0 } }));
    expect(r.expected.cash.expected).toBeLessThan(0);
    expect(r.warnings.map((w) => w.code)).toContain('negative_expected');
  });
});

describe('closing without a physical check (docs/51 D2)', () => {
  it('a channel closed without checking reads "not verified" — never counted, matched or zero', () => {
    const r = assembleReport(
      inputs({
        counts: new Map<string, ChannelCountState>([
          ['cash:NONE', { verification: 'not_verified', counted: null, countedAt: new Date(), skipReason: NOT_VERIFIED_AT_CLOSE }],
        ]),
      }),
    );
    expect(r.expected.cash).toMatchObject({ counted: null, difference: null, verification: 'not_verified' });
    expect(r.expected.cash.expected).toBe(28_800);
  });

  it('a count taken before the day was reopened is stale: it proves nothing about the drawer now', () => {
    const r = assembleReport(
      inputs({ counts: new Map<string, ChannelCountState>([['cash:NONE', { verification: 'stale', counted: 28_500, countedAt: new Date(), skipReason: null }]]) }),
    );
    expect(r.expected.cash).toMatchObject({ counted: null, difference: null, verification: 'stale' });
    expect(r.close.unverified).toContain('cash:NONE');
    expect(r.warnings.map((w) => w.code)).toContain('channels_stale');
  });

  it('every channel counted: no acknowledgement is needed', () => {
    const r = assembleReport(
      inputs({
        counts: new Map<string, ChannelCountState>([
          ['cash:NONE', { verification: 'counted', counted: 28_800, countedAt: new Date(), skipReason: null }],
          [`account:${BANKILY}`, { verification: 'counted', counted: 1_500, countedAt: new Date(), skipReason: null }],
          [`account:${MASRIVI}`, { verification: 'counted', counted: -8_000, countedAt: new Date(), skipReason: null }],
        ]),
      }),
    );
    expect(r.close.requiresAcknowledgement).toBe(false);
    expect(r.expected.accounts.every((a) => a.difference === 0)).toBe(true);
  });
});

describe('who sees what (docs/51 D6)', () => {
  const full = assembleReport(inputs());
  const all = { count: true, reportView: true, perform: true, costView: true };

  it('the Owner sees every section and may close', () => {
    const g = gateReport(full, all, true);
    expect(g.sections).toEqual({ sales: true, expenses: true, result: true, close: true });
    expect(g.result).toMatchObject({ status: 'ok', grossProfit: 7_750 });
    expect(g.close?.canClose).toBe(true);
  });

  it('a manager without cost.view sees sales, money and expenses — and no cost or profit anywhere in the response', () => {
    const g = gateReport(full, { count: true, reportView: true, perform: false, costView: false }, false);
    expect(g.sales?.value).toBe(45_500);
    expect(g.expenses?.total).toBe(16_200);
    expect(g.result).toEqual({ status: 'hidden' });
    expect(g.close).toBeNull();
    const text = JSON.stringify(g);
    for (const k of ['costOfUnitsSold', 'grossProfit', 'resultAfterExpenses', 'resultBeforeFixed', 'returnsCostCredited', 'cost_missing']) {
      expect(text).not.toContain(k);
    }
  });

  it('somebody who may only count sees the money and the expected balances, not sales or expenses', () => {
    const g = gateReport(full, { count: true, reportView: false, perform: false, costView: true }, false);
    expect(g.sales).toBeNull();
    expect(g.expenses).toBeNull();
    expect(g.result).toEqual({ status: 'hidden' });
    expect(g.money.channels.length).toBe(3);
    expect(g.warnings.every((w) => w.section === 'money' || w.section === 'day')).toBe(true);
  });

  it('a delegate (closing.perform) sees what they close, and the result only with cost.view', () => {
    const g = gateReport(full, { count: true, reportView: false, perform: true, costView: true }, true);
    expect(g.sections).toEqual({ sales: true, expenses: true, result: true, close: true });
    const noCost = gateReport(full, { count: true, reportView: false, perform: true, costView: false }, true);
    expect(noCost.result).toEqual({ status: 'hidden' });
  });
});

describe('a close is bound to the figures that were seen (docs/51 D5)', () => {
  it('the same figures give the same version; any change of a figure gives another', () => {
    const a = reportVersion(assembleReport(inputs()));
    expect(reportVersion(assembleReport(inputs()))).toBe(a);
    expect(reportVersion(assembleReport(inputs({ sales: { count: 4, value: 46_500, itemsSold: 8, cost: 37_000, missingCostLines: 0 } })))).not.toBe(a);
    const moreCash = buildChannels([...movements, cash('salesIn', 1_000)], accounts, OPENING);
    expect(reportVersion(assembleReport(inputs({ channels: moreCash })))).not.toBe(a);
  });
});

describe('the invariants catch figures that do not add up', () => {
  it('a split that disagrees with the channel is reported, not hidden', () => {
    const broken = new Map(splits);
    broken.set('cash:NONE', { todaysSales: 15_000, olderDebts: 3_000 });
    const channels = buildChannels(movements, accounts, OPENING);
    const r = assembleReport(inputs({ splits: broken }));
    expect(reportInvariants(r, channels, broken)).toEqual(expect.arrayContaining(["cash:NONE: today's sales + older debts = sales in"]));
  });
});
