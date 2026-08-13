import { Inject, Injectable } from '@nestjs/common';
import { Prisma, TrackingType } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { binToUuid } from '../common/utils/uuid.util';
import { dayKey } from '../common/utils/date.util';
import { inTransitValue, summarizeInTransit } from './in-transit-value';

const num = (d: Prisma.Decimal | number | null): number => (d == null ? 0 : Number(d));
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Read-only analytics over the rollup tables (tenant-scoped by the Prisma
 * extension). All figures are tracking-type independent — they come from
 * product_daily_rollups / inventory_valuation, never from an identifier.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
  ) {}

  /** Current $ invested + expected profit, split by tracking type and category. */
  async inventoryValue() {
    const branchId = this.tenant.branchId();
    const rows = await this.db.inventoryValuation.findMany({ where: branchId ? { branchId } : {} });

    const names = await this.categoryNames(rows.map((r) => r.categoryId));
    const totals = { inventoryValue: 0, expectedRevenue: 0, expectedProfit: 0, productCount: rows.length, unitsCount: 0, quantity: 0 };
    const byTracking = new Map<TrackingType, { inventoryValue: number; expectedProfit: number }>();
    const byCategory = new Map<string, { categoryId: string | null; name: string | null; inventoryValue: number; expectedProfit: number }>();

    for (const r of rows) {
      const iv = num(r.inventoryValue);
      const ep = num(r.expectedProfit);
      totals.inventoryValue += iv;
      totals.expectedRevenue += num(r.expectedRevenue);
      totals.expectedProfit += ep;
      totals.unitsCount += r.unitsCount;
      totals.quantity += r.quantity;

      const t = byTracking.get(r.trackingType) ?? { inventoryValue: 0, expectedProfit: 0 };
      t.inventoryValue += iv;
      t.expectedProfit += ep;
      byTracking.set(r.trackingType, t);

      const key = r.categoryId ? r.categoryId.toString('hex') : 'none';
      const c = byCategory.get(key) ?? {
        categoryId: r.categoryId ? binToUuid(r.categoryId) : null,
        name: r.categoryId ? names.get(key) ?? null : null,
        inventoryValue: 0,
        expectedProfit: 0,
      };
      c.inventoryValue += iv;
      c.expectedProfit += ep;
      byCategory.set(key, c);
    }

    /**
     * Stock that has shipped and not yet arrived, added back.
     *
     * `inventory_valuation` counts what a branch physically holds, so goods in
     * transit belong to no row in it — and were therefore worth nothing to this
     * report between ship and receive. They are reported as their **own**
     * figure, and `inventoryValue` (held) is left meaning exactly what it says,
     * so a branch counting its shelves is never told it holds something that
     * left the building.
     */
    const transit = summarizeInTransit(
      await inTransitValue(this.db, this.tenant.companyId()),
      branchId ?? null,
    );

    return {
      totals: {
        /** What this branch — or the company — physically holds. */
        inventoryValue: round2(totals.inventoryValue),
        /** Shipped, not yet received. Counted against the branch that sent it. */
        inTransitValue: round2(transit.value),
        /**
         * The number that must not move when stock is merely travelling:
         * held + in transit. Shipment takes value out of `inventoryValue` and
         * puts the same amount into `inTransitValue`; receipt does the reverse
         * at the other end.
         */
        totalStockValue: round2(totals.inventoryValue + transit.value),
        inTransit: {
          outboundValue: round2(transit.outbound),
          inboundValue: round2(transit.inbound),
          unitsCount: transit.unitsCount,
          quantity: transit.quantity,
        },
        expectedRevenue: round2(totals.expectedRevenue),
        expectedProfit: round2(totals.expectedProfit),
        productCount: totals.productCount,
        unitsCount: totals.unitsCount,
        quantity: totals.quantity,
      },
      byTrackingType: [...byTracking.entries()].map(([trackingType, v]) => ({
        trackingType,
        inventoryValue: round2(v.inventoryValue),
        expectedProfit: round2(v.expectedProfit),
      })),
      byCategory: [...byCategory.values()].map((c) => ({
        categoryId: c.categoryId,
        name: c.name,
        inventoryValue: round2(c.inventoryValue),
        expectedProfit: round2(c.expectedProfit),
      })),
    };
  }

  /** Per-product performance over a window, with movement + labels. */
  async productPerformance(days = 30) {
    const branchId = this.tenant.branchId();
    const from = this.windowStart(days);
    const grouped = await this.db.productDailyRollup.groupBy({
      by: ['productId'],
      where: { day: { gte: from }, ...(branchId ? { branchId } : {}) },
      _sum: { qtySold: true, revenue: true, cogs: true, grossProfit: true },
    });

    const productIds = grouped.map((g) => g.productId);
    const products = productIds.length
      ? await this.db.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, brand: true, model: true, variant: true, trackingType: true },
        })
      : [];
    const productByHex = new Map(products.map((p) => [p.id.toString('hex'), p]));
    const velocity = productIds.length
      ? await this.db.productVelocity.findMany({ where: { productId: { in: productIds }, ...(branchId ? { branchId } : {}) } })
      : [];
    const velByHex = new Map(velocity.map((v) => [v.productId.toString('hex'), v]));

    return {
      windowDays: days,
      products: grouped
        .map((g) => {
          const hex = g.productId.toString('hex');
          const p = productByHex.get(hex);
          const v = velByHex.get(hex);
          return {
            productId: binToUuid(g.productId),
            label: p ? `${p.brand} ${p.model}${p.variant ? ` ${p.variant}` : ''}` : null,
            trackingType: p?.trackingType ?? null,
            qtySold: num(g._sum.qtySold),
            revenue: round2(num(g._sum.revenue)),
            cogs: round2(num(g._sum.cogs)),
            grossProfit: round2(num(g._sum.grossProfit)),
            sold30d: v?.sold30d ?? 0,
            lastSoldAt: v?.lastSoldAt ?? null,
          };
        })
        .sort((a, b) => b.grossProfit - a.grossProfit),
    };
  }

  /** Per-category performance over a window. */
  async categoryPerformance(days = 30) {
    const branchId = this.tenant.branchId();
    const from = this.windowStart(days);
    const grouped = await this.db.productDailyRollup.groupBy({
      by: ['categoryId'],
      where: { day: { gte: from }, ...(branchId ? { branchId } : {}) },
      _sum: { qtySold: true, revenue: true, cogs: true, grossProfit: true },
    });

    const names = await this.categoryNames(grouped.map((g) => g.categoryId));
    return {
      windowDays: days,
      categories: grouped
        .map((g) => ({
          categoryId: g.categoryId ? binToUuid(g.categoryId) : null,
          name: g.categoryId ? names.get(g.categoryId.toString('hex')) ?? null : 'Uncategorized',
          qtySold: num(g._sum.qtySold),
          revenue: round2(num(g._sum.revenue)),
          cogs: round2(num(g._sum.cogs)),
          grossProfit: round2(num(g._sum.grossProfit)),
        }))
        .sort((a, b) => b.grossProfit - a.grossProfit),
    };
  }

  private windowStart(days: number): Date {
    const start = new Date(Date.now() - (days - 1) * 86_400_000);
    return new Date(`${dayKey(start)}T00:00:00.000Z`);
  }

  private async categoryNames(ids: (Buffer | null)[]): Promise<Map<string, string>> {
    const catIds = ids.filter((b): b is Buffer => b != null);
    if (catIds.length === 0) return new Map();
    const cats = await this.db.productCategory.findMany({ where: { id: { in: catIds } }, select: { id: true, name: true } });
    return new Map(cats.map((c) => [c.id.toString('hex'), c.name]));
  }
}
