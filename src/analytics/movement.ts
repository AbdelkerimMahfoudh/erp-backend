import { Prisma } from '@prisma/client';
import type { RawRunner } from './period-figures';

/**
 * How each product is moving, read from the sales that stand (docs/54 D39):
 *
 *   sold in 30 days  units on sales of the last 30 dates (business dates, today included)
 *   last sold        when the latest of those sales was made
 *   not moving       in stock, and no such sale for the shop's `dead_stock_days`
 *
 * A **cancelled** sale is left out wherever it falls: its goods never left the shop,
 * so it is not movement — unlike the accounting figures, which keep it on its sale
 * date and take it off on its approval date. A **returned** item still counts as
 * sold: it sold, and came back as a separate event, which the product report counts
 * as a return.
 *
 * Read when asked. It used to be a snapshot rebuilt on stock events, so "the last 30
 * days" ended at the last sale or receipt — a quiet week left sales older than 30
 * days in the count.
 */
export interface ProductMovement {
  sold30d: number;
  lastSoldAt: Date | null;
}

export async function productMovement(
  db: RawRunner,
  companyId: Buffer,
  branchId: Buffer | null,
  since: string,
): Promise<Map<string, ProductMovement>> {
  const rows = await db.$queryRaw<{ product_id: Buffer; sold_30d: unknown; last_sold_at: Date | null }[]>(Prisma.sql`
    SELECT COALESCE(si.product_id, u.product_id) AS product_id,
           COALESCE(SUM(CASE WHEN s.business_date >= ${since} THEN si.quantity ELSE 0 END), 0) AS sold_30d,
           MAX(s.sold_at) AS last_sold_at
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      LEFT JOIN units u ON u.id = si.unit_id
     WHERE si.company_id = ${companyId} ${branchId ? Prisma.sql`AND s.branch_id = ${branchId}` : Prisma.empty}
       AND si.voided = 0 AND s.is_reversed = 0
       AND NOT EXISTS (SELECT 1 FROM financial_corrections fc
                        WHERE fc.target_sale_id = s.id AND fc.target_kind = 'sale' AND fc.status = 'approved')
     GROUP BY product_id`);
  return new Map(
    rows
      .filter((r) => r.product_id)
      .map((r) => [r.product_id.toString('hex'), { sold30d: Number(r.sold_30d ?? 0), lastSoldAt: r.last_sold_at ? new Date(r.last_sold_at) : null }]),
  );
}
