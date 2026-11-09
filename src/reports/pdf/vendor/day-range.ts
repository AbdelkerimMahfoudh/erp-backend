// GENERATED from erp-mobile lib/day-range.ts at 5dcfb74 by scripts/sync-report-pdf.mjs — do not edit; sync again.
/* eslint-disable */
// @ts-nocheck
/**
 * How much of a span of days has to be said. Pure — the words themselves are
 * chosen in `format.ts`, with the active locale.
 *
 * One day is that day. Inside one month only the first day's number is
 * repeated ("14–18 Sep 2026"); inside one year both ends carry a month
 * ("28 Aug – 3 Sep 2026"); across years both are said in full.
 */
export type DayRangeShape = 'day' | 'month' | 'year' | 'full';

/**
 * A `YYYY-MM-DD` as the calendar day it names, at local midnight — so formatting it
 * gives that day on any phone, whatever its timezone. Parsing it as UTC midnight
 * (`${d}T00:00:00Z`) and formatting in local time put a phone west of UTC on the
 * day before (docs/54).
 */
export function calendarDate(date: string): Date {
  return new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
}

export function dayRangeShape(from: string, to: string): DayRangeShape {
  if (from === to) return 'day';
  if (from.slice(0, 7) === to.slice(0, 7)) return 'month';
  if (from.slice(0, 4) === to.slice(0, 4)) return 'year';
  return 'full';
}
