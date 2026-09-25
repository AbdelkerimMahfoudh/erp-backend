/**
 * Each line's share of the recorded invoice total (docs/54 D36).
 *
 * `sales.total` is what the customer was invoiced: the lines, less their own
 * discounts, less a whole-invoice discount (`saleDiscount` — the only discount the
 * Sell tab sends). That discount belongs to no line, so every reader that works per
 * line — the daily and product rollups, a cancelled sale's lines, a return's refund,
 * the closing digest — spreads it over the lines in proportion to what each was
 * invoiced at:
 *
 *   share = lineNet × total ÷ Σ lineNet, rounded half-up to the cent
 *   lineNet = price × quantity − line discount
 *
 * The cent gained or lost by rounding goes to the largest line (the first created on
 * a tie), so the shares of a sale always add up to `sales.total` exactly. Without a
 * whole-invoice discount, total = Σ lineNet and each share is the line's own net.
 *
 * Integer cents and BigInt throughout: a share computed here and one computed from
 * the same rows anywhere else are the same number, to the cent.
 */

type Amount = number | string | { toString(): string };

export interface ShareLine {
  id: Buffer;
  price: Amount;
  quantity: number;
  discount: Amount;
}

/** Money to integer cents, from a Decimal, a string or a number. */
export function toCents(value: Amount): bigint {
  return BigInt(Math.round(Number(value.toString()) * 100));
}

/**
 * Each line's share, in cents, keyed by the line id (hex). `lines` must be every
 * non-voided line of ONE sale — a share depends on its siblings.
 */
export function lineShareCents(lines: readonly ShareLine[], saleTotal: Amount): Map<string, bigint> {
  const shares = new Map<string, bigint>();
  if (lines.length === 0) return shares;
  const nets = lines.map((l) => ({ key: l.id.toString('hex'), id: l.id, net: toCents(l.price) * BigInt(l.quantity) - toCents(l.discount) }));
  const saleNet = nets.reduce((s, l) => s + l.net, 0n);
  const total = toCents(saleTotal);
  if (saleNet <= 0n) {
    // Nothing to weigh by: the whole total sits on the first line, the rest on none.
    nets.forEach((l, i) => shares.set(l.key, i === 0 ? total : 0n));
    return shares;
  }
  for (const l of nets) shares.set(l.key, (2n * l.net * total + saleNet) / (2n * saleNet));
  const allocated = [...shares.values()].reduce((s, v) => s + v, 0n);
  const largest = [...nets].sort((a, b) => (a.net === b.net ? Buffer.compare(a.id, b.id) : a.net > b.net ? -1 : 1))[0];
  shares.set(largest.key, (shares.get(largest.key) as bigint) + (total - allocated));
  return shares;
}

/** Cents back to money. */
export const fromCents = (cents: bigint): number => Number(cents) / 100;

/**
 * The shares of many lines from many sales at once: groups them by sale, so each
 * sale's lines are weighed against each other and nothing else.
 */
export function sharesBySale<L extends ShareLine & { saleId: Buffer; saleTotal: Amount }>(lines: readonly L[]): Map<string, bigint> {
  const bySale = new Map<string, L[]>();
  for (const l of lines) {
    const key = l.saleId.toString('hex');
    const group = bySale.get(key);
    if (group) group.push(l);
    else bySale.set(key, [l]);
  }
  const out = new Map<string, bigint>();
  for (const group of bySale.values()) {
    for (const [k, v] of lineShareCents(group, group[0].saleTotal)) out.set(k, v);
  }
  return out;
}
