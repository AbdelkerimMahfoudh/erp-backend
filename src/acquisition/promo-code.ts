import { randomInt } from 'node:crypto';

/**
 * A promoter's six-digit code (0103, D221).
 *
 * Drawn uniformly from 000000–999999 by the operating system's CSPRNG, leading zeroes kept: never sequential, never
 * derived from a name, a number, a date or another row, and never chosen by hand. Uniqueness is the database's
 * (`ux_promoter_codes_code`, for ever): a collision is retried with a fresh draw inside the transaction that issues it.
 */

export const PROMO_CODE_LENGTH = 6;

export function newPromoCode(): string {
  return randomInt(0, 10 ** PROMO_CODE_LENGTH).toString().padStart(PROMO_CODE_LENGTH, '0');
}

/** Arabic-Indic (U+0660–0669) and Eastern Arabic-Indic (U+06F0–06F9) digits, read as the ASCII digits they are. */
export function asciiDigits(value: string): string {
  return value.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) & 0x0f));
}

/**
 * What a person typed, as a code: exactly six digits in any of the three numeral systems, spaces and hyphens allowed
 * between them (a pasted "123 456"). Null for anything else — refused before any lookup, and never a hint of why.
 */
export function normalisePromoCode(typed: unknown): string | null {
  if (typeof typed !== 'string' || typed.length > 20) return null;
  const digits = asciiDigits(typed).replace(/[\s\u00A0\u200E\u200F\u202A-\u202E\u2066-\u2069-]/g, '');
  return /^[0-9]{6}$/.test(digits) ? digits : null;
}
