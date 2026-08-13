import { Prisma } from '@prisma/client';

/**
 * What shipped stock is worth while it is between two branches.
 *
 * **This exists because the money was disappearing.** `inventory_valuation` is
 * keyed on `(company, branch)` and counts units that are `in_stock` and stock
 * rows with a positive quantity. A shipped serialized unit is `in_transit` and
 * keeps its old `branch_id` until receipt, so it left the source total and
 * never joined the destination one; a shipped quantity line is gone from the
 * source row outright. Between ship and receive, real goods the company owns
 * were worth nothing to any report — since H1.3 for phones, and H1.4 would have
 * done the same for accessories.
 *
 * So the value is computed from the movement itself:
 *
 * - **serialized:** the unit's own `cost`, the same figure the source branch
 *   was counting the moment before it shipped;
 * - **quantity:** `quantity * shipped_unit_cost`, the snapshot taken at
 *   shipment, so it cannot drift when the source's cost later changes.
 *
 * It is attributed to the **source** branch, because that is the branch that
 * let the goods go and the one that has to answer for them if they never
 * arrive. It is reported as its own figure, never folded into stock physically
 * held: a branch counting its shelves must not be told it holds something that
 * left the building.
 *
 * `company total = branch-held + in-transit` therefore holds across the whole
 * movement, with nothing counted twice.
 */

export interface InTransitRow {
  fromBranchId: Buffer;
  toBranchId: Buffer;
  value: number;
  unitsCount: number;
  quantity: number;
}

export interface RawQueryable {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
}

interface RawRow {
  from_branch_id: Buffer;
  to_branch_id: Buffer;
  value: Prisma.Decimal | number | null;
  units_count: bigint | number | null;
  quantity: bigint | number | null;
}

const toNum = (v: bigint | number | Prisma.Decimal | null): number => (v == null ? 0 : Number(v));

/**
 * Every in-transit movement of one company, grouped by the pair of branches.
 *
 * Written as SQL rather than assembled in the application because it spans
 * `stock_transfers`, `transfer_items` and `units`, and summing that in
 * JavaScript would mean loading every line of every open transfer to add up two
 * numbers.
 *
 * `company_id` is written out explicitly: raw SQL does not pass through the
 * tenant extension that scopes the model API.
 */
export async function inTransitValue(
  db: RawQueryable,
  companyId: Buffer,
): Promise<InTransitRow[]> {
  const rows = await db.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT t.from_branch_id,
           t.to_branch_id,
           COALESCE(SUM(
             CASE WHEN ti.unit_id IS NOT NULL THEN u.cost
                  ELSE ti.quantity * ti.shipped_unit_cost
             END), 0)                                              AS value,
           COALESCE(SUM(CASE WHEN ti.unit_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS units_count,
           COALESCE(SUM(CASE WHEN ti.unit_id IS NULL THEN ti.quantity ELSE 0 END), 0) AS quantity
      FROM stock_transfers t
      JOIN transfer_items ti ON ti.transfer_id = t.id
      LEFT JOIN units u      ON u.id = ti.unit_id
     WHERE t.company_id = ${companyId}
       AND t.status = 'in_transit'
     GROUP BY t.from_branch_id, t.to_branch_id`);

  return rows.map((r) => ({
    fromBranchId: r.from_branch_id,
    toBranchId: r.to_branch_id,
    value: toNum(r.value),
    unitsCount: toNum(r.units_count),
    quantity: toNum(r.quantity),
  }));
}

/**
 * Fold the rows into what a report needs.
 *
 * With no branch filter the caller is looking at the whole company, so every
 * movement counts once. With a branch filter it is looking at one branch's
 * position: `outbound` is what this branch has let go and not yet seen
 * confirmed, `inbound` is what is coming to it. **Only outbound is added to a
 * company total**, because adding both would count every movement twice.
 */
export function summarizeInTransit(
  rows: InTransitRow[],
  branchId: Buffer | null,
): { value: number; outbound: number; inbound: number; unitsCount: number; quantity: number } {
  let outbound = 0;
  let inbound = 0;
  let unitsCount = 0;
  let quantity = 0;

  for (const r of rows) {
    const isOut = branchId ? r.fromBranchId.equals(branchId) : true;
    const isIn = branchId ? r.toBranchId.equals(branchId) : false;
    if (isOut) {
      outbound += r.value;
      unitsCount += r.unitsCount;
      quantity += r.quantity;
    }
    if (isIn) inbound += r.value;
  }
  return { value: outbound, outbound, inbound, unitsCount, quantity };
}
