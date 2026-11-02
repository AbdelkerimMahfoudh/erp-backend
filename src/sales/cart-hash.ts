import { createHash } from 'node:crypto';
import { normalizeIdentifier } from './sale-selection-rules';

export interface CartHashLine {
  identifier?: string | null;
  productId?: string | null;
  quantity?: number | null;
  price?: number | null;
}

/**
 * What one approval was given for (D227): every line, its quantity and price, and the sale's discount. Any change makes
 * another hash. The order of the lines does not, and neither do the payments: how the customer pays is not what was approved.
 * Worked out by the server from the request itself, so a phone never vouches for its own cart.
 */
export function cartHash(lines: readonly CartHashLine[], saleDiscount?: number | null): string {
  const money = (n: number | null | undefined) => (n == null ? '' : Number(n).toFixed(2));
  const canonical = lines
    .map((l) => (l.identifier ? `u|${normalizeIdentifier(l.identifier)}|1|${money(l.price)}` : `q|${l.productId ?? ''}|${l.quantity ?? 1}|${money(l.price)}`))
    .sort();
  return createHash('sha256').update(JSON.stringify({ lines: canonical, discount: money(saleDiscount ?? 0) })).digest('hex');
}
