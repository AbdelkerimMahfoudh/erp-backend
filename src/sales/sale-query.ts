import { BadRequestException } from '@nestjs/common';

/**
 * Parsing for the sale-history filters — pure, so the awkward cases can be
 * tested exhaustively without a database.
 */

/**
 * Turn a comma-separated filter into a validated list.
 *
 * An unrecognised value is a **400, not an empty filter**. Silently dropping it
 * would widen the query: someone filtering for `paid,pade` would be shown
 * everything and told nothing, and would reasonably believe they were looking
 * at a filtered list.
 */
export function parseEnumList<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  label: string,
): T[] {
  const parts = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return [];

  const unknown = parts.filter((p) => !(allowed as readonly string[]).includes(p));
  if (unknown.length > 0) {
    throw new BadRequestException(`Unknown ${label}: ${unknown.join(', ')}`);
  }
  // De-duplicated so `paid,paid` is one condition, not two.
  return [...new Set(parts)] as T[];
}

export interface SoldAtRange {
  gte?: Date;
  lt?: Date;
}

/**
 * Build the `soldAt` range from `from`/`to`.
 *
 * A **bare date means the whole of that day**, in UTC to match `dayKey` and the
 * branch-day buckets the rest of the system reports on. Someone asking for
 * sales "on the 3rd" means the day; treating `to=2026-08-03` as midnight would
 * return an empty list for a day that had sales all afternoon, which reads as
 * "there were none" rather than "you asked for an instant".
 *
 * The upper bound is therefore exclusive-of-the-next-day rather than
 * `lte: end-of-day`: no rounding, and nothing sold at 23:59:59.999 can fall
 * through the gap.
 */
export function parseDateRange(from?: string, to?: string): SoldAtRange | undefined {
  const gte = from === undefined ? undefined : startOfRange(from, 'from');
  const lt = to === undefined ? undefined : endOfRange(to, 'to');

  if (gte && lt && gte >= lt) {
    throw new BadRequestException('The start of the date range must come before its end');
  }
  if (!gte && !lt) return undefined;
  return { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) };
}

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function startOfRange(value: string, label: string): Date {
  return BARE_DATE.test(value) ? parseDate(`${value}T00:00:00.000Z`, label) : parseDate(value, label);
}

function endOfRange(value: string, label: string): Date {
  if (!BARE_DATE.test(value)) return parseDate(value, label);
  const day = parseDate(`${value}T00:00:00.000Z`, label);
  return new Date(day.getTime() + 24 * 3_600_000);
}

function parseDate(value: string, label: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`Invalid ${label} date`);
  return d;
}

/**
 * A product named the way a person would say it, with the parts that are
 * missing left out rather than printed as gaps.
 */
export function describeProduct(
  product: { brand: string | null; model: string | null; variant: string | null } | null | undefined,
): string | null {
  if (!product) return null;
  const name = [product.brand, product.model, product.variant].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : null;
}
