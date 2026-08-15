import { Prisma } from '@prisma/client';

/**
 * Excluding corrected payments from the liabilities they settled.
 *
 * Both outstanding balances in this system are **derived** from rows whose
 * status is `confirmed` — a supplier's payable from purchases minus confirmed
 * allocations, the refund liability from approved reversals minus confirmed
 * payouts. An approved correction therefore restores the liability simply by
 * existing, provided every one of those derivations knows to skip its target.
 *
 * These fragments are that knowledge, written once. Inlining the NOT EXISTS at
 * four call sites would work today and drift the first time somebody adds a
 * fifth.
 *
 * ---
 *
 * **Which queries use this, and which deliberately do not.**
 *
 * A correction does *not* rewrite history. The original payment really did
 * happen on its own day, that day's rollup recorded it, and its closing may
 * already be locked. The compensating movement lands on the correction day
 * instead — so:
 *
 *   - **Live "what is owed right now"** — supplier outstanding, per-purchase
 *     paid amounts, the refund liability: these MUST exclude corrected
 *     payments, because the debt is genuinely owed again.
 *
 *   - **Historical "what moved on day X"** — `paidOn`, the confirmed-refund
 *     period totals, the daily rollup: these MUST NOT. Subtracting a correction
 *     from the day the original payment happened would silently rewrite a
 *     closed day, which is precisely what this whole design exists to avoid.
 *
 * Getting that split wrong in either direction double-counts money.
 */

/**
 * `AND NOT EXISTS (…)` for a `supplier_settlements` row.
 *
 * @param alias the table alias the settlement is bound to in the caller's query
 */
export function settlementNotCorrected(alias: string): Prisma.Sql {
  return Prisma.raw(`AND NOT EXISTS (
        SELECT 1 FROM financial_corrections fc
         WHERE fc.target_supplier_settlement_id = ${alias}.id
           AND fc.status = 'approved')`);
}

/**
 * `AND NOT EXISTS (…)` for a `refund_payouts` row.
 *
 * @param alias the table alias the payout is bound to in the caller's query
 */
export function payoutNotCorrected(alias: string): Prisma.Sql {
  return Prisma.raw(`AND NOT EXISTS (
        SELECT 1 FROM financial_corrections fc
         WHERE fc.target_refund_payout_id = ${alias}.id
           AND fc.status = 'approved')`);
}
