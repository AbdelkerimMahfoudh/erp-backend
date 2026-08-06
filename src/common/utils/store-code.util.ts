import { randomBytes } from 'node:crypto';

/**
 * The public Store Account ID (F1 Stage 3.2).
 *
 * A short, human-typable, NON-secret code that identifies a business/company
 * account before login. It is deliberately NOT the internal binary company id,
 * a branch id, a device id or a subscription id, and it is never an
 * authentication secret — it only selects WHICH company a login belongs to, so
 * two companies can each have an `owner` without colliding.
 *
 * **Canonical form:** 10 uppercase hex characters (`0-9 A-F`). Hex is chosen on
 * purpose: it contains none of the visually confusing pairs (no `O`/`0`, `I`/`1`
 * or `L`/`1` clash, because O, I and L are not hex digits), so it is safe to read
 * aloud and type. It is generated from randomness (or, in the backfill, from a
 * hash of the company id), so it is non-sequential and does not expose how many
 * companies exist. Displayed grouped as `XXXXX-XXXXX` purely for legibility.
 *
 * Collision-safety rests on the database `UNIQUE` index plus a create-time retry
 * (see the generation call sites), never on this function alone.
 */

const CANONICAL = /^[0-9A-F]{10}$/;

/** A fresh high-entropy canonical code: 5 random bytes → 10 uppercase hex. */
export function generateStoreCode(): string {
  return randomBytes(5).toString('hex').toUpperCase();
}

/**
 * Normalize user input to the canonical form. Tolerates spaces, dashes, case and
 * the classic misreadings (`O`→`0`, `I`/`L`→`1`). Returns `null` when the result
 * is not a valid canonical code, so a malformed Store ID resolves to "no
 * company" (and then the non-enumerating auth failure), never to a lookup error.
 */
export function normalizeStoreCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return CANONICAL.test(cleaned) ? cleaned : null;
}

/** Cosmetic grouping for display: `XXXXX-XXXXX`. Input must be canonical. */
export function formatStoreCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}
