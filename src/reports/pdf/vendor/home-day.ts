// GENERATED from erp-mobile lib/home-day.ts at 5dcfb74 by scripts/sync-report-pdf.mjs — do not edit; sync again.
/* eslint-disable */
// @ts-nocheck
/**
 * What Home and the Closing screens may work out for themselves (docs/50).
 *
 *   node lib/home-day.test.ts
 *
 * Every figure, every date and every bar comes from the server: the business
 * date is the branch's, the ranges are exact, and the bars already add up to
 * the sales value. What is left to the phone is words — which catalogue key
 * names a day's standing, how a bar is labelled, what "refreshed" means — and
 * one privacy rule: an identifier on Home is only ever its last four digits.
 *
 * Imports nothing, so it runs under bare node.
 */

export type HomePeriod = 'today' | 'week' | 'month';

/**
 * The word an arrival's day takes, from the STORE's calendar: its date and "today"
 * both come from the server in the store's timezone, so a phone set to another zone
 * cannot move a phone received late last night into "Today" (docs/54).
 */
export type ArrivalDay = 'today' | 'yesterday' | 'date';

export function arrivalDay(receivedLocalDate: string, storeToday: string): ArrivalDay {
  if (receivedLocalDate === storeToday) return 'today';
  if (receivedLocalDate === previousDate(storeToday)) return 'yesterday';
  return 'date';
}

/** Calendar arithmetic on a YYYY-MM-DD, with no timezone involved. */
function previousDate(date: string): string {
  const at = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return new Date(at - 86_400_000).toISOString().slice(0, 10);
}

export const HOME_PERIODS: readonly HomePeriod[] = ['today', 'week', 'month'];

/**
 * `inactive`: a past business date on which nothing at all was recorded — no
 * sale, payment, count, opening or close (docs/51 D8). Not an overdue closing.
 */
export type DayStanding = 'open' | 'counting' | 'counted' | 'closed' | 'reopened' | 'needs_review' | 'inactive';

export type StandingTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/** The word and the colour for a day's standing — the word always travels with the colour. */
export function standingKey(standing: DayStanding): string {
  return `closing.standing.${standing}`;
}

export function standingTone(standing: DayStanding): StandingTone {
  switch (standing) {
    case 'closed':
      return 'success';
    case 'reopened':
    case 'needs_review':
      return 'warning';
    case 'counted':
      return 'info';
    case 'counting':
      return 'info';
    default:
      return 'neutral';
  }
}

export interface BarLike {
  key: string;
  label: string;
  from: string;
  to: string;
  value: number;
}

/**
 * The tick values of the bar axis: zero, a round step, and its multiples up to
 * just above the tallest bar. A round step is one people read without
 * thinking — 1 000, 2 000, 5 000 — never 1 337.
 */
export function axisTicks(max: number, count = 2): number[] {
  if (!(max > 0)) return [0];
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const candidates = [1, 2, 2.5, 5, 10].map((m) => m * magnitude);
  const step = candidates.find((c) => c >= rough) ?? candidates[candidates.length - 1];
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) ticks.push(Math.round(v * 100) / 100);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

/** "2k" for the axis; whole numbers below a thousand. */
export function shortAmount(value: number): string {
  if (value >= 1_000_000) return `${trimZero(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimZero(value / 1_000)}k`;
  return String(Math.round(value));
}

function trimZero(n: number): string {
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/**
 * Which bars carry a printed label. Twenty-four hours do not fit on a phone,
 * so every third hour is printed and the rest keep their value for the
 * screen reader; seven days and the weeks of a month are all printed.
 */
export function labelledEvery(unit: 'hour' | 'day' | 'week', width: number): number {
  if (unit === 'hour') return width < 360 ? 4 : 3;
  return 1;
}

/** The last four digits of an identifier, however it was masked upstream. */
export function lastFour(identifier: string): string {
  const digits = identifier.replace(/\D/g, '');
  return digits.slice(-4);
}

/** True when a full IMEI-length run of digits appears — never allowed on Home. */
export function looksLikeFullIdentifier(text: string): boolean {
  return /\d{15}/.test(text.replace(/[\s-]/g, ''));
}

/**
 * How Home describes the age of what it shows. Fresh within a minute; then
 * the relative time; offline is said separately so a stale figure is never
 * mistaken for a live one.
 */
export type Freshness = 'now' | 'stale';

export function freshness(fetchedAt: number | null | undefined, now: number = Date.now(), freshMs = 60_000): Freshness | null {
  if (!fetchedAt) return null;
  return now - fetchedAt <= freshMs ? 'now' : 'stale';
}

/**
 * The reopen sheet's choices, as the server offers them: the safe default
 * first and selected; the early start only when the server included it.
 */
export type ReopenMode = 'continue' | 'start_new';

export function reopenOptions(offered: readonly ReopenMode[]): { mode: ReopenMode; selected: boolean }[] {
  const modes = offered.length > 0 ? offered : (['continue'] as const);
  return modes.map((mode, i) => ({ mode, selected: i === 0 }));
}

/**
 * What "Open the boutique" asks before it records anything (docs/56). Before
 * 06:00 the store's calendar date has moved on but the business date has not:
 * the Owner, offered `start_new`, chooses between the two days; anybody else
 * is told which business day the opening — and every sale after it — belongs
 * to. After 06:00 there is nothing to ask. The dates are the server's.
 */
export type OpeningPrompt = 'choice' | 'notice' | 'none';

export function openingPrompt(offered: readonly ReopenMode[] | undefined, calendarDate: string, businessDate: string): OpeningPrompt {
  if ((offered ?? []).includes('start_new')) return 'choice';
  return calendarDate !== businessDate ? 'notice' : 'none';
}

/**
 * "+12 %", "−8 %" or "0 %" for a comparison the server supplied; null when it
 * supplied none — a zero base is no comparison, and a figure from nowhere is
 * never printed (docs/56).
 */
export function changeText(changePct: number | null | undefined): string | null {
  if (typeof changePct !== 'number' || !Number.isFinite(changePct)) return null;
  const rounded = Math.round(changePct);
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '';
  return `${sign}${Math.abs(rounded)} %`;
}

export function changeTone(changePct: number): 'positive' | 'negative' | 'muted' {
  const rounded = Math.round(changePct);
  return rounded > 0 ? 'positive' : rounded < 0 ? 'negative' : 'muted';
}

/** How many calendar days a YYYY-MM-DD range covers, inclusive — a word for "vs the 7 days before", never a figure. */
export function daySpan(from: string, to: string): number {
  const at = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((at(to) - at(from)) / 86_400_000) + 1;
}

/** Movement since the last count, or null when nothing has been counted yet. */
export function sinceLastCountTone(value: number | null): 'success' | 'danger' | 'neutral' {
  if (value === null || value === 0) return 'neutral';
  return value > 0 ? 'success' : 'danger';
}

/**
 * The i18n key that names one history entry. A day reopened by itself says what
 * reopened it, from the event's `cause`. Nothing reopens a day by itself any
 * more (docs/61); these are older events — a payment, a receipt, a sale — and
 * one naming nothing reads as a sale.
 */
export function historyKey(kind: string, cause?: unknown): string {
  switch (kind) {
    case 'auto_reopened':
      return cause === 'payment' || cause === 'purchase' ? `closing.history.auto_reopened.${cause}` : 'closing.history.auto_reopened';
    case 'count_saved':
    case 'closed':
    case 'reopened':
    case 'reclosed':
    case 'day_started_early':
    case 'opened':
    case 'first_activity':
    case 'sale':
      return `closing.history.${kind}`;
    default:
      return 'closing.history.other';
  }
}

/**
 * The line that says when the boutique opened (0077): an explicit opening or
 * a reopen, today or on a past date — or that no opening time was recorded.
 * The 06:00 boundary never counts as an opening.
 */
export function openingKey(opening: { kind: string } | null, isToday: boolean): string {
  if (!opening) return 'closingHistory.noOpening';
  const reopened = opening.kind === 'reopened' || opening.kind === 'auto_reopened';
  if (reopened) return isToday ? 'closingHistory.reopenedToday' : 'closingHistory.reopenedOn';
  return isToday ? 'closingHistory.openedToday' : 'closingHistory.openedOn';
}

/** Calendar arithmetic on a YYYY-MM-DD, with no timezone involved. */
export function shiftDay(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The business dates the selector offers: today first, then back `count` days. */
export function dayChoices(today: string, count = 60): string[] {
  return Array.from({ length: count + 1 }, (_, i) => shiftDay(today, -i));
}

/** "Today" / "Yesterday" for the two dates that have a word, else null. */
export function dayWordKey(date: string, today: string): 'closingHistory.today' | 'closingHistory.yesterday' | null {
  if (date === today) return 'closingHistory.today';
  if (date === shiftDay(today, -1)) return 'closingHistory.yesterday';
  return null;
}
