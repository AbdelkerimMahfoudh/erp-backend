import { shiftDate } from '../common/business-day';
import type { AgentDirection, LegAccount, LegDirection } from './agent-rules';

/**
 * The agent reports (D157): a day, a week, a month or a year of exchanges —
 * count, volume, cash received and paid, credit sent and received, commission —
 * by provider and by employee, with reversals and rebalancings on their own
 * lines. Pure: the service reads the rows of the period and hands them here.
 *
 * Every row is keyed by the business date it was STORED with (the company's
 * zone and the 06:00 rule applied when it was written), so a report and the
 * Daily closing cannot disagree about which day an exchange belongs to — and a
 * reversal belongs to the day it was made on, as its counter-legs do (docs/73
 * §4.3): an exchange stands in its own period's figures unless it was reversed
 * within that same period; a later reversal appears in the later period, on
 * the reversals line, and its commission comes off that period's commission.
 * A period that is over never changes afterwards.
 */

export type ReportPeriod = 'day' | 'week' | 'month' | 'year';
export const REPORT_PERIODS: readonly ReportPeriod[] = ['day', 'week', 'month', 'year'];

/** The business dates a period covers: the week is Monday to Sunday of the date; the year groups by month. */
export function periodRangeOf(period: ReportPeriod, date: string): { from: string; to: string } {
  if (period === 'day') return { from: date, to: date };
  if (period === 'week') {
    const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay(); // 0 = Sunday
    const from = shiftDate(date, -((weekday + 6) % 7));
    return { from, to: shiftDate(from, 6) };
  }
  if (period === 'month') {
    const from = `${date.slice(0, 7)}-01`;
    return { from, to: shiftDate(`${nextMonth(date.slice(0, 7))}-01`, -1) };
  }
  return { from: `${date.slice(0, 4)}-01-01`, to: `${date.slice(0, 4)}-12-31` };
}

function nextMonth(yearMonth: string): string {
  const year = Number(yearMonth.slice(0, 4));
  const month = Number(yearMonth.slice(5, 7));
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
}

export interface ReportTransaction {
  providerId: string;
  providerLabel: string;
  direction: AgentDirection;
  amount: number;
  commission: number;
  recordedById: string;
  recordedByName: string;
  /** The business date the exchange was recorded on. */
  businessDate: string;
  /** The business date its reversal was posted on (its counter-legs' day); null while it stands, or reversed after the period. */
  reversalDate: string | null;
}

export interface ReportRebalancingLeg {
  rebalancingId: string;
  account: LegAccount;
  direction: LegDirection;
  amount: number;
  businessDate: string;
}

export interface ExchangeTotals {
  /** Exchanges recorded in the period and still standing at its end. */
  count: number;
  volume: number;
  cashReceived: number;
  cashPaid: number;
  creditSent: number;
  creditReceived: number;
  /** Earned in the period: its standing exchanges' commission, less that of earlier exchanges reversed in it. */
  commission: number;
  /** Reversals made in the period, whatever day their exchange was recorded on: never in the figures above. */
  reversals: { count: number; volume: number; commission: number };
}

export interface ReportTotals extends ExchangeTotals {
  /** Never a transaction (A8): no count, no volume, no commission — their own line. */
  rebalancings: { count: number; cashIn: number; cashOut: number; floatIn: number; floatOut: number };
}

export interface ProviderTotals extends ExchangeTotals {
  providerId: string;
  label: string;
}

export interface EmployeeTotals {
  userId: string;
  name: string;
  count: number;
  volume: number;
  commission: number;
  reversals: { count: number };
}

export interface MonthTotals extends ReportTotals {
  month: string;
}

export interface AgentReport {
  period: ReportPeriod;
  from: string;
  to: string;
  totals: ReportTotals;
  byProvider: ProviderTotals[];
  byEmployee: EmployeeTotals[];
  /** The year only: each month of it, in the totals' shape. */
  byMonth?: MonthTotals[];
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const emptyExchanges = (): ExchangeTotals => ({
  count: 0,
  volume: 0,
  cashReceived: 0,
  cashPaid: 0,
  creditSent: 0,
  creditReceived: 0,
  commission: 0,
  reversals: { count: 0, volume: 0, commission: 0 },
});

/** A window of business dates, both ends included. */
interface Window {
  from: string;
  to: string;
}

const within = (date: string | null, w: Window): boolean => date !== null && date >= w.from && date <= w.to;

/** How one exchange counts in a window: standing in its figures, reversed in it, or not there at all. */
function placeOf(t: ReportTransaction, w: Window): 'standing' | 'reversed_here' | 'reversed_from_earlier' | 'absent' {
  if (within(t.reversalDate, w)) return within(t.businessDate, w) ? 'reversed_here' : 'reversed_from_earlier';
  return within(t.businessDate, w) ? 'standing' : 'absent';
}

function addExchange(into: ExchangeTotals, t: ReportTransaction, w: Window): void {
  const place = placeOf(t, w);
  if (place === 'absent') return;
  if (place !== 'standing') {
    into.reversals.count += 1;
    into.reversals.volume = round2(into.reversals.volume + t.amount);
    into.reversals.commission = round2(into.reversals.commission + t.commission);
    // Earned in an earlier period, which keeps it: it comes off this one, where it was given back.
    if (place === 'reversed_from_earlier') into.commission = round2(into.commission - t.commission);
    return;
  }
  into.count += 1;
  into.volume = round2(into.volume + t.amount);
  into.commission = round2(into.commission + t.commission);
  if (t.direction === 'cash_in_credit_out') {
    into.cashReceived = round2(into.cashReceived + t.amount);
    into.creditSent = round2(into.creditSent + t.amount);
  } else {
    into.cashPaid = round2(into.cashPaid + t.amount);
    into.creditReceived = round2(into.creditReceived + t.amount);
  }
}

function rebalancingTotals(legs: readonly ReportRebalancingLeg[]): ReportTotals['rebalancings'] {
  const sum = (account: LegAccount, direction: LegDirection) =>
    round2(legs.filter((l) => l.account === account && l.direction === direction).reduce((n, l) => n + l.amount, 0));
  return {
    count: new Set(legs.map((l) => l.rebalancingId)).size,
    cashIn: sum('cash', 'inflow'),
    cashOut: sum('cash', 'outflow'),
    floatIn: sum('provider', 'inflow'),
    floatOut: sum('provider', 'outflow'),
  };
}

function totalsOf(transactions: readonly ReportTransaction[], legs: readonly ReportRebalancingLeg[], w: Window): ReportTotals {
  const totals = emptyExchanges();
  for (const t of transactions) addExchange(totals, t, w);
  return { ...totals, rebalancings: rebalancingTotals(legs.filter((l) => within(l.businessDate, w))) };
}

/**
 * The report of a period from its rows: the exchanges recorded in it, and the
 * earlier ones reversed in it. Standing exchanges make the figures; reversals
 * are counted apart, on the day they were made (a reversal undid both the money
 * and the commission); a rebalancing is neither.
 */
export function aggregateAgentReport(input: {
  period: ReportPeriod;
  from: string;
  to: string;
  transactions: readonly ReportTransaction[];
  rebalancingLegs: readonly ReportRebalancingLeg[];
}): AgentReport {
  const period: Window = { from: input.from, to: input.to };
  const byProvider = new Map<string, ProviderTotals>();
  const byEmployee = new Map<string, EmployeeTotals>();
  for (const t of input.transactions) {
    const place = placeOf(t, period);
    if (place === 'absent') continue;
    const provider = byProvider.get(t.providerId) ?? { providerId: t.providerId, label: t.providerLabel, ...emptyExchanges() };
    addExchange(provider, t, period);
    byProvider.set(t.providerId, provider);
    // The employee who recorded it: their reversed exchanges are counted in the period the reversal was made.
    const employee = byEmployee.get(t.recordedById) ?? { userId: t.recordedById, name: t.recordedByName, count: 0, volume: 0, commission: 0, reversals: { count: 0 } };
    if (place === 'standing') {
      employee.count += 1;
      employee.volume = round2(employee.volume + t.amount);
      employee.commission = round2(employee.commission + t.commission);
    } else {
      employee.reversals.count += 1;
      if (place === 'reversed_from_earlier') employee.commission = round2(employee.commission - t.commission);
    }
    byEmployee.set(t.recordedById, employee);
  }
  const report: AgentReport = {
    period: input.period,
    from: input.from,
    to: input.to,
    totals: totalsOf(input.transactions, input.rebalancingLegs, period),
    byProvider: [...byProvider.values()].sort((a, b) => b.volume - a.volume || a.label.localeCompare(b.label)),
    byEmployee: [...byEmployee.values()].sort((a, b) => b.volume - a.volume || a.name.localeCompare(b.name)),
  };
  if (input.period === 'year') {
    // Each month that recorded, reversed or rebalanced something in the year, by the same rules as the year itself.
    const dates = [...input.transactions.flatMap((t) => [t.businessDate, t.reversalDate]), ...input.rebalancingLegs.map((l) => l.businessDate)];
    const months = new Set(dates.filter((d): d is string => within(d, period)).map((d) => d.slice(0, 7)));
    report.byMonth = [...months].sort().map((month) => ({ month, ...totalsOf(input.transactions, input.rebalancingLegs, periodRangeOf('month', `${month}-01`)) }));
  }
  return report;
}
