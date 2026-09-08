import { createHash } from 'node:crypto';

/**
 * The payload fingerprint behind quantity-receipt idempotency.
 *
 * Same key and same payload replays the original receipt; same key and a
 * DIFFERENT payload is a conflict, because that is not a retry — it is a second
 * delivery wearing the first one's identity. The same reasoning, and the same
 * shape, as `fingerprintCorrection` in the corrections module.
 *
 * Every field that changes what the receipt DID is in here. `price` is included
 * even though it only applies when the stock row is being created, because a
 * retry that quietly carried a different price would otherwise replay as though
 * it were identical.
 */
export function fingerprintReceipt(input: {
  productId: string;
  branchId: string;
  quantity: number;
  cost: number;
  price: number | null;
}): string {
  return createHash('sha256')
    .update(
      [
        input.productId,
        input.branchId,
        String(input.quantity),
        input.cost.toFixed(2),
        input.price === null ? '' : input.price.toFixed(2),
      ].join('|'),
    )
    .digest('hex');
}
