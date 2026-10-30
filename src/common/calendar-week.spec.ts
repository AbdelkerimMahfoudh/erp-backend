import { businessDateOf, calendarWeekOf, datesBetween, dayWindow, periodRange } from './business-day';
import { aggregateAgentReport, effectsOfLegs, periodRangeOf, type ReportRebalancingLeg, type ReportTransaction } from '../agent/agent-report-rules';
import { exchangeLegs } from '../agent/agent-rules';
import { barsSumTo, dailyBars } from '../analytics/home-series';

/**
 * The calendar week on the store's clock (D225, owner's final decision): the business day starts at
 * 06:00 Africa/Nouakchott (UTC+0, no daylight saving); "this week" is Monday 06:00 through the next
 * Monday 05:59:59.999; month and year cut at 06:00 too.
 *
 * WEEK_TABLE is copied, literal for literal, into the app's `lib/calendar-week.test.ts`: both
 * suites assert the same instants against the same weeks, so the phone and the server cannot
 * disagree about which week a sale belongs to. Run also under `TZ=America/New_York` and
 * `TZ=Asia/Tokyo`: the process zone must change nothing.
 */

const ZONE = 'Africa/Nouakchott';

// ---- shared table (identical in erp-mobile lib/calendar-week.test.ts) ----
const WEEK_TABLE = [
  { at: '2026-11-02T05:59:00.000Z', businessDate: '2026-11-01', weekFrom: '2026-10-26', weekTo: '2026-11-01', weekStart: '2026-10-26T06:00:00.000Z', weekEnd: '2026-11-02T05:59:59.999Z', monthStart: '2026-11-01T06:00:00.000Z', yearStart: '2026-01-01T06:00:00.000Z' },
  { at: '2026-11-02T06:00:00.000Z', businessDate: '2026-11-02', weekFrom: '2026-11-02', weekTo: '2026-11-08', weekStart: '2026-11-02T06:00:00.000Z', weekEnd: '2026-11-09T05:59:59.999Z', monthStart: '2026-11-01T06:00:00.000Z', yearStart: '2026-01-01T06:00:00.000Z' },
  { at: '2026-11-01T23:30:00.000Z', businessDate: '2026-11-01', weekFrom: '2026-10-26', weekTo: '2026-11-01', weekStart: '2026-10-26T06:00:00.000Z', weekEnd: '2026-11-02T05:59:59.999Z', monthStart: '2026-11-01T06:00:00.000Z', yearStart: '2026-01-01T06:00:00.000Z' },
  { at: '2026-11-02T03:00:00.000Z', businessDate: '2026-11-01', weekFrom: '2026-10-26', weekTo: '2026-11-01', weekStart: '2026-10-26T06:00:00.000Z', weekEnd: '2026-11-02T05:59:59.999Z', monthStart: '2026-11-01T06:00:00.000Z', yearStart: '2026-01-01T06:00:00.000Z' },
  { at: '2026-11-01T05:59:00.000Z', businessDate: '2026-10-31', weekFrom: '2026-10-26', weekTo: '2026-11-01', weekStart: '2026-10-26T06:00:00.000Z', weekEnd: '2026-11-02T05:59:59.999Z', monthStart: '2026-10-01T06:00:00.000Z', yearStart: '2026-01-01T06:00:00.000Z' },
  { at: '2026-11-01T06:00:00.000Z', businessDate: '2026-11-01', weekFrom: '2026-10-26', weekTo: '2026-11-01', weekStart: '2026-10-26T06:00:00.000Z', weekEnd: '2026-11-02T05:59:59.999Z', monthStart: '2026-11-01T06:00:00.000Z', yearStart: '2026-01-01T06:00:00.000Z' },
  { at: '2026-12-01T05:59:00.000Z', businessDate: '2026-11-30', weekFrom: '2026-11-30', weekTo: '2026-12-06', weekStart: '2026-11-30T06:00:00.000Z', weekEnd: '2026-12-07T05:59:59.999Z', monthStart: '2026-11-01T06:00:00.000Z', yearStart: '2026-01-01T06:00:00.000Z' },
  { at: '2026-12-01T06:00:00.000Z', businessDate: '2026-12-01', weekFrom: '2026-11-30', weekTo: '2026-12-06', weekStart: '2026-11-30T06:00:00.000Z', weekEnd: '2026-12-07T05:59:59.999Z', monthStart: '2026-12-01T06:00:00.000Z', yearStart: '2026-01-01T06:00:00.000Z' },
  { at: '2027-01-01T05:59:00.000Z', businessDate: '2026-12-31', weekFrom: '2026-12-28', weekTo: '2027-01-03', weekStart: '2026-12-28T06:00:00.000Z', weekEnd: '2027-01-04T05:59:59.999Z', monthStart: '2026-12-01T06:00:00.000Z', yearStart: '2026-01-01T06:00:00.000Z' },
  { at: '2027-01-01T06:00:00.000Z', businessDate: '2027-01-01', weekFrom: '2026-12-28', weekTo: '2027-01-03', weekStart: '2026-12-28T06:00:00.000Z', weekEnd: '2027-01-04T05:59:59.999Z', monthStart: '2027-01-01T06:00:00.000Z', yearStart: '2027-01-01T06:00:00.000Z' },
  { at: '2027-01-04T05:59:59.999Z', businessDate: '2027-01-03', weekFrom: '2026-12-28', weekTo: '2027-01-03', weekStart: '2026-12-28T06:00:00.000Z', weekEnd: '2027-01-04T05:59:59.999Z', monthStart: '2027-01-01T06:00:00.000Z', yearStart: '2027-01-01T06:00:00.000Z' },
  { at: '2027-01-04T06:00:00.000Z', businessDate: '2027-01-04', weekFrom: '2027-01-04', weekTo: '2027-01-10', weekStart: '2027-01-04T06:00:00.000Z', weekEnd: '2027-01-11T05:59:59.999Z', monthStart: '2027-01-01T06:00:00.000Z', yearStart: '2027-01-01T06:00:00.000Z' },
] as const;
// ---- end shared table ----

const ms = (iso: string) => new Date(iso).getTime();

/** The instants a range of business dates spans: 06:00 of the first through 05:59:59.999 of the day after the last. */
const windowOf = (from: string, to: string) => ({ start: dayWindow(from, ZONE).start, end: new Date(dayWindow(to, ZONE).end.getTime() - 1) });

describe('the shared week table (server and app assert the same rows)', () => {
  it.each(WEEK_TABLE.map((r) => [r.at, r]))('%s', (_at, row) => {
    const date = businessDateOf(new Date(row.at), ZONE);
    expect(date).toBe(row.businessDate);
    expect(calendarWeekOf(date)).toEqual({ from: row.weekFrom, to: row.weekTo });
    expect(periodRangeOf('week', date)).toEqual({ from: row.weekFrom, to: row.weekTo });
    const week = windowOf(row.weekFrom, row.weekTo);
    expect(week.start.toISOString()).toBe(row.weekStart);
    expect(week.end.toISOString()).toBe(row.weekEnd);
    expect(ms(row.weekStart) <= ms(row.at) && ms(row.at) <= ms(row.weekEnd)).toBe(true);
    // Month and year windows open at 06:00 of their first day.
    expect(dayWindow(periodRange('month', date).from, ZONE).start.toISOString()).toBe(row.monthStart);
    expect(dayWindow(periodRangeOf('year', date).from, ZONE).start.toISOString()).toBe(row.yearStart);
  });

  it('the process timezone changes nothing (the zone is the company\'s, read with Intl)', () => {
    // jest runs in one process: the same table must also pass with TZ=America/New_York and TZ=Asia/Tokyo set on the command line.
    for (const row of WEEK_TABLE) expect(businessDateOf(new Date(row.at), ZONE)).toBe(row.businessDate);
  });
});

describe('the 06:00 cut at week, month and year boundaries', () => {
  it('Monday 05:59 belongs to the previous week; Monday 06:00 starts the new one', () => {
    expect(calendarWeekOf(businessDateOf(new Date('2026-11-02T05:59:00.000Z'), ZONE))).toEqual({ from: '2026-10-26', to: '2026-11-01' });
    expect(calendarWeekOf(businessDateOf(new Date('2026-11-02T06:00:00.000Z'), ZONE))).toEqual({ from: '2026-11-02', to: '2026-11-08' });
  });

  it('Sunday 23:30 and Monday 03:00 are the same business day of the same (previous) week', () => {
    const sunday = businessDateOf(new Date('2026-11-01T23:30:00.000Z'), ZONE);
    const monday = businessDateOf(new Date('2026-11-02T03:00:00.000Z'), ZONE);
    expect(sunday).toBe('2026-11-01');
    expect(monday).toBe(sunday);
    expect(calendarWeekOf(monday)).toEqual(calendarWeekOf(sunday));
  });

  it('the 1st of the month at 05:59 is still last month; 06:00 opens the new month — inside one week', () => {
    expect(periodRange('month', businessDateOf(new Date('2026-12-01T05:59:00.000Z'), ZONE))).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(periodRange('month', businessDateOf(new Date('2026-12-01T06:00:00.000Z'), ZONE))).toEqual({ from: '2026-12-01', to: '2026-12-01' });
    expect(calendarWeekOf('2026-11-30')).toEqual(calendarWeekOf('2026-12-01'));
  });

  it('January 1st at 05:59 is still last year; 06:00 opens the new year — inside one week', () => {
    expect(periodRangeOf('year', businessDateOf(new Date('2027-01-01T05:59:00.000Z'), ZONE))).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(periodRangeOf('year', businessDateOf(new Date('2027-01-01T06:00:00.000Z'), ZONE))).toEqual({ from: '2027-01-01', to: '2027-12-31' });
    expect(calendarWeekOf('2026-12-31')).toEqual({ from: '2026-12-28', to: '2027-01-03' });
    expect(calendarWeekOf('2027-01-01')).toEqual({ from: '2026-12-28', to: '2027-01-03' });
  });
});

describe('a week is exactly its seven business days', () => {
  const weeks = [
    { from: '2026-10-26', to: '2026-11-01' },
    { from: '2026-11-30', to: '2026-12-06' },
    { from: '2026-12-28', to: '2027-01-03' },
  ];

  it.each(weeks.map((w) => [w.from, w]))('the seven day windows of %s tile the week window with no gap and no overlap', (_from, w) => {
    const days = datesBetween(w.from, w.to).map((d) => dayWindow(d, ZONE));
    expect(days).toHaveLength(7);
    expect(days[0].start.getTime()).toBe(dayWindow(w.from, ZONE).start.getTime());
    for (let i = 1; i < days.length; i += 1) expect(days[i].start.getTime()).toBe(days[i - 1].end.getTime());
    expect(days[6].end.getTime() - days[0].start.getTime()).toBe(7 * 86_400_000);
    expect(windowOf(w.from, w.to).end.getTime() + 1).toBe(days[6].end.getTime());
  });

  it('Home\'s weekly bars are its seven days and add up to the week\'s sales value', () => {
    const week = calendarWeekOf('2026-12-31');
    const days = [
      { date: '2026-12-27', value: 999 }, // the Sunday before: not this week
      { date: '2026-12-28', value: 100.1 },
      { date: '2026-12-31', value: 200.2 },
      { date: '2027-01-01', value: 300.3 },
      { date: '2027-01-03', value: 50 },
      { date: '2027-01-04', value: 777 }, // the Monday after: next week
    ];
    const inWeek = days.filter((d) => d.date >= week.from && d.date <= week.to);
    const bars = dailyBars(inWeek, week);
    expect(bars.map((b) => b.key)).toEqual(datesBetween(week.from, week.to));
    expect(barsSumTo(bars, 650.6)).toBe(true);
  });

  /** An exchange stamped at an instant, keyed on the business date it would be stored with. */
  const at = (iso: string, amount: number, commission: number, over: Partial<ReportTransaction> = {}): ReportTransaction => ({
    providerId: 'p1',
    providerLabel: 'Bankily',
    direction: 'cash_in_credit_out',
    amount,
    commission,
    recordedById: 'u1',
    recordedByName: 'Aicha',
    businessDate: businessDateOf(new Date(iso), ZONE),
    reversalDate: null,
    effects: effectsOfLegs(exchangeLegs({ direction: 'cash_in_credit_out', amount, commission, providerId: 'p1' })),
    ...over,
  });

  it('the agent report\'s week totals equal the sum of its seven day reports, edges by the 06:00 cut', () => {
    const transactions = [
      at('2026-12-28T05:59:59.999Z', 1_000, 10), // Sunday 27th's day: the week before
      at('2026-12-28T06:00:00.000Z', 2_000, 20), // first instant of the week
      at('2026-12-31T23:30:00.000Z', 3_000, 30), // New Year's Eve night…
      at('2027-01-01T03:00:00.000Z', 4_000, 40), // …is still Thursday 31st's day
      at('2027-01-01T06:00:00.000Z', 5_000, 50, { direction: 'cash_out_credit_in', effects: effectsOfLegs(exchangeLegs({ direction: 'cash_out_credit_in', amount: 5_000, commission: 50, providerId: 'p1' })) }),
      at('2027-01-02T12:00:00.000Z', 600, 6, { reversalDate: '2027-01-02' }), // reversed the same day
      at('2027-01-04T05:59:59.999Z', 7_000, 70), // last instant of the week
      at('2027-01-04T06:00:00.000Z', 8_000, 80), // next week
    ];
    const rebalancingLegs: ReportRebalancingLeg[] = [
      { rebalancingId: 'r1', account: 'cash', direction: 'outflow', amount: 10_000, businessDate: '2026-12-29' },
      { rebalancingId: 'r1', account: 'provider', direction: 'inflow', amount: 10_000, businessDate: '2026-12-29' },
      { rebalancingId: 'r2', account: 'cash', direction: 'inflow', amount: 500, businessDate: '2027-01-04' },
    ];
    const week = periodRangeOf('week', '2026-12-31');
    const weekly = aggregateAgentReport({ period: 'week', ...week, transactions, rebalancingLegs }).totals;
    const daily = datesBetween(week.from, week.to).map((d) => aggregateAgentReport({ period: 'day', from: d, to: d, transactions, rebalancingLegs }).totals);
    expect(daily).toHaveLength(7);
    const sum = (pick: (t: (typeof daily)[number]) => number) => Math.round(daily.reduce((n, t) => n + pick(t), 0) * 100) / 100;

    expect(weekly.count).toBe(5);
    expect(weekly.volume).toBe(21_000);
    for (const pick of [
      (t: typeof weekly) => t.count,
      (t: typeof weekly) => t.volume,
      (t: typeof weekly) => t.commission,
      (t: typeof weekly) => t.cashReceived,
      (t: typeof weekly) => t.cashPaid,
      (t: typeof weekly) => t.creditSent,
      (t: typeof weekly) => t.creditReceived,
      (t: typeof weekly) => t.reversals.count,
      (t: typeof weekly) => t.reversals.volume,
      (t: typeof weekly) => t.rebalancings.cashOut,
      (t: typeof weekly) => t.rebalancings.floatIn,
      (t: typeof weekly) => t.rebalancings.cashIn,
    ]) {
      expect(sum(pick)).toBe(pick(weekly));
    }
  });
});
