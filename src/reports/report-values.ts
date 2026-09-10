/**
 * Turning a reported value into a cell.
 *
 * These are reporting decisions, not formatting convenience, so they live apart
 * from the writer. Three of them matter enough to state:
 *
 * 1. **Missing is not zero.** A metric nobody computed is an empty cell. A zero
 *    is a claim that something was measured and found to be nothing, and a shop
 *    reading a spreadsheet cannot tell the two apart unless the file does. This
 *    is the same rule `docs/34` applies to the screens.
 *
 * 2. **Money is a number, not a presentation.** No thousands separator, no
 *    currency symbol, a dot for the decimal point — because the cell has to add
 *    up in Excel, and `4 000,00 MRU` is text. The currency is named once, in the
 *    column header, where it cannot break the arithmetic.
 *
 * 3. **Zero and negative survive.** `0` is written as `0`, and a negative
 *    balance keeps its minus sign and is never armoured against formulas — see
 *    `armour` in `csv-writer.ts` for why that distinction is load-bearing.
 */

import { armour } from './csv-writer';

/** Two decimals, always both, dot-separated. `-0` is normalised to `0`. */
export function money(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  const fixed = (Object.is(value, -0) ? 0 : value).toFixed(2);
  return fixed === '-0.00' ? '0.00' : fixed;
}

/** A whole count. Zero is written; absent is blank. */
export function count(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  return String(value);
}

/**
 * A date as `YYYY-MM-DD`, in UTC.
 *
 * UTC because every stored timestamp and every rollup day key in this project is
 * UTC, and converting here would put a report's dates a few hours away from the
 * day boundaries the numbers were bucketed by.
 */
export function isoDate(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/**
 * Free text a user typed — a product label, a person's name, a note.
 *
 * The one place formula armour is applied, because it is the one kind of cell
 * whose content came from outside.
 */
export function text(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return armour(value);
}
