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
 * Daily closing cannot disagree about which day an exchange belongs to.
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
  status: 'completed' | 'reversed';
  recordedById: string;
  recordedByName: string;
  businessDate: string;
}

export interface ReportRebalancingLeg {
  rebalancingId: string;
  account: LegAccount;
  direction: LegDirection;
  amount: number;
  businessDate: string;
}

export interface ExchangeTotals {
  /** Completed, unreversed exchanges of the period. */
  count: number;
  volume: number;
  cashReceived: number;
  cashPaid: number;
  creditSent: number;
  creditReceived: number;
  commission: number;
  /** Exchanges of the period that were reversed, apart: never in the figures above. */
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

function addExchange(into: ExchangeTotals, t: ReportTransaction): void {
  if (t.status === 'reversed') {
    into.reversals.count += 1;
    into.reversals.volume = round2(into.reversals.volume + t.amount);
    into.reversals.commission = round2(into.reversals.commission + t.commission);
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

function totalsOf(transactions: readonly ReportTransaction[], legs: readonly ReportRebalancingLeg[]): ReportTotals {
  const totals = emptyExchanges();
  for (const t of transactions) addExchange(totals, t);
  return { ...totals, rebalancings: rebalancingTotals(legs) };
}

/**
 * The report of a period from its rows. Completed exchanges make the figures;
 * reversed ones are counted apart (a reversal undid both the money and the
 * commission); a rebalancing is neither.
 */
export function aggregateAgentReport(input: {
  period: ReportPeriod;
  from: string;
  to: string;
  transactions: readonly ReportTransaction[];
  rebalancingLegs: readonly ReportRebalancingLeg[];
}): AgentReport {
  const byProvider = new Map<string, ProviderTotals>();
  const byEmployee = new Map<string, EmployeeTotals>();
  for (const t of input.transactions) {
    const provider = byProvider.get(t.providerId) ?? { providerId: t.providerId, label: t.providerLabel, ...emptyExchanges() };
    addExchange(provider, t);
    byProvider.set(t.providerId, provider);
    const employee = byEmployee.get(t.recordedById) ?? { userId: t.recordedById, name: t.recordedByName, count: 0, volume: 0, commission: 0, reversals: { count: 0 } };
    if (t.status === 'reversed') employee.reversals.count += 1;
    else {
      employee.count += 1;
      employee.volume = round2(employee.volume + t.amount);
      employee.commission = round2(employee.commission + t.commission);
    }
    byEmployee.set(t.recordedById, employee);
  }
  const report: AgentReport = {
    period: input.period,
    from: input.from,
    to: input.to,
    totals: totalsOf(input.transactions, input.rebalancingLegs),
    byProvider: [...byProvider.values()].sort((a, b) => b.volume - a.volume || a.label.localeCompare(b.label)),
    byEmployee: [...byEmployee.values()].sort((a, b) => b.volume - a.volume || a.name.localeCompare(b.name)),
  };
  if (input.period === 'year') {
    const months = new Set<string>([...input.transactions.map((t) => t.businessDate.slice(0, 7)), ...input.rebalancingLegs.map((l) => l.businessDate.slice(0, 7))]);
    report.byMonth = [...months]
      .sort()
      .map((month) => ({
        month,
        ...totalsOf(
          input.transactions.filter((t) => t.businessDate.startsWith(month)),
          input.rebalancingLegs.filter((l) => l.businessDate.startsWith(month)),
        ),
      }));
  }
  return report;
}
