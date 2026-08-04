/**
 * Response fields that reveal cost / profit / valuation. They are removed from
 * every response for callers without the `cost.view` permission. Names are
 * intentionally unambiguous so a blanket key-strip is safe (e.g. no bare
 * `value` or `price` — selling prices and revenue stay visible).
 */
export const FINANCIAL_FIELDS: ReadonlySet<string> = new Set([
  // cost
  'cost',
  'unitCost',
  'defaultCost',
  'purchaseCost',
  'totalCost',
  'cogs',
  'costOfGoodsSold',
  // profit / margin
  'margin',
  'profit',
  'grossProfit',
  'netProfit',
  'totalProfit',
  // inventory valuation
  'inventoryValue',
  'expectedProfit',
  'expectedRevenue',
]);

/**
 * Deep-clone `data` with every FINANCIAL_FIELDS key removed. Arrays and nested
 * objects are handled; Dates/Buffers/primitives pass through untouched. Pure and
 * side-effect free — the input is not mutated.
 */
export function stripFinancialFields<T>(data: T): T {
  if (Array.isArray(data)) {
    return data.map((item) => stripFinancialFields(item)) as unknown as T;
  }
  if (
    data !== null &&
    typeof data === 'object' &&
    !(data instanceof Date) &&
    !Buffer.isBuffer(data)
  ) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (FINANCIAL_FIELDS.has(key)) continue;
      out[key] = stripFinancialFields(value);
    }
    return out as unknown as T;
  }
  return data;
}
