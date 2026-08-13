import { Prisma } from '@prisma/client';

/**
 * What a branch — or the whole company — physically holds, straight from the
 * source tables (H1.4.1).
 *
 * ## Why this exists
 *
 * `inventory_valuation` is a **persisted rollup**, rebuilt after the fact by a
 * fire-and-forget queue whose failures are logged and swallowed. That is fine
 * for a ranking: dead-stock lists and health scores can tolerate a figure that
 * is a moment behind, and they were built knowing it.
 *
 * It is not fine for a **reported total**. `/analytics/inventory-value` combines
 * held value with in-transit value, and in-transit is computed live from
 * `transfer_items`. Mixing a stale half with a live half is what let
 * `totalStockValue` — documented as "the number that must not move when stock
 * is merely travelling" — move anyway: a shipment lowered the live half
 * immediately while the held half caught up later, or never, if the refresh
 * threw or the process died first.
 *
 * So the report computes both halves from source. The rollup keeps serving the
 * surfaces that only rank things.
 *
 * ## One formula, two consumers
 *
 * `RollupService.recomputeInventoryValuation` persists these same rows. Both go
 * through here so the stored figure and the reported figure cannot drift into
 * two different definitions of what stock is worth.
 *
 * Serialized units carry their own `cost` and are expected to fetch
 * `products.default_price`; quantity stock is `quantity × cost`, expected at its
 * branch price. `si.price` is nullable since `0034` — without the COALESCE the
 * whole product's expected revenue would go NULL and silently vanish from the
 * total. Falling back to the catalogue default and then to `0` states the
 * truth: nothing priced means no revenue can be expected yet. **Cost, and
 * therefore inventory VALUE, is unaffected** — the goods are owned and counted
 * regardless of whether anyone has priced them.
 */

/**
 * Coerce a raw SQL aggregate to a number. MySQL hands back Decimal strings for
 * SUM over DECIMAL columns and bigints for COUNT, and neither is a JS number.
 */
export function toNum(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object' && typeof (v as { toNumber?: () => number }).toNumber === 'function') {
    return (v as { toNumber: () => number }).toNumber();
  }
  return Number(v as number | string);
}

export interface HeldValueRow {
  /** Which storage shape this row came from. Explicit, never inferred. */
  kind: 'unit' | 'stock';
  product_id: Buffer;
  category_id: Buffer | null;
  tracking_type: 'imei' | 'serial' | 'quantity';
  units_count: unknown;
  quantity: unknown;
  inv_value: unknown;
  exp_rev: unknown;
}

export interface RawQueryable {
  $queryRaw<T = unknown>(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]): Promise<T>;
}

/**
 * Per-product held value. Pass `branchId` for one branch, omit it for the
 * company. `company_id` is written out explicitly because raw SQL does not pass
 * through the tenant extension that scopes the model API.
 */
export async function heldValueRows(
  db: RawQueryable,
  args: { companyId: Buffer; branchId?: Buffer | null },
): Promise<HeldValueRow[]> {
  const branch = args.branchId ?? null;
  // One optional filter, expressed once, so the two shapes cannot diverge.
  const unitBranch = branch ? Prisma.sql`AND u.branch_id = ${branch}` : Prisma.empty;
  const stockBranch = branch ? Prisma.sql`AND si.branch_id = ${branch}` : Prisma.empty;

  const [units, stock] = await Promise.all([
    db.$queryRaw<HeldValueRow[]>(Prisma.sql`
      SELECT 'unit' AS kind, p.id AS product_id, p.category_id, p.tracking_type,
             COUNT(*)                          AS units_count,
             0                                 AS quantity,
             SUM(u.cost)                       AS inv_value,
             SUM(COALESCE(p.default_price, 0)) AS exp_rev
        FROM units u
        JOIN products p ON p.id = u.product_id
       WHERE u.company_id = ${args.companyId} AND u.status = 'in_stock' ${unitBranch}
       GROUP BY p.id, p.category_id, p.tracking_type`),
    db.$queryRaw<HeldValueRow[]>(Prisma.sql`
      SELECT 'stock' AS kind, p.id AS product_id, p.category_id, p.tracking_type,
             0                                                   AS units_count,
             SUM(si.quantity)                                    AS quantity,
             SUM(si.quantity * si.cost)                          AS inv_value,
             SUM(si.quantity * COALESCE(si.price, p.default_price, 0)) AS exp_rev
        FROM stock_items si
        JOIN products p ON p.id = si.product_id
       WHERE si.company_id = ${args.companyId} AND si.quantity > 0 ${stockBranch}
       GROUP BY p.id, p.category_id, p.tracking_type`),
  ]);

  return [...units, ...stock];
}
