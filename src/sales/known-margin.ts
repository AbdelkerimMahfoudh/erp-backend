/**
 * The sale's margin over the lines whose buying cost is KNOWN (0107).
 *
 * With every cost known it is exactly total − cost, as before. A line of
 * unknown cost contributes neither revenue nor cost to the margin — counting
 * its price would be selling price minus zero — and the reports disclose how
 * many lines a figure leaves out. A sale-wide discount is shared out by list
 * value, so the known lines carry only their part of it.
 */
export function knownMargin(
  lines: readonly { price: number; quantity: number; discount: number; cost: number | null }[],
  subtotal: number,
  saleDiscount: number,
  total: number,
  totalCost: number,
): number {
  if (lines.every((l) => l.cost !== null)) return total - totalCost;
  const known = lines.filter((l) => l.cost !== null);
  const knownList = known.reduce((s, l) => s + l.price * l.quantity, 0);
  const knownNet = known.reduce((s, l) => s + l.price * l.quantity - l.discount, 0);
  const share = subtotal > 0 ? saleDiscount * (knownList / subtotal) : 0;
  return knownNet - share - totalCost;
}
