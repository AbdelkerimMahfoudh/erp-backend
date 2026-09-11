/**
 * What counts as "low" — one definition.
 *
 * The dashboard's low-stock list and the Stock screen's low-stock marker ask the
 * same question about the same shelf. Two thresholds, or two comparisons, would
 * be two answers to "what counts as low?", and the first time they disagreed a
 * shopkeeper would see a product flagged on one screen and fine on the other.
 *
 * The threshold is the shop's own `low_stock_threshold` setting (company-wide,
 * `branchId: null`), defaulting to 3 when it was never set. The comparison is
 * inclusive: at the threshold is already low.
 */

export const LOW_STOCK_SETTING = 'low_stock_threshold';
export const LOW_STOCK_DEFAULT = 3;

/**
 * @param count For serialized stock, the number of `in_stock` units. For
 *   quantity stock, the PHYSICAL quantity — the same figure the dashboard has
 *   always compared, so the two screens cannot drift apart.
 */
export function isLowStock(count: number, threshold: number): boolean {
  return count <= threshold;
}
