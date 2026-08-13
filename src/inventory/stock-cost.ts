import { Prisma } from '@prisma/client';
import { newUuidV7Bin } from '../common/utils/uuid.util';

/**
 * The one rule for bringing quantity stock into a branch (H1.4.1).
 *
 * Every inflow — purchase receiving, quick "Add Stock", transfer receipt —
 * goes through this. Before H1.4.1 there were three rules: transfer receipt
 * averaged correctly, while the two purchase-side paths incremented quantity
 * and left `cost` at whatever the **first ever** receipt paid. Buying the same
 * cable again at a higher price therefore never changed the recorded cost, so
 * cost of goods drifted away from what the shop actually paid — always in the
 * direction that makes the business look more profitable than it is.
 *
 * ## Weighted average
 *
 * ```text
 * new cost = (physical quantity × current cost + received × incoming cost)
 *            / (physical quantity + received)
 * ```
 *
 * `quantity` is the **physical** total, never `quantity - reserved`. Stock this
 * branch has promised to a transfer is still owned and was still bought at a
 * price that belongs in the average. `reserved_quantity` is deliberately absent
 * from the statement: receiving goods changes what is here, not what is
 * promised.
 *
 * ## Why one statement
 *
 * It is a single `INSERT … ON DUPLICATE KEY UPDATE`, so the row being absent
 * and the row already existing are the *same* operation rather than a branch
 * chosen by an earlier read. That closes two races at once:
 *
 *  - **Two receipts into an existing row.** The average is computed inside the
 *    UPDATE from the row's own committed values, so the second averages against
 *    the first's *result*. A read-modify-write would compute both averages from
 *    the same snapshot and silently lose one.
 *  - **Two receipts into a row that does not exist yet.** A `SELECT` followed by
 *    `INSERT`-or-`UPDATE` lets both callers see nothing and both insert; one
 *    then fails on the unique key. Here the unique key *is* the mechanism, so
 *    the loser becomes an update and both quantities survive.
 *
 * Assignment order matters and is not cosmetic: `cost` is assigned **before**
 * `quantity`, because MySQL evaluates `ON DUPLICATE KEY UPDATE` left to right
 * and a later assignment sees the earlier one's new value. Averaging against an
 * already-incremented quantity would quietly under-weight the incoming goods.
 *
 * ## What it never does
 *
 * The selling price is absent from the UPDATE clause. Price is branch-private
 * and has nothing to do with what the goods cost — receiving at a new price
 * must never reprice the shelf. `priceIfNew` is used **only** when the row is
 * created, and `null` there means genuinely unpriced (never zero, which would
 * read as "sells for free").
 */

/** A client that can run raw SQL — the tenant client and its transactions both can. */
export interface RawCapable {
  $executeRaw(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]): Promise<number>;
}

export interface ReceiveQuantityArgs {
  companyId: Buffer;
  productId: Buffer;
  branchId: Buffer;
  /** How many arrived. Must be positive — receiving nothing is not an event. */
  received: number;
  /** What these ones cost, per unit. The actual price paid, never a default. */
  unitCost: Prisma.Decimal | number;
  /**
   * Selling price for a row that does not exist yet. `null` leaves it unpriced,
   * which the price ladder already models. Ignored when the row exists.
   */
  priceIfNew?: Prisma.Decimal | number | null;
}

/**
 * Add stock to a branch and re-average its cost, atomically.
 *
 * `company_id` is written out explicitly because raw SQL does not pass through
 * the tenant extension that normally guarantees it.
 */
export async function receiveQuantityAtCost(
  tx: RawCapable,
  args: ReceiveQuantityArgs,
): Promise<void> {
  if (!Number.isInteger(args.received) || args.received <= 0) {
    throw new Error(`receiveQuantityAtCost: received must be a positive integer, got ${args.received}`);
  }

  await tx.$executeRaw(Prisma.sql`
    INSERT INTO stock_items
      (id, company_id, product_id, branch_id, quantity, cost, price,
       reserved_quantity, version, created_at, updated_at)
    VALUES
      (${newUuidV7Bin()}, ${args.companyId}, ${args.productId}, ${args.branchId},
       ${args.received}, ${args.unitCost}, ${args.priceIfNew ?? null},
       0, 0, NOW(6), NOW(6)) AS incoming
    ON DUPLICATE KEY UPDATE
      cost     = (stock_items.quantity * stock_items.cost
                  + incoming.quantity * incoming.cost)
                 / (stock_items.quantity + incoming.quantity),
      quantity = stock_items.quantity + incoming.quantity,
      updated_at = NOW(6)`);
}

/**
 * What a branch should charge for stock it has never priced.
 *
 * Its OWN price decision, never the sender's or the supplier's: the branch's
 * variant price if it has one, else the catalogue default, else nothing at all.
 * Returning `null` is a real answer — Sell then asks for a price instead of
 * quietly charging one nobody set.
 */
export async function priceForNewStockRow(
  tx: {
    branchVariantPrice: { findFirst(args: unknown): Promise<{ price: Prisma.Decimal } | null> };
    product: { findUnique(args: unknown): Promise<{ defaultPrice: Prisma.Decimal | null } | null> };
  },
  args: { companyId: Buffer; productId: Buffer; branchId: Buffer },
): Promise<Prisma.Decimal | null> {
  const [variant, product] = await Promise.all([
    tx.branchVariantPrice.findFirst({
      where: { companyId: args.companyId, productId: args.productId, branchId: args.branchId },
      select: { price: true },
    }),
    tx.product.findUnique({ where: { id: args.productId }, select: { defaultPrice: true } }),
  ]);
  return variant?.price ?? product?.defaultPrice ?? null;
}
