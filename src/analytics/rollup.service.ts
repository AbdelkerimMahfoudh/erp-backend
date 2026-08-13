import { Injectable } from '@nestjs/common';
import { Prisma, TrackingType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';

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

    const revenue = round2(toNum(totals[0].revenue));
    const cogs = round2(toNum(totals[0].cogs));
    const grossProfit = round2(revenue - cogs);
    const expenses = round2(toNum(expRows[0].expenses));
    const netProfit = round2(grossProfit - expenses);

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

    const unitRows = await this.prisma.$queryRaw<ValuationSourceRow[]>(Prisma.sql`
      SELECT p.id AS product_id, p.category_id, p.tracking_type,
             COUNT(*)                          AS units_count,
             SUM(u.cost)                       AS inv_value,
             SUM(COALESCE(p.default_price, 0)) AS exp_rev
      FROM units u
      JOIN products p ON p.id = u.product_id
      WHERE u.company_id = ${companyId} AND u.branch_id = ${branchId} AND u.status = 'in_stock'
      GROUP BY p.id, p.category_id, p.tracking_type
    `);
    const stockRows = await this.prisma.$queryRaw<ValuationSourceRow[]>(Prisma.sql`
      SELECT p.id AS product_id, p.category_id, p.tracking_type,
             si.quantity                                      AS quantity,
             si.quantity * si.cost                            AS inv_value,
             -- si.price is nullable since 0034: stock a transfer delivered into
             -- a branch that has never priced it. Without COALESCE the whole
             -- product's expected revenue would go NULL and silently vanish
             -- from the total. Falling back to the catalogue default and then
             -- to 0 states the truth: no price set means no revenue can be
             -- expected from it yet. Cost, and therefore inventory VALUE, is
             -- unaffected -- the goods are owned and counted regardless.
             si.quantity * COALESCE(si.price, p.default_price, 0) AS exp_rev
      FROM stock_items si
      JOIN products p ON p.id = si.product_id
      WHERE si.company_id = ${companyId} AND si.branch_id = ${branchId} AND si.quantity > 0
    `);

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
    unitRows.forEach((r) => merge(r, true));
    stockRows.forEach((r) => merge(r, false));

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
