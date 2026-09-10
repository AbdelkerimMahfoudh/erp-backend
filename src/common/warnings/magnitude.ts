import {
  Warning,
  WarningCode,
  WarningReference,
  WarningSeverity,
  messageKeyFor,
} from './warning.types';

/**
 * Order-of-magnitude typo prevention (A1).
 *
 * ## The one rule
 *
 * A missing or extra zero is **exactly a factor of ten**. That is the whole
 * justification for the threshold: it is not a tuned statistic, it is the shape
 * of the mistake. A 3× threshold would fire on ordinary variation — a genuinely
 * expensive handset, a one-off bulk expense — and a warning people dismiss by
 * reflex has stopped working.
 *
 * ## What this module is not
 *
 * It **never** alters a value, never rejects one, and never authorises
 * anything. It compares two numbers the system already knows and says whether
 * they are a decimal place apart. Every reference is an existing figure —
 * a resolved price, a rollup, a stored balance — because a second way to
 * compute what something is worth is the failure mode this project guards
 * against everywhere else.
 *
 * ## Silence is a feature
 *
 * No reference, a reference of zero, too few observations, or a submitted zero
 * all produce **nothing**. A first receipt has no history; inventing a
 * category-wide reference would fire on every genuinely new item, and zero is a
 * legitimate price (a giveaway, a warranty replacement) already governed by the
 * configured-price floor.
 */

/** A missing or extra zero. Not tuned — derived from the mistake itself. */
export const MAGNITUDE_FACTOR = 10;

/** The largest bucket reported. Beyond this the sentence stops helping. */
const MAX_BUCKET = 1000;

export type MagnitudeDirection = 'high' | 'low';

export interface MagnitudeInput {
  code: WarningCode;
  /** The caller's own name for the input — `lines.0.price`. */
  field: string | null;
  /** What was typed. */
  submitted: number;
  /** What it is compared against, or null when there is nothing to compare to. */
  reference: WarningReference | null;
  /**
   * How many observations a derived reference needs before it is trusted.
   *
   * Two sales is not a median. Applies only where `reference.sample` is
   * populated: a configured price is a decision, not a sample, and needs none.
   */
  minSample?: number;
  /**
   * Warn only when the value is too high.
   *
   * Used by the debt payment, where paying a tenth of what is owed is an
   * ordinary part payment and warning about it would be noise.
   */
  directions?: readonly MagnitudeDirection[];
}

const BOTH: readonly MagnitudeDirection[] = ['high', 'low'];

/**
 * The i18n key for a magnitude warning.
 *
 * `magnitude.sale_price` + `high` → `warning.magnitude.salePrice.high`.
 * Derivable, but sent explicitly so no client ever builds one by
 * concatenation — and split by direction so each language can phrase "ten
 * times higher than usual" naturally instead of interpolating a sign.
 */
export function magnitudeMessageKey(code: WarningCode, direction: MagnitudeDirection): string {
  return `${messageKeyFor(code)}.${direction}`;
}

/**
 * The reported factor, as a **bucket** — 10, 100 or 1000 — never the computed
 * ratio.
 *
 * This is load-bearing beyond the wording. `acknowledgement.ts` binds a
 * warning's parameters into the fingerprint and deliberately excludes the
 * reference, which is only safe because the parameters do not move when the
 * reference drifts by a unit. A raw ratio would change on every request and
 * force a re-confirmation each time, which is how a warning becomes noise.
 */
export function magnitudeBucket(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio < MAGNITUDE_FACTOR) return MAGNITUDE_FACTOR;
  const exponent = Math.floor(Math.log10(ratio));
  return Math.min(MAX_BUCKET, Math.pow(10, exponent));
}

/**
 * One comparison, or nothing.
 *
 * Every magnitude warning is `caution`: it is a question the person must answer
 * before the mutation happens. `info` is reserved for the anomaly rules, which
 * are read on a screen rather than confirmed in a dialog.
 */
export function magnitudeWarning(input: MagnitudeInput): Warning | null {
  const { submitted, reference } = input;

  if (reference === null) return null;
  /*
   * A null amount is a reference the caller is not permitted to SEE, not the
   * absence of one — but a comparison it cannot be shown is a comparison it
   * cannot act on, so it is not raised. The cost-derived checks that hit this
   * path are covered by the configured-price floor, which needs no cost.
   */
  if (reference.amount === null || !Number.isFinite(reference.amount)) return null;
  if (reference.amount <= 0) return null;
  if (!Number.isFinite(submitted) || submitted <= 0) return null;
  if (
    input.minSample !== undefined &&
    reference.sample !== null &&
    reference.sample < input.minSample
  ) {
    return null;
  }

  const directions = input.directions ?? BOTH;
  const ratio = submitted / reference.amount;

  let direction: MagnitudeDirection | null = null;
  let factor = MAGNITUDE_FACTOR;
  if (directions.includes('high') && ratio >= MAGNITUDE_FACTOR) {
    direction = 'high';
    factor = magnitudeBucket(ratio);
  } else if (directions.includes('low') && ratio <= 1 / MAGNITUDE_FACTOR) {
    direction = 'low';
    factor = magnitudeBucket(1 / ratio);
  }
  if (direction === null) return null;

  const severity: WarningSeverity = 'caution';
  return {
    code: input.code,
    severity,
    messageKey: magnitudeMessageKey(input.code, direction),
    params: { factor, direction },
    field: input.field,
    submitted,
    reference,
  };
}
