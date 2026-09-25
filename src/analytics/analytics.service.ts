import { Inject, Injectable } from '@nestjs/common';
import { Prisma, TrackingType } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { binToUuid } from '../common/utils/uuid.util';
import { dayKey } from '../common/utils/date.util';
import { inTransitValue, summarizeInTransit } from './in-transit-value';
import { faultyHeldValue, heldValueRows, toNum } from './held-value';
import { productAdjustments } from './period-figures';
import { productMovement, type ProductMovement } from './movement';

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

  /**
   * Current $ invested + expected profit, split by tracking type and category.
   *
   * Computed **live from the source tables** (H1.4.1), not from the
   * `inventory_valuation` rollup it used to read. The rollup is rebuilt by a
   * fire-and-forget queue whose failures are logged and swallowed, so the held
   * figure could lag — or, if the refresh threw or the process died first, stay
   * wrong indefinitely. That is tolerable for a ranking and not for a reported
   * total: `totalStockValue` below is documented as the number that must not
   * move when stock is merely travelling, and it was mixing this stale half
   * with a live in-transit half, which is exactly how it moved anyway.
   *
   * Both halves now come from source, so the invariant holds at the instant the
   * request is served rather than eventually.
   */
  async inventoryValue() {
    const branchId = this.tenant.branchId();
    /**
     * Owned but unsellable: phones held after an approved return, awaiting
     * inspection (I2-CP4.1). Fetched separately and reported separately —
     * "what can I sell?" must never include one, and "what do I own?" must
     * never exclude one.
     */
    const faulty = await faultyHeldValue(this.db, {
      companyId: this.tenant.companyId(),
      branchId,
    });
    const rows = (
      await heldValueRows(this.db, { companyId: this.tenant.companyId(), branchId })
    ).map((r) => ({
      productId: r.product_id,
      categoryId: r.category_id,
      trackingType: r.tracking_type,
      unitsCount: toNum(r.units_count),
      quantity: toNum(r.quantity),
      inventoryValue: toNum(r.inv_value),
      expectedRevenue: toNum(r.exp_rev),
      expectedProfit: toNum(r.exp_rev) - toNum(r.inv_value),
    }));

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
        /**
         * The same figure under the name that says what it is. `inventoryValue`
         * has always meant SELLABLE stock; a returned phone must never inflate
         * it, or a dead-stock report would offer a faulty device for sale.
         */
        sellableInventoryValue: round2(totals.inventoryValue),
        /**
         * Held after a return, unsellable, still owned. This is the cost that
         * was credited back to COGS when the return was approved — the same
         * money, counted once, reinstated as an asset rather than written off
         * before anyone inspected the phone.
         */
        faultyHeldValue: round2(faulty.inventoryValue),
        faultyHeldUnits: faulty.unitsCount,
        /**
         * Everything the shop owns: sellable + travelling + held faulty. The
         * one figure an owner asking "what are my goods worth?" wants, and the
         * one nobody should use to decide what can be sold.
         */
        totalOwnedInventoryValue: round2(
          totals.inventoryValue + transit.value + faulty.inventoryValue,
        ),
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

  /**
   * Per-product performance over a window, with movement + labels (docs/53 D34).
   *
   * The product facts of the window's sale days, less the cancellations and returns APPROVED in
   * the window, each product carrying its own lines: units sold = units invoiced − units of
   * cancelled invoices (a return is `unitsReturned`, its own measure); revenue loses a cancelled
   * line's revenue and a return's net refund due; cost loses what each gives back. A product whose
   * only movement in the window is an adjustment appears, with negative figures.
   */
  async productPerformance(days = 30) {
    const branchId = this.tenant.branchId() ?? null;
    const from = this.windowStart(days);
    const [grouped, adjustments] = await Promise.all([
      this.db.productDailyRollup.groupBy({
        by: ['productId'],
        where: { day: { gte: from }, ...(branchId ? { branchId } : {}) },
        _sum: { qtySold: true, revenue: true, cogs: true },
      }),
      productAdjustments(this.db, this.tenant.companyId(), branchId, dayKey(from)),
    ]);

    const rows = new Map<string, { productId: Buffer; qty: number; returned: number; revenue: number; cogs: number }>();
    for (const g of grouped) {
      rows.set(g.productId.toString('hex'), { productId: g.productId, qty: num(g._sum.qtySold), returned: 0, revenue: num(g._sum.revenue), cogs: num(g._sum.cogs) });
    }
    for (const a of adjustments) {
      const key = a.productId.toString('hex');
      const r = rows.get(key) ?? { productId: a.productId, qty: 0, returned: 0, revenue: 0, cogs: 0 };
      r.qty -= a.cancelledUnits;
      r.returned += a.returnedUnits;
      r.revenue -= a.cancelledRevenue + a.returnedRevenue;
      r.cogs -= a.cancelledCogs + a.returnedCostCredited;
      rows.set(key, r);
    }

    const productIds = [...rows.values()].map((r) => r.productId);
    const products = productIds.length
      ? await this.db.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, brand: true, model: true, variant: true, trackingType: true },
        })
      : [];
    const productByHex = new Map(products.map((p) => [p.id.toString('hex'), p]));
    // Sold in the last 30 days and last sold: from the sales that stand, read now (docs/54 D39).
    const velByHex = productIds.length
      ? await productMovement(this.db, this.tenant.companyId(), branchId, dayKey(this.windowStart(30)))
      : new Map<string, ProductMovement>();

    return {
      windowDays: days,
      products: [...rows.entries()]
        .map(([hex, r]) => {
          const p = productByHex.get(hex);
          const v = velByHex.get(hex);
          return {
            productId: binToUuid(r.productId),
            label: p ? `${p.brand} ${p.model}${p.variant ? ` ${p.variant}` : ''}` : null,
            trackingType: p?.trackingType ?? null,
            /** Units invoiced less units of cancelled invoices (R6). */
            qtySold: r.qty,
            /** Units returned in the window — their own measure (R6). */
            unitsReturned: r.returned,
            revenue: round2(r.revenue),
            cogs: round2(r.cogs),
            grossProfit: round2(r.revenue - r.cogs),
            sold30d: v?.sold30d ?? 0,
            lastSoldAt: v?.lastSoldAt ?? null,
          };
        })
        .sort((a, b) => b.grossProfit - a.grossProfit),
    };
  }

  /** Per-category performance over a window — the product report's figures, by category (docs/53 D34). */
  async categoryPerformance(days = 30) {
    const branchId = this.tenant.branchId() ?? null;
    const from = this.windowStart(days);
    const [grouped, adjustments] = await Promise.all([
      this.db.productDailyRollup.groupBy({
        by: ['categoryId'],
        where: { day: { gte: from }, ...(branchId ? { branchId } : {}) },
        _sum: { qtySold: true, revenue: true, cogs: true },
      }),
      productAdjustments(this.db, this.tenant.companyId(), branchId, dayKey(from)),
    ]);

    const rows = new Map<string, { categoryId: Buffer | null; qty: number; returned: number; revenue: number; cogs: number }>();
    for (const g of grouped) {
      rows.set(g.categoryId ? g.categoryId.toString('hex') : 'none', { categoryId: g.categoryId, qty: num(g._sum.qtySold), returned: 0, revenue: num(g._sum.revenue), cogs: num(g._sum.cogs) });
    }
    for (const a of adjustments) {
      const key = a.categoryId ? a.categoryId.toString('hex') : 'none';
      const r = rows.get(key) ?? { categoryId: a.categoryId, qty: 0, returned: 0, revenue: 0, cogs: 0 };
      r.qty -= a.cancelledUnits;
      r.returned += a.returnedUnits;
      r.revenue -= a.cancelledRevenue + a.returnedRevenue;
      r.cogs -= a.cancelledCogs + a.returnedCostCredited;
      rows.set(key, r);
    }

    const names = await this.categoryNames([...rows.values()].map((r) => r.categoryId));
    return {
      windowDays: days,
      categories: [...rows.values()]
        .map((r) => ({
          categoryId: r.categoryId ? binToUuid(r.categoryId) : null,
          name: r.categoryId ? names.get(r.categoryId.toString('hex')) ?? null : 'Uncategorized',
          qtySold: r.qty,
          unitsReturned: r.returned,
          revenue: round2(r.revenue),
          cogs: round2(r.cogs),
          grossProfit: round2(r.revenue - r.cogs),
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
