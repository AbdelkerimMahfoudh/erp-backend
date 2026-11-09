// GENERATED from erp-mobile lib/money-format.ts at 5dcfb74 by scripts/sync-report-pdf.mjs — do not edit; sync again.
/* eslint-disable */
// @ts-nocheck
/**
 * Money and number formatting — the one place amounts become text.
 *
 * Split out of `lib/format.ts` so it depends on **nothing**: no React Native, no
 * i18n store, no date library. That is what lets `money-format.test.ts` run
 * under bare `node`, and it keeps a single formatter behind every screen,
 * button, card, receipt and export. `lib/format.ts` re-exports all of it, so
 * existing imports are unchanged and there is still only one implementation.
 *
 * Deliberately built WITHOUT `Intl`. Hermes ships inconsistent ICU coverage
 * across platforms, and `toLocaleString` with currency options can silently
 * ignore what you asked for. Money is the highest-stakes text in this app; a
 * price that renders differently on one employee's phone is a real-world
 * mistake. So grouping is done by hand, and behaves identically everywhere.
 */

/** Mauritanian ouguiya. */
export const CURRENCY_CODE = 'MRU';

/**
 * Mauritanian retail prices are quoted in whole ouguiya — the khoums subunit is
 * not used at a counter. The backend keeps DECIMAL(14,2) precision; this is a
 * display decision only, and no arithmetic is ever done on a formatted string.
 */
const DEFAULT_DECIMALS = 0;

/**
 * Non-breaking space between digit groups: `1 030 MRU`.
 *
 * This was a NARROW no-break space (U+202F), which measures about 2 px at body
 * size. On the charge button — the most-read number in the app — *1 015 MRU*
 * reached the eye as *1015 MRU*, while the same string in the big total showed
 * its gap clearly. The character was never missing; it was simply too small to
 * read at the size that matters. U+00A0 is about twice as wide, stays legible
 * at button and caption sizes, and still never lets a number wrap in half.
 */
const GROUP_SEPARATOR = ' ';
const DECIMAL_SEPARATOR = ',';
/** Non-breaking space, so `45 000 MRU` never splits across lines. */
const CURRENCY_SEPARATOR = ' ';

/** Shown wherever a value is absent — including cost the server stripped. */
export const ABSENT = '—';

function groupDigits(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, GROUP_SEPARATOR);
}

/**
 * Format a bare number with grouping, no currency.
 *
 * For **quantities and amounts only**. Never pass an identifier through this: an
 * IMEI, a serial, a phone number, a year or a storage size is a label, not a
 * count, and `2026` must never become `2 026`. Identifiers render through the
 * `Identifier` primitive, which does no grouping at all.
 */
export function formatNumber(value?: number | null, decimals = 0): string {
  if (value === undefined || value === null || Number.isNaN(value)) return ABSENT;
  const negative = value < 0;
  const fixed = Math.abs(value).toFixed(decimals);
  const [intPart, fracPart] = fixed.split('.');
  const grouped = groupDigits(intPart);
  const body = fracPart ? `${grouped}${DECIMAL_SEPARATOR}${fracPart}` : grouped;
  return negative ? `-${body}` : body;
}

export interface MoneyOptions {
  /** Show the currency code. Off inside a column already labelled as money. */
  showCurrency?: boolean;
  decimals?: number;
  /** Force a leading + on positive values — for deltas and adjustments. */
  signed?: boolean;
}

/**
 * Format money. Returns `—` for null/undefined, which is what a caller without
 * `cost.view` receives once the server has stripped the field.
 */
export function formatMoney(value?: number | null, options: MoneyOptions = {}): string {
  const { showCurrency = true, decimals = DEFAULT_DECIMALS, signed = false } = options;
  if (value === undefined || value === null || Number.isNaN(value)) return ABSENT;

  const body = formatNumber(value, decimals);
  const withSign = signed && value > 0 ? `+${body}` : body;
  return showCurrency ? `${withSign}${CURRENCY_SEPARATOR}${CURRENCY_CODE}` : withSign;
}

/**
 * A money figure in its two parts — the signed number and the currency — so a
 * narrow screen can lay them out on two lines instead of cutting the figure
 * (docs/61 §8). Joined with the no-break space they read exactly as
 * `formatMoney` writes them.
 */
export interface MoneyParts {
  number: string;
  currency: string | null;
}

export function moneyParts(value: number, options: MoneyOptions = {}): MoneyParts {
  const { showCurrency = true, decimals = DEFAULT_DECIMALS, signed = false } = options;
  const body = formatNumber(value, decimals);
  return { number: signed && value > 0 ? `+${body}` : body, currency: showCurrency ? CURRENCY_CODE : null };
}

/** The two parts on one line, as `formatMoney` writes them. */
export function joinMoney(parts: MoneyParts): string {
  return parts.currency ? `${parts.number}${CURRENCY_SEPARATOR}${parts.currency}` : parts.number;
}

/**
 * The number with ordinary spaces between its digit groups — where it may
 * break, as the very last resort, between whole groups and never inside one.
 * The sign stays with the first group.
 */
export function breakableNumber(number: string): string {
  return number.split(GROUP_SEPARATOR).join(' ');
}

/** True when a money field was withheld rather than being genuinely zero. */
export function isMoneyHidden(value?: number | null): boolean {
  return value === undefined || value === null;
}

/** Whole-unit counts — never fractional, never currency. */
export function formatQuantity(value?: number | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return ABSENT;
  return formatNumber(Math.trunc(value), 0);
}

export function formatPercent(value?: number | null, decimals = 0): string {
  if (value === undefined || value === null || Number.isNaN(value)) return ABSENT;
  return `${formatNumber(value, decimals)}%`;
}
