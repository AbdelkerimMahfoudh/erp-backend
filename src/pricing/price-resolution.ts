/**
 * The price precedence ladder — the single definition of "what does this cost?".
 *
 * Kept pure and free of Prisma so it can be reasoned about and tested directly.
 * `PricingService` fetches the rungs; this decides which one wins. Sell, product
 * detail and the pricing API all go through it, so no caller can invent its own
 * order — that divergence is exactly how two screens start disagreeing about a
 * price.
 */

/** Which rung of the ladder produced the effective price. Always returned. */
export type PriceSource =
  | 'unit_override'
  | 'branch_variant'
  | 'stock_item'
  | 'product_default'
  | 'unpriced';

/** What a client would have to edit to change the effective price. */
export type PriceTargetType = 'unit' | 'branch_variant' | 'stock_item';

export interface CurrentRow {
  price: number;
  version: number;
}

/** A unit override also carries the branch whose authority created it. */
export interface OverrideRow extends CurrentRow {
  branchId: Buffer;
}

export interface SerializedInputs {
  /** The branch the request is acting in (proven accessible by the guard). */
  activeBranchId: Buffer;
  /** Where the unit actually is now. */
  unitBranchId: Buffer;
  override: OverrideRow | null;
  branchVariant: CurrentRow | null;
  productDefault: number | null;
}

export interface ResolvedPrice {
  price: number | null;
  source: PriceSource;
  /** Version of the row that produced the price — what a caller must echo back. */
  version: number | null;
  targetType: PriceTargetType | null;
  /**
   * True when an override exists but does not apply here. Surfaced so the UI can
   * explain the price rather than look broken, and so a transfer that failed to
   * invalidate is visible instead of silent.
   */
  staleOverrideIgnored: boolean;
}

const UNPRICED: ResolvedPrice = {
  price: null,
  source: 'unpriced',
  version: null,
  targetType: null,
  staleOverrideIgnored: false,
};

/**
 * A unit override applies only when the override's branch, the unit's current
 * branch and the active request branch are all the same.
 *
 * Requiring the override's branch to match the unit's is what stops a price set
 * in Branch A from following the phone into Branch B — authority was granted for
 * a branch, not for an object. Requiring the active branch to match as well
 * keeps a manager browsing from another branch from seeing a price that is not
 * the one this unit would actually sell at there.
 *
 * Transfers are supposed to delete the override on the way out (see
 * `PricingService.invalidateOnBranchMoveTx`). This check is the backstop: if that
 * ever fails, the stale price is ignored rather than honoured.
 */
export function overrideApplies(
  override: OverrideRow | null,
  unitBranchId: Buffer,
  activeBranchId: Buffer,
): boolean {
  if (!override) return false;
  return override.branchId.equals(unitBranchId) && activeBranchId.equals(unitBranchId);
}

/** Serialized unit: override → branch variant → product default → unpriced. */
export function resolveSerialized(input: SerializedInputs): ResolvedPrice {
  const applies = overrideApplies(input.override, input.unitBranchId, input.activeBranchId);
  const staleOverrideIgnored = input.override !== null && !applies;

  if (applies && input.override) {
    return {
      price: input.override.price,
      source: 'unit_override',
      version: input.override.version,
      targetType: 'unit',
      staleOverrideIgnored: false,
    };
  }
  const fallback = resolveProductLevel(input.branchVariant, input.productDefault);
  return { ...fallback, staleOverrideIgnored };
}

/**
 * A serialized product with no unit chosen yet — the catalog/product view.
 *
 * Deliberately never consults unit overrides: an override belongs to one phone,
 * and showing it as "the price" would be a lie about every other phone of the
 * same variant.
 */
export function resolveProductLevel(
  branchVariant: CurrentRow | null,
  productDefault: number | null,
): ResolvedPrice {
  if (branchVariant) {
    return {
      price: branchVariant.price,
      source: 'branch_variant',
      version: branchVariant.version,
      targetType: 'branch_variant',
      staleOverrideIgnored: false,
    };
  }
  if (productDefault !== null) {
    return {
      price: productDefault,
      source: 'product_default',
      version: null,
      targetType: 'branch_variant',
      staleOverrideIgnored: false,
    };
  }
  return UNPRICED;
}

/**
 * Quantity-tracked stock. `StockItem.price` is already the branch price and has
 * been since long before this phase, so pricing does not add a second source for
 * it — two answers to one question is worse than an inconsistent one.
 *
 * `branch_variant_prices` is never read or written for quantity products.
 */
export function resolveQuantity(
  stockItem: CurrentRow | null,
  productDefault: number | null,
): ResolvedPrice {
  if (stockItem) {
    return {
      price: stockItem.price,
      source: 'stock_item',
      version: stockItem.version,
      targetType: 'stock_item',
      staleOverrideIgnored: false,
    };
  }
  if (productDefault !== null) {
    return {
      price: productDefault,
      source: 'product_default',
      version: null,
      targetType: 'stock_item',
      staleOverrideIgnored: false,
    };
  }
  return UNPRICED;
}
