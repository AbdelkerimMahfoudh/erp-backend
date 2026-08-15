import { Injectable } from '@nestjs/common';
import { Prisma, TrackingType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import { heldValueRows } from './held-value';

/** Coerce a raw SQL aggregate (Decimal string | bigint | null) to a number. */
function toNum(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object' && typeof (v as { toNumber?: () => number }).toNumber === 'function') {
    return (v as { toNumber: () => number }).toNumber();
  }
  return Number(v as number | string);
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

interface RefundPaidRow {
  paid_total: unknown;
  paid_cash: unknown;
  paid_count: unknown;
}

interface ReturnTotalsRow {
  gross: unknown;
  adjustments: unknown;
  cogs_credited: unknown;
  returns_count: unknown;
}

interface StoreTotalsRow {
  revenue: unknown;
  cogs: unknown;
  qty_sold: unknown;
  sales_count: unknown;
}

interface ProductRollupRow {
  product_id: Buffer;
  category_id: Buffer | null;
  tracking_type: TrackingType;
  qty_sold: unknown;
  revenue: unknown;
  cogs: unknown;
}

interface VelocityRow {
  product_id: Buffer;
  sold_7d: unknown;
  sold_30d: unknown;
  last_sold_at: Date | null;
}

interface ValuationSourceRow {
  kind: 'unit' | 'stock';
  product_id: Buffer;
  category_id: Buffer | null;
  tracking_type: TrackingType;
  units_count?: unknown;
  quantity?: unknown;
  inv_value: unknown;
  exp_rev: unknown;
}

interface ValuationAcc {
  categoryId: Buffer | null;
  trackingType: TrackingType;
  unitsCount: number;
  quantity: number;
  inventoryValue: number;
  expectedRevenue: number;
}

/**
 * Recomputes analytics rollups from the source-of-truth tables. Uses the
 * SYSTEM Prisma client (no tenant CLS) so it can run from a background worker
 * later; every query is filtered by an explicit company_id.
 *
 * TRACKING-TYPE INDEPENDENT: all figures derive from `sale_items`
 * (price/cost/discount/quantity). The product for a line is resolved as
 * COALESCE(sale_item.product_id, unit.product_id), so IMEI, serial, and
 * quantity lines flow through identical math — no identifier is ever read.
 */
@Injectable()
export class RollupService {
  constructor(private readonly prisma: PrismaService) {}

  async recomputeDaily(companyId: Buffer, branchId: Buffer, day: string): Promise<void> {
    const start = new Date(`${day}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 86_400_000);
    const dayDate = new Date(`${day}T00:00:00.000Z`);
    const now = new Date();

    // 1. Store totals for the branch-day (voided lines excluded).
    const totals = await this.prisma.$queryRaw<StoreTotalsRow[]>(Prisma.sql`
      SELECT COALESCE(SUM(si.price * si.quantity - si.discount), 0) AS revenue,
             COALESCE(SUM(si.cost * si.quantity), 0)                AS cogs,
             COALESCE(SUM(si.quantity), 0)                          AS qty_sold,
             COUNT(DISTINCT s.id)                                   AS sales_count
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      WHERE si.company_id = ${companyId}
        AND s.branch_id = ${branchId}
        AND si.voided = 0
        AND s.sold_at >= ${start} AND s.sold_at < ${end}
    `);
    const expRows = await this.prisma.$queryRaw<Array<{ expenses: unknown }>>(Prisma.sql`
      SELECT COALESCE(SUM(amount), 0) AS expenses
      FROM expenses
      WHERE company_id = ${companyId} AND branch_id = ${branchId} AND spent_on = ${day}
    `);

    /**
     * Returns approved ON THIS DAY (I2).
     *
     * Keyed on `approval_date`, never on the sale's day — that is precisely what
     * lets the original day recompute byte-identically and keeps a closed day
     * closed. The legacy endpoint did the opposite: it set `voided = true`, and
     * because the query above filters `si.voided = 0`, every return silently
     * rewrote a past day's revenue and profit.
     *
     * ## What is reversed, and what is deliberately not
     *
     * Revenue falls by the NET refund due — the money actually going back.
     * Anything withheld as an adjustment (a consumed screen protector) is money
     * the shop keeps, so it stays as revenue.
     *
     * COGS is NOT credited back. The returned phone is held as `faulty` and is
     * unsellable, and `held-value` counts only `in_stock`, so the goods are not
     * an asset again. Crediting the cost here while the asset is absent from
     * inventory would book the benefit twice and overstate profit. Cost recovery
     * belongs to the later inspection milestone, when the phone either returns
     * to sellable stock or is written off — and `returns_cogs` exists for that
     * day.
     *
     * So the profit impact of an approved return is the full net refund. That is
     * the conservative reading, and the one that cannot flatter a month.
     */
    const returnRows = await this.prisma.$queryRaw<ReturnTotalsRow[]>(Prisma.sql`
      SELECT COALESCE(SUM(gross_refund), 0)     AS gross,
             COALESCE(SUM(adjustment_total), 0) AS adjustments,
             COALESCE(SUM(line_cost), 0)        AS cogs_credited,
             COUNT(*)                           AS returns_count
      FROM return_reversals
      WHERE company_id = ${companyId}
        AND branch_id = ${branchId}
        AND approval_date = ${day}
    `);
    // Components, all POSITIVE magnitudes; each consumer applies its own sign.
    const returnsRevenue = round2(toNum(returnRows[0].gross));
    const returnsAdjustments = round2(toNum(returnRows[0].adjustments));
    const returnsCogs = round2(toNum(returnRows[0].cogs_credited));
    const returnsCount = toNum(returnRows[0].returns_count);
    /**
     * The profit effect of the day's returns, as a positive REDUCTION:
     *
     *   effect = gross refund − adjustments kept − COGS credited back
     *
     * so net profit subtracts it. Across a sale and its return this leaves
     * cumulative profit equal to the adjustments alone:
     *
     *   sale    + gross − cost
     *   return  − gross + adjustments + cost
     *   ------------------------------------
     *   total   + adjustments
     *
     * The COGS credit is what makes that true. The phone is unsellable but the
     * shop still owns it, and its cost is reinstated as faulty/return-held
     * inventory value (see `faultyHeldValue`). Writing the asset to zero here
     * would be a full impairment decided before anyone inspected the phone —
     * which is the LATER milestone's call, not this one's.
     */
    const returnsGrossProfit = round2(returnsRevenue - returnsAdjustments - returnsCogs);

    /**
     * Refunds CONFIRMED on this day (I3) — money leaving the till.
     *
     * Keyed on `confirmation_date`, which is a different day from the approval
     * that reversed the profit. That separation is the whole point:
     *
     *   approval day     profit reverses, a liability appears
     *   confirmation day cash moves, the liability settles
     *
     * There is deliberately NO profit component here. Profit was already
     * reversed at approval, and subtracting it again at payout would count the
     * same loss twice — the single easiest mistake to make in this phase.
     */
    const refundRows = await this.prisma.$queryRaw<RefundPaidRow[]>(Prisma.sql`
      SELECT COALESCE(SUM(reported_amount), 0)                                     AS paid_total,
             COALESCE(SUM(CASE WHEN method = 'cash' THEN reported_amount END), 0)   AS paid_cash,
             COUNT(*)                                                              AS paid_count
      FROM refund_payouts
      WHERE company_id = ${companyId}
        AND branch_id = ${branchId}
        AND status = 'confirmed'
        AND confirmation_date = ${day}
    `);
    const refundsPaidTotal = round2(toNum(refundRows[0].paid_total));
    const refundsPaidCash = round2(toNum(refundRows[0].paid_cash));
    const refundsPaidCount = toNum(refundRows[0].paid_count);

    const revenue = round2(toNum(totals[0].revenue));
    const cogs = round2(toNum(totals[0].cogs));
    const grossProfit = round2(revenue - cogs);
    const expenses = round2(toNum(expRows[0].expenses));
    // Positive magnitudes, subtracted explicitly. A negative stored revenue
    // would leave every reader guessing whether the sign was already applied.
    const netProfit = round2(grossProfit - returnsGrossProfit - expenses);

    await this.prisma.dailyRollup.upsert({
      where: { branchId_day: { branchId, day: dayDate } },
      create: {
        id: newUuidV7Bin(),
        companyId,
        branchId,
        day: dayDate,
        revenue,
        cogs,
        grossProfit,
        salesCount: toNum(totals[0].sales_count),
        qtySold: toNum(totals[0].qty_sold),
        expenses,
        netProfit,
        returnsRevenue,
        returnsCogs,
        returnsAdjustments,
        returnsGrossProfit,
        returnsCount,
        refundsPaidTotal,
        refundsPaidCash,
        refundsPaidCount,
        refreshedAt: now,
      },
      update: {
        revenue,
        cogs,
        grossProfit,
        salesCount: toNum(totals[0].sales_count),
        qtySold: toNum(totals[0].qty_sold),
        expenses,
        netProfit,
        returnsRevenue,
        returnsCogs,
        returnsAdjustments,
        returnsGrossProfit,
        returnsCount,
        refundsPaidTotal,
        refundsPaidCash,
        refundsPaidCount,
        refreshedAt: now,
      },
    });

    // 2. Per-product fact — product resolved via COALESCE so serialized units
    //    (product_id NULL, unit_id set) and quantity lines aggregate the same.
    const rows = await this.prisma.$queryRaw<ProductRollupRow[]>(Prisma.sql`
      SELECT COALESCE(si.product_id, u.product_id) AS product_id,
             p.category_id                         AS category_id,
             p.tracking_type                       AS tracking_type,
             SUM(si.quantity)                      AS qty_sold,
             SUM(si.price * si.quantity - si.discount) AS revenue,
             SUM(si.cost * si.quantity)            AS cogs
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      LEFT JOIN units u ON u.id = si.unit_id
      JOIN products p ON p.id = COALESCE(si.product_id, u.product_id)
      WHERE si.company_id = ${companyId}
        AND s.branch_id = ${branchId}
        AND si.voided = 0
        AND s.sold_at >= ${start} AND s.sold_at < ${end}
      GROUP BY product_id, p.category_id, p.tracking_type
    `);

    // Rebuild the branch-day product facts (delete + insert = current truth).
    await this.prisma.productDailyRollup.deleteMany({ where: { branchId, day: dayDate } });
    if (rows.length > 0) {
      await this.prisma.productDailyRollup.createMany({
        data: rows.map((r) => {
          const rev = round2(toNum(r.revenue));
          const c = round2(toNum(r.cogs));
          return {
            id: newUuidV7Bin(),
            companyId,
            branchId,
            day: dayDate,
            productId: r.product_id,
            categoryId: r.category_id ?? null,
            trackingType: r.tracking_type,
            qtySold: toNum(r.qty_sold),
            revenue: rev,
            cogs: c,
            grossProfit: round2(rev - c),
            refreshedAt: now,
          };
        }),
      });
    }
  }

  /**
   * Movement signal per product at a branch: units sold in the last 7 / 30 days
   * and the last sale time. Tracking-type independent (COALESCE resolves the
   * product for serialized lines). Products never sold have no row.
   */
  async recomputeVelocity(companyId: Buffer, branchId: Buffer): Promise<void> {
    const now = new Date();
    const d7 = new Date(now.getTime() - 7 * 86_400_000);
    const d30 = new Date(now.getTime() - 30 * 86_400_000);

    const rows = await this.prisma.$queryRaw<VelocityRow[]>(Prisma.sql`
      SELECT COALESCE(si.product_id, u.product_id) AS product_id,
             SUM(CASE WHEN s.sold_at >= ${d7}  THEN si.quantity ELSE 0 END) AS sold_7d,
             SUM(CASE WHEN s.sold_at >= ${d30} THEN si.quantity ELSE 0 END) AS sold_30d,
             MAX(s.sold_at) AS last_sold_at
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      LEFT JOIN units u ON u.id = si.unit_id
      WHERE si.company_id = ${companyId} AND s.branch_id = ${branchId} AND si.voided = 0
      GROUP BY product_id
    `);

    await this.prisma.productVelocity.deleteMany({ where: { companyId, branchId } });
    if (rows.length > 0) {
      await this.prisma.productVelocity.createMany({
        data: rows.map((r) => ({
          id: newUuidV7Bin(),
          companyId,
          branchId,
          productId: r.product_id,
          sold7d: toNum(r.sold_7d),
          sold30d: toNum(r.sold_30d),
          lastSoldAt: r.last_sold_at ? new Date(r.last_sold_at) : null,
          refreshedAt: now,
        })),
      });
    }
  }

  /**
   * Current $ invested + expected profit per product at a branch, combining
   * BOTH storage shapes: in-stock individual units (units.cost, expected at
   * products.default_price) and quantity stock (stock_items.qty × cost, expected
   * at stock_items.price). Uniform across tracking types.
   */
  async recomputeInventoryValuation(companyId: Buffer, branchId: Buffer): Promise<void> {
    const now = new Date();

    /**
     * The same query the live report runs (H1.4.1). Both go through
     * `heldValueRows` so the stored figure and the reported figure cannot drift
     * into two different definitions of what stock is worth.
     */
    const rows = await heldValueRows(this.prisma, { companyId, branchId });

    const byProduct = new Map<string, ValuationAcc & { productId: Buffer }>();
    const merge = (r: ValuationSourceRow, isUnit: boolean) => {
      const key = r.product_id.toString('hex');
      const acc =
        byProduct.get(key) ??
        {
          productId: r.product_id,
          categoryId: r.category_id ?? null,
          trackingType: r.tracking_type,
          unitsCount: 0,
          quantity: 0,
          inventoryValue: 0,
          expectedRevenue: 0,
        };
      if (isUnit) acc.unitsCount += toNum(r.units_count);
      else acc.quantity += toNum(r.quantity);
      acc.inventoryValue += toNum(r.inv_value);
      acc.expectedRevenue += toNum(r.exp_rev);
      byProduct.set(key, acc);
    };
    rows.forEach((r) => merge(r, r.kind === 'unit'));

    await this.prisma.inventoryValuation.deleteMany({ where: { companyId, branchId } });
    if (byProduct.size > 0) {
      await this.prisma.inventoryValuation.createMany({
        data: [...byProduct.values()].map((a) => {
          const inventoryValue = round2(a.inventoryValue);
          const expectedRevenue = round2(a.expectedRevenue);
          return {
            id: newUuidV7Bin(),
            companyId,
            branchId,
            productId: a.productId,
            categoryId: a.categoryId,
            trackingType: a.trackingType,
            unitsCount: a.unitsCount,
            quantity: a.quantity,
            inventoryValue,
            expectedRevenue,
            expectedProfit: round2(expectedRevenue - inventoryValue),
            refreshedAt: now,
          };
        }),
      });
    }
  }

  /** Refresh both branch snapshots (valuation + velocity). */
  async refreshBranch(companyId: Buffer, branchId: Buffer): Promise<void> {
    await this.recomputeInventoryValuation(companyId, branchId);
    await this.recomputeVelocity(companyId, branchId);
  }
}
