import { BUSINESS_DAY_START_HOUR, datesBetween, localParts, shiftDate, type DateRange } from '../common/business-day';

/**
 * The bars under Home's sales value (docs/50 §3.5), pure.
 *
 * One rule: the bars are the sales value, cut up — never a second query. So
 * the sum of what is plotted equals the figure above it to the cent, and a
 * test can prove it. Today is cut by local hour from 06:00; seven days by
 * business date; a month into the weeks of the month (1–7, 8–14, 15–21,
 * 22–28, 29–end).
 */

export interface Bar {
  key: string;
  /** What the axis prints: an hour ("06"), a date, or a span ("1–7"). */
  label: string;
  from: string;
  to: string;
  value: number;
}

export interface SaleTick {
  soldAt: Date;
  total: number;
}

export interface DayValue {
  date: string;
  value: number;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** The 24 hours of a business day, starting at its 06:00. */
export function hourlyBars(sales: SaleTick[], timezone: string, businessDate: string): Bar[] {
  const hours: number[] = [];
  for (let i = 0; i < 24; i += 1) hours.push((BUSINESS_DAY_START_HOUR + i) % 24);
  const sums = new Map<number, number>(hours.map((h) => [h, 0]));
  for (const s of sales) {
    const h = localParts(s.soldAt, timezone).hour;
    sums.set(h, (sums.get(h) ?? 0) + s.total);
  }
  return hours.map((h) => {
    const hh = String(h).padStart(2, '0');
    // Hours before 06:00 belong to the following calendar date.
    const date = h < BUSINESS_DAY_START_HOUR ? shiftDate(businessDate, 1) : businessDate;
    return { key: `${date}T${hh}`, label: hh, from: `${date}T${hh}:00`, to: `${date}T${hh}:59`, value: round2(sums.get(h) ?? 0) };
  });
}

/** One bar per business date of the range, in order, zero where nothing sold. */
export function dailyBars(days: DayValue[], range: DateRange): Bar[] {
  const byDate = new Map(days.map((d) => [d.date, d.value]));
  return datesBetween(range.from, range.to).map((date) => ({
    key: date,
    label: date,
    from: date,
    to: date,
    value: round2(byDate.get(date) ?? 0),
  }));
}

/** The weeks of a month: 1–7, 8–14, 15–21, 22–28 and 29 to the end, cut at the range's last day. */
export function groupedBars(days: DayValue[], range: DateRange): Bar[] {
  const month = range.from.slice(0, 7);
  const lastDay = Number(range.to.slice(8, 10));
  const bars: Bar[] = [];
  for (let start = 1; start <= lastDay; start += 7) {
    const end = Math.min(start + 6, start >= 29 ? 31 : start + 6, lastDay);
    const from = `${month}-${String(start).padStart(2, '0')}`;
    const to = `${month}-${String(end).padStart(2, '0')}`;
    const value = days.filter((d) => d.date >= from && d.date <= to).reduce((n, d) => n + d.value, 0);
    bars.push({ key: `${from}_${to}`, label: start === end ? String(start) : `${start}–${end}`, from, to, value: round2(value) });
  }
  return bars;
}

/** The only promise that matters: what is plotted adds up to what is stated. */
export function barsSumTo(bars: Bar[], total: number): boolean {
  return round2(bars.reduce((n, b) => n + b.value, 0)) === round2(total);
}
