import { Prisma } from '@prisma/client';

/**
 * The one monetary boundary.
 *
 * Every money column in this schema is `DECIMAL(14,2)`. Twelve digits before
 * the point, two after. Before this file that fact lived in one DTO
 * (`pricing/dto/pricing.dto.ts`) and nowhere else, so a sale line priced 1e15
 * passed validation and reached MySQL — where it either overflows or truncates.
 *
 * **Database overflow is not a validation mechanism.** It reports the wrong
 * thing, at the wrong layer, in the wrong language, after a transaction has
 * already begun. So the check happens here, before Prisma is called at all.
 *
 * ## Why decimals and not numbers
 *
 * The comparison is done with `Prisma.Decimal`, which is exact. Doing it in
 * JavaScript floating point would be checking a rounded copy of the value
 * against a rounded copy of the limit: `0.1 + 0.2 !== 0.3`, and
 * `999999999999.99 * 100` is not an integer. A scale check written as
 * `n * 100 === Math.round(n * 100)` is wrong for exactly the values that matter
 * most — the ones at the edge.
 *
 * The value is read from its **string form** wherever one exists, so nothing is
 * lost before the check runs.
 */

/** Digits after the decimal point. `DECIMAL(14,`**`2`**`)`. */
export const MONEY_SCALE = 2;

/** Total digits. `DECIMAL(`**`14`**`,2)`. */
export const MONEY_PRECISION = 14;

/** The largest value the column holds, as an exact string. */
export const MONEY_MAX_STRING = '999999999999.99';

/** The same bound as a number, for `@Max` and for API documentation. */
export const MONEY_MAX = 999_999_999_999.99;

/** The most negative value the column holds. Whether a FIELD may go negative is
 * a business question answered per field — this is only what fits. */
export const MONEY_MIN_STRING = '-999999999999.99';
export const MONEY_MIN = -999_999_999_999.99;

const MAX = new Prisma.Decimal(MONEY_MAX_STRING);
const MIN = new Prisma.Decimal(MONEY_MIN_STRING);

/**
 * Why a value is not acceptable money.
 *
 * Codes rather than sentences: the API layer turns these into localized
 * messages, and none of them names a column, a type or a database.
 */
export type MoneyRejection =
  | 'not_a_number'
  | 'not_finite'
  | 'exponent_notation'
  | 'too_many_decimals'
  | 'above_maximum'
  | 'below_minimum';

export type MoneyParse =
  | { ok: true; decimal: Prisma.Decimal }
  | { ok: false; reason: MoneyRejection };

/**
 * Accept a value as money, or say precisely why not.
 *
 * Handles what actually arrives: a JSON number, a decimal string from a CSV, or
 * something that is neither.
 *
 * **Exponent notation is rejected in STRINGS only.** `"1e5"` in a spreadsheet
 * cell is far more likely to be a mangled export than a deliberate 100 000, and
 * accepting it silently is how a column of prices becomes wrong in a way nobody
 * can see. A JSON *number* written `1e5` is simply `100000` by the time it is
 * parsed — there is no string left to inspect and nothing suspicious about it.
 */
export function parseMoney(raw: unknown): MoneyParse {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { ok: false, reason: 'not_finite' };
    // `String(1e21)` is "1e+21", so a huge number would look like exponent
    // notation. It is not: it is a number that is too large, and saying so is
    // more useful than complaining about its spelling.
    if (Math.abs(raw) > MONEY_MAX) return { ok: false, reason: 'above_maximum' };
    return check(new Prisma.Decimal(raw.toString()));
  }

  if (typeof raw !== 'string') return { ok: false, reason: 'not_a_number' };

  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, reason: 'not_a_number' };
  if (/[eE]/.test(trimmed)) return { ok: false, reason: 'exponent_notation' };
  // A plain decimal, optionally signed. No separators, no currency, no spaces
  // inside — `parseNumber` in the importer does that normalisation first.
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return { ok: false, reason: 'not_a_number' };

  let decimal: Prisma.Decimal;
  try {
    decimal = new Prisma.Decimal(trimmed);
  } catch {
    return { ok: false, reason: 'not_a_number' };
  }
  return check(decimal);
}

function check(decimal: Prisma.Decimal): MoneyParse {
  if (!decimal.isFinite()) return { ok: false, reason: 'not_finite' };
  // `decimalPlaces()` is exact — it counts digits, it does not multiply.
  if (decimal.decimalPlaces() > MONEY_SCALE) return { ok: false, reason: 'too_many_decimals' };
  if (decimal.greaterThan(MAX)) return { ok: false, reason: 'above_maximum' };
  if (decimal.lessThan(MIN)) return { ok: false, reason: 'below_minimum' };
  return { ok: true, decimal };
}

/** True when the value is money this schema can hold. */
export function isMoney(raw: unknown): boolean {
  return parseMoney(raw).ok;
}

/**
 * Plain-language messages, with no database in them.
 *
 * A caller must never be told about `DECIMAL(14,2)`, a column, or MySQL. The
 * limit is stated as a number they can act on.
 */
export const MONEY_MESSAGE: Record<MoneyRejection, string> = {
  not_a_number: 'must be an amount',
  not_finite: 'must be a real amount',
  exponent_notation: 'must be written in full, not as 1e5',
  too_many_decimals: 'may have at most 2 decimal places',
  above_maximum: `may not be more than ${MONEY_MAX_STRING}`,
  below_minimum: `may not be less than ${MONEY_MIN_STRING}`,
};

/** The i18n key a client uses to say the same thing in the user's language. */
export const MONEY_MESSAGE_KEY: Record<MoneyRejection, string> = {
  not_a_number: 'money.error.notANumber',
  not_finite: 'money.error.notANumber',
  exponent_notation: 'money.error.exponent',
  too_many_decimals: 'money.error.tooManyDecimals',
  above_maximum: 'money.error.aboveMaximum',
  below_minimum: 'money.error.belowMinimum',
};
