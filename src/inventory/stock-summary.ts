import type { Prisma, TrackingType } from '@prisma/client';
import { resolveQuantity, resolveSerialized } from '../pricing/price-resolution';
import { binToUuid } from '../common/utils/uuid.util';
import { isLowStock } from './low-stock';

/**
 * The shelf, one row per exact product variant, for the Stock screen.
 *
 * ## Why this exists alongside `/inventory` and `/inventory/by-model`
 *
 * `/inventory` answers "which handsets?" — one row per physical unit, paginated,
 * searchable by either IMEI. `/inventory/by-model` answers "how many of this
 * model?" with colours folded together, and counts serialized units only, so
 * accessories never reached it. Neither says what a variant **sells for** or
 * whether it is **running low**, which is what the Stock screen shows.
 *
 * ## What it deliberately does not do
 *
 * - **No cost, no margin.** Not stripped later — never put in. A summary is the
 *   screen every role opens first, and it must not be the place cost leaks.
 * - **No second definition of price.** Every unit is resolved through the same
 *   ladder the sale uses (`resolveSerialized` / `resolveQuantity`). When units of
 *   one variant resolve to different prices — a unit override on one phone — the
 *   row carries the RANGE, never one of them presented as "the" price.
 * - **No second definition of low.** `isLowStock` is shared with the dashboard.
 * - **No stored count.** Everything is derived from the rows passed in, which the
 *   service reads fresh on every request.
 *
 * Kept free of Prisma so the arithmetic can be tested directly.
 */

export type StockCategory = 'phone' | 'accessory' | 'other';

export interface SummaryProduct {
  id: Buffer;
  brand: string;
  model: string;
  variant: string | null;
  barcode: string | null;
  trackingType: TrackingType;
  specifications: Prisma.JsonValue;
  defaultPrice: number | null;
}

export interface SummaryInputs {
  activeBranchId: Buffer;
  threshold: number;
  products: SummaryProduct[];
  /** `in_stock` units at the active branch. Nothing else is sellable today. */
  units: { id: Buffer; productId: Buffer; branchId: Buffer }[];
  overrides: { unitId: Buffer; price: number; version: number; branchId: Buffer }[];
  branchVariants: { productId: Buffer; price: number; version: number }[];
  stockItems: {
    productId: Buffer;
    quantity: number;
    reservedQuantity: number;
    price: number | null;
    version: number;
  }[];
}

export interface StockSummaryRow {
  productId: string;
  brand: string;
  model: string;
  variant: string | null;
  barcode: string | null;
  trackingType: TrackingType;
  specifications: Prisma.JsonValue;
  /** Derived from tracking type: IMEI-tracked is a phone, quantity is an accessory. */
  category: StockCategory;
  /**
   * Sellable now. Serialized: `in_stock` units. Quantity: physical minus what is
   * promised to an open transfer — reserved goods are not free to sell.
   */
  available: number;
  lowStock: boolean;
  lowStockThreshold: number;
  /**
   * Null when NOTHING in this row has a selling price. Otherwise the range of
   * resolved prices, with how many units are priced and how many are not — so a
   * client never shows one unit's override as the price of every unit.
   */
  price: { min: number; max: number; pricedCount: number; unpricedCount: number } | null;
}

const hex = (b: Buffer) => b.toString('hex');

function categoryOf(tracking: TrackingType): StockCategory {
  if (tracking === 'imei') return 'phone';
  if (tracking === 'quantity') return 'accessory';
  return 'other';
}

export function buildStockSummary(input: SummaryInputs): StockSummaryRow[] {
  const productsById = new Map(input.products.map((p) => [hex(p.id), p]));
  const overrideByUnit = new Map(input.overrides.map((o) => [hex(o.unitId), o]));
  const variantByProduct = new Map(input.branchVariants.map((v) => [hex(v.productId), v]));

  const rows: StockSummaryRow[] = [];

  // ── Serialized: one row per product that has at least one unit on the shelf ──
  const unitsByProduct = new Map<string, SummaryInputs['units']>();
  for (const u of input.units) {
    const list = unitsByProduct.get(hex(u.productId)) ?? [];
    list.push(u);
    unitsByProduct.set(hex(u.productId), list);
  }

  for (const [productHex, units] of unitsByProduct) {
    const product = productsById.get(productHex);
    if (!product || product.trackingType === 'quantity') continue;

    const variant = variantByProduct.get(productHex) ?? null;
    const prices: number[] = [];
    let unpriced = 0;
    for (const u of units) {
      const override = overrideByUnit.get(hex(u.id)) ?? null;
      const resolved = resolveSerialized({
        activeBranchId: input.activeBranchId,
        unitBranchId: u.branchId,
        override: override
          ? { price: override.price, version: override.version, branchId: override.branchId }
          : null,
        branchVariant: variant ? { price: variant.price, version: variant.version } : null,
        productDefault: product.defaultPrice,
      });
      if (resolved.price === null) unpriced += 1;
      else prices.push(resolved.price);
    }

    rows.push({
      ...identity(product),
      available: units.length,
      lowStock: isLowStock(units.length, input.threshold),
      lowStockThreshold: input.threshold,
      price:
        prices.length === 0
          ? null
          : {
              min: Math.min(...prices),
              max: Math.max(...prices),
              pricedCount: prices.length,
              unpricedCount: unpriced,
            },
    });
  }

  // ── Quantity: one row per stock line the branch holds ──────────────────────
  for (const s of input.stockItems) {
    const product = productsById.get(hex(s.productId));
    if (!product || product.trackingType !== 'quantity') continue;

    const available = Math.max(0, s.quantity - s.reservedQuantity);
    // A stock row with no price falls through to the product default, exactly
    // as a sale does — never read as "free".
    const resolved = resolveQuantity(
      s.price === null ? null : { price: s.price, version: s.version },
      product.defaultPrice,
    );

    rows.push({
      ...identity(product),
      available,
      lowStock: isLowStock(s.quantity, input.threshold),
      lowStockThreshold: input.threshold,
      price:
        resolved.price === null
          ? null
          : { min: resolved.price, max: resolved.price, pricedCount: available, unpricedCount: 0 },
    });
  }

  return rows.sort(
    (a, b) =>
      a.brand.localeCompare(b.brand) ||
      a.model.localeCompare(b.model) ||
      (a.variant ?? '').localeCompare(b.variant ?? ''),
  );
}

function identity(product: SummaryProduct) {
  return {
    productId: binToUuid(product.id),
    brand: product.brand,
    model: product.model,
    variant: product.variant,
    barcode: product.barcode,
    trackingType: product.trackingType,
    specifications: product.specifications,
    category: categoryOf(product.trackingType),
  };
}
