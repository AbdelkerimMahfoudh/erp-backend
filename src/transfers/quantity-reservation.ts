import { Prisma } from '@prisma/client';

/**
 * Reserving and releasing quantity stock, as single conditional statements.
 *
 * Every function here is one SQL statement whose WHERE clause carries the rule
 * it is enforcing. That is the whole point: a read followed by an update cannot
 * promise anything, because the row is free when you look and taken when you
 * write. MySQL locks the row for the duration of an UPDATE, so a competing
 * transaction blocks, re-evaluates the condition against the committed result,
 * and matches nothing.
 *
 * These take a raw-capable client rather than the model API because Prisma
 * cannot express `quantity - reserved_quantity >= ?` in a `where` — the
 * comparison is between two columns of the same row. **`company_id` is written
 * out in every statement**, since raw SQL does not pass through the tenant
 * extension that normally guarantees it.
 */

export interface RawCapable {
  $executeRaw(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]): Promise<number>;
}

/**
 * Promise `wanted` of one product at one branch, if that much is genuinely free.
 *
 * Returns true when exactly one row was claimed. `quantity` is never touched —
 * the goods are still physically there and still the company's; only how much
 * of them may be sold changes.
 */
export async function reserveQuantity(
  tx: RawCapable,
  args: { companyId: Buffer; productId: Buffer; branchId: Buffer; wanted: number },
): Promise<boolean> {
  const changed = await tx.$executeRaw(Prisma.sql`
    UPDATE stock_items
       SET reserved_quantity = reserved_quantity + ${args.wanted},
           updated_at = NOW(6)
     WHERE company_id = ${args.companyId}
       AND product_id = ${args.productId}
       AND branch_id  = ${args.branchId}
       AND quantity - reserved_quantity >= ${args.wanted}`);
  return changed === 1;
}

/**
 * Hand back a reservation this transfer is holding.
 *
 * Guarded on `reserved_quantity >= amount` so a repeated release cannot drive
 * the counter below zero and free stock that something else has since claimed:
 * the second run matches nothing and changes nothing.
 */
export async function releaseQuantity(
  tx: RawCapable,
  args: { companyId: Buffer; productId: Buffer; branchId: Buffer; amount: number },
): Promise<boolean> {
  const changed = await tx.$executeRaw(Prisma.sql`
    UPDATE stock_items
       SET reserved_quantity = reserved_quantity - ${args.amount},
           updated_at = NOW(6)
     WHERE company_id = ${args.companyId}
       AND product_id = ${args.productId}
       AND branch_id  = ${args.branchId}
       AND reserved_quantity >= ${args.amount}`);
  return changed === 1;
}

/**
 * Ship: take the goods off the shelf and out of the reservation at once.
 *
 * Both counters move in the same statement because they describe one event. If
 * the physical quantity dropped without the reservation dropping with it, the
 * branch would look like it still owed the stock to somebody — and the
 * `reserved_quantity <= quantity` CHECK would eventually reject an unrelated
 * write, blaming the wrong operation.
 *
 * Conditional on the reservation still being there, so a shipment cannot
 * proceed against stock that was released underneath it.
 */
export async function shipQuantity(
  tx: RawCapable,
  args: { companyId: Buffer; productId: Buffer; branchId: Buffer; amount: number },
): Promise<boolean> {
  const changed = await tx.$executeRaw(Prisma.sql`
    UPDATE stock_items
       SET quantity          = quantity - ${args.amount},
           reserved_quantity = reserved_quantity - ${args.amount},
           updated_at        = NOW(6)
     WHERE company_id = ${args.companyId}
       AND product_id = ${args.productId}
       AND branch_id  = ${args.branchId}
       AND reserved_quantity >= ${args.amount}
       AND quantity          >= ${args.amount}`);
  return changed === 1;
}
