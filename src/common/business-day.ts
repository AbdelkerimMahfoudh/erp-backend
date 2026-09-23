/**
 * The business day (docs/50 §3.1, docs/21 2026-09-23).
 *
 * A shop's day does not end at midnight: a phone sold at 01:30 belongs to the
 * evening it was part of. So a business date is the LOCAL calendar date of an
 * instant, minus one day when the local time is before 06:00. The rule is
 * pure and lives here alone; every writer stores the date it produced next to
 * the immutable instant, and every reader keys on the stored date.
 *
 * The local hour is read with `Intl`, never derived by subtracting six hours
 * from the instant, so a zone with daylight saving still cuts at its own 06:00.
 * Timezones are IANA names (`Africa/Nouakchott`); an unknown one is refused
 * loudly rather than silently read as UTC, because a wrong day boundary is a
 * wrong closing.
 */

export const BUSINESS_DAY_START_HOUR = 6;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface LocalParts {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      throw new Error(`Unknown timezone "${timezone}"`);
    }
    formatters.set(timezone, f);
  }
  return f;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    formatterFor(timezone);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock reading of an instant in a zone. */
export function localParts(instant: Date, timezone: string): LocalParts {
  const parts = formatterFor(timezone).formatToParts(instant);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const yyyy = String(get('year')).padStart(4, '0');
  const mm = String(get('month')).padStart(2, '0');
  const dd = String(get('day')).padStart(2, '0');
  // Some ICU builds print midnight as "24" under h23; normalise.
  const hour = get('hour') % 24;
  return { date: `${yyyy}-${mm}-${dd}`, hour, minute: get('minute'), second: get('second') };
}

/** Calendar arithmetic on a YYYY-MM-DD, with no timezone involved. */
export function shiftDate(date: string, days: number): string {
  if (!DATE_RE.test(date)) throw new Error(`Not a date: ${date}`);
  const at = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return new Date(at + days * 86_400_000).toISOString().slice(0, 10);
}

export function isDateString(value: unknown): value is string {
  return typeof value === 'string' && DATE_RE.test(value) && shiftDate(value, 0) === value;
}

/** The business date an instant belongs to, by the 06:00 rule. */
export function businessDateOf(instant: Date, timezone: string): string {
  const local = localParts(instant, timezone);
  return local.hour < BUSINESS_DAY_START_HOUR ? shiftDate(local.date, -1) : local.date;
}

/** The local calendar date of an instant — what a wall clock would say. */
export function localDateOf(instant: Date, timezone: string): string {
  return localParts(instant, timezone).date;
}

/** Minutes east of UTC that the zone observes at this instant. */
export function offsetMinutes(instant: Date, timezone: string): number {
  const local = localParts(instant, timezone);
  const asUtc = Date.UTC(
    Number(local.date.slice(0, 4)),
    Number(local.date.slice(5, 7)) - 1,
    Number(local.date.slice(8, 10)),
    local.hour,
    local.minute,
    local.second,
  );
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/**
 * The instant at which a local wall-clock time occurs.
 *
 * Two passes over the zone's offset: the first guess assumes the offset in
 * force at the UTC reading, the second corrects it if the guess fell on the
 * other side of a transition. Good enough for a day boundary; a wall time that
 * does not exist (a spring-forward gap) resolves to the instant after the gap.
 */
export function localInstant(date: string, hour: number, timezone: string): Date {
  const naive = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hour);
  let guess = new Date(naive - offsetMinutes(new Date(naive), timezone) * 60_000);
  const second = new Date(naive - offsetMinutes(guess, timezone) * 60_000);
  if (second.getTime() !== guess.getTime()) guess = second;
  return guess;
}

export interface DayWindow {
  /** Inclusive: the first instant of the business day (06:00 local). */
  start: Date;
  /** Exclusive: 06:00 local of the following calendar date. */
  end: Date;
}

/** The instants a business date spans, for tables keyed on a timestamp. */
export function dayWindow(date: string, timezone: string): DayWindow {
  return {
    start: localInstant(date, BUSINESS_DAY_START_HOUR, timezone),
    end: localInstant(shiftDate(date, 1), BUSINESS_DAY_START_HOUR, timezone),
  };
}

export type HomePeriod = 'today' | 'week' | 'month';

export const HOME_PERIODS: readonly HomePeriod[] = ['today', 'week', 'month'];

export interface DateRange {
  from: string;
  to: string;
}

/**
 * The exact business dates a Home period covers, ending on the current one.
 * "7 days" is the current business date and the six before it; "This month"
 * runs from the first of the current business date's month.
 */
export function periodRange(period: HomePeriod, businessDate: string): DateRange {
  if (period === 'today') return { from: businessDate, to: businessDate };
  if (period === 'week') return { from: shiftDate(businessDate, -6), to: businessDate };
  return { from: `${businessDate.slice(0, 7)}-01`, to: businessDate };
}

/** Every date from `from` to `to`, inclusive. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = shiftDate(d, 1)) out.push(d);
  return out;
}

/**
 * Whether the local wall clock has passed midnight but not yet 06:00 — the
 * only time an Owner may start the next business date early (docs/50 §3.2).
 */
export function isBeforeDayStart(instant: Date, timezone: string, businessDate: string): boolean {
  const local = localParts(instant, timezone);
  return local.date > businessDate && local.hour < BUSINESS_DAY_START_HOUR;
}
