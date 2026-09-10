import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { binToUuid } from '../common/utils/uuid.util';
import { dayKey } from '../common/utils/date.util';
import { AnalyticsService } from './analytics.service';

const num = (d: Prisma.Decimal | number | bigint | null): number => (d == null ? 0 : Number(d));
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Owner-dashboard aggregates. Reads the rollups built in 2D.1–2D.2 (plus a
 * couple of live reads for low-stock and employee performance). Every figure is
 * tracking-type independent. Branch-scoped when X-Branch-Id is set, else
 * company-wide; branch comparison is always company-wide.
 */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly analytics: AnalyticsService,
  ) {}

  /** Compact "how is my store doing right now?" snapshot. */
  async home() {
    const branchId = this.tenant.branchId();
    const now = new Date();
    const todayDate = new Date(`${dayKey(now)}T00:00:00.000Z`);
    const monthStart = new Date(`${dayKey(now).slice(0, 8)}01T00:00:00.000Z`);

    const [today, month, inventory, lowStockCount] = await Promise.all([
      this.db.dailyRollup.aggregate({
        where: { day: todayDate, ...(branchId ? { branchId } : {}) },
        _sum: { revenue: true, grossProfit: true, netProfit: true, salesCount: true, qtySold: true },
      }),
      this.db.dailyRollup.aggregate({
        where: { day: { gte: monthStart, lte: todayDate }, ...(branchId ? { branchId } : {}) },
        _sum: { revenue: true, grossProfit: true, netProfit: true },
      }),
      this.analytics.inventoryValue(),
      this.lowStock().then((l) => l.length),
    ]);

    return {
      today: {
        revenue: round2(num(today._sum.revenue)),
        grossProfit: round2(num(today._sum.grossProfit)),
        netProfit: round2(num(today._sum.netProfit)),
        salesCount: num(today._sum.salesCount),
        qtySold: num(today._sum.qtySold),
      },
      month: {
        revenue: round2(num(month._sum.revenue)),
        grossProfit: round2(num(month._sum.grossProfit)),
        netProfit: round2(num(month._sum.netProfit)),
      },
      inventory: {
        inventoryValue: inventory.totals.inventoryValue,
        expectedProfit: inventory.totals.expectedProfit,
        productCount: inventory.totals.productCount,
      },
      lowStockCount,
    };
  }

  /** Full dashboard: snapshot + rankings + dead stock + comparisons. */
  async dashboard() {
    const [home, performance, deadStock, lowStock, branchComparison, employeePerformance] = await Promise.all([
      this.home(),
      this.analytics.productPerformance(30),
      this.deadStock(10),
      this.lowStock(),
      this.branchComparison(30),
      this.employeePerformance(30),
    ]);

    const products = performance.products;
    return {
      ...home,
      bestSelling: [...products].sort((a, b) => b.qtySold - a.qtySold).slice(0, 5),
      mostProfitable: products.slice(0, 5), // productPerformance is profit-desc
      worstPerforming: [...products].sort((a, b) => a.grossProfit - b.grossProfit).slice(0, 5),
      deadStock,
      lowStock,
      branchComparison,
      employeePerformance,
    };
  }

  // --- components -----------------------------------------------------------

  /**
   * Products with stock but no recent sale (older than `dead_stock_days`).
   *
   * `limit` is the DASHBOARD's limit, not the report's. Ten is what fits on a
   * card; an export of the ten worst is not a dead-stock report, it is the
   * dashboard saved to a file. The export passes no limit and gets all of them.
   */
  async deadStock(limit?: number) {
    const branchId = this.tenant.branchId();
    const days = await this.numberSetting('dead_stock_days', 60);
    const cutoff = new Date(Date.now() - days * 86_400_000);

    const [valuations, velocity] = await Promise.all([
      this.db.inventoryValuation.findMany({ where: branchId ? { branchId } : {} }),
      this.db.productVelocity.findMany({ where: branchId ? { branchId } : {} }),
    ]);
    const lastSoldByHex = new Map(velocity.map((v) => [v.productId.toString('hex'), v.lastSoldAt]));

    const dead = valuations.filter((r) => {
      const last = lastSoldByHex.get(r.productId.toString('hex'));
      return !last || last < cutoff;
    });
    const labels = await this.productLabels(dead.map((d) => d.productId));

    return dead
      .map((r) => ({
        productId: binToUuid(r.productId),
        label: labels.get(r.productId.toString('hex')) ?? null,
        trackingType: r.trackingType,
        inStock: r.unitsCount + r.quantity,
        inventoryValue: num(r.inventoryValue),
        lastSoldAt: lastSoldByHex.get(r.productId.toString('hex')) ?? null,
      }))
      .sort((a, b) => b.inventoryValue - a.inventoryValue)
      .slice(0, limit ?? Number.MAX_SAFE_INTEGER);
  }

  /**
   * Products at/below the low-stock threshold (units + quantity stock).
   *
   * Public since A3: the anomaly rules need the shop's own threshold, and a
   * second list built from a second threshold is two answers to "what counts
   * as low?".
   */
  async lowStock() {
    const branchId = this.tenant.branchId();
    const threshold = await this.numberSetting('low_stock_threshold', 3);

    const [unitGroups, stocks] = await Promise.all([
      this.db.unit.groupBy({
        by: ['productId'],
        where: { status: 'in_stock', ...(branchId ? { branchId } : {}) },
        _count: true,
      }),
      this.db.stockItem.findMany({
        where: { quantity: { lte: threshold }, ...(branchId ? { branchId } : {}) },
        select: { productId: true, quantity: true },
      }),
    ]);

    const low: { productId: Buffer; inStock: number }[] = [
      ...unitGroups.filter((g) => g._count <= threshold).map((g) => ({ productId: g.productId, inStock: g._count })),
      ...stocks.map((s) => ({ productId: s.productId, inStock: s.quantity })),
    ];
    const labels = await this.productLabels(low.map((l) => l.productId));
    return low.map((l) => ({
      productId: binToUuid(l.productId),
      label: labels.get(l.productId.toString('hex')) ?? null,
      inStock: l.inStock,
      threshold,
    }));
  }

  /** Revenue/profit per branch over a window (always company-wide). */
  async branchComparison(days: number) {
    const from = this.windowStart(days);
    const grouped = await this.db.dailyRollup.groupBy({
      by: ['branchId'],
      where: { day: { gte: from } },
      _sum: { revenue: true, grossProfit: true, netProfit: true },
    });
    const branches = grouped.length
      ? await this.db.branch.findMany({ where: { id: { in: grouped.map((g) => g.branchId) } }, select: { id: true, name: true } })
      : [];
    const nameByHex = new Map(branches.map((b) => [b.id.toString('hex'), b.name]));
    return grouped
      .map((g) => ({
        branchId: binToUuid(g.branchId),
        name: nameByHex.get(g.branchId.toString('hex')) ?? null,
        revenue: round2(num(g._sum.revenue)),
        grossProfit: round2(num(g._sum.grossProfit)),
        netProfit: round2(num(g._sum.netProfit)),
      }))
      .sort((a, b) => b.revenue - a.revenue);
  }

  /** Sales/revenue/margin per employee over a window (live over sales). */
  /**
   * Revenue and margin per seller over a window.
   *
   * `endingDaysAgo` shifts the window back without changing anything else, so
   * "the last thirty days" and "the thirty before that" come from ONE
   * definition of a seller's margin. Computing the earlier window separately is
   * exactly how two figures that must be comparable stop being comparable.
   */
  async employeePerformance(days: number, endingDaysAgo = 0) {
    const branchId = this.tenant.branchId();
    const from = this.windowStart(days + endingDaysAgo);
    const until = endingDaysAgo > 0 ? this.windowStart(endingDaysAgo) : null;
    const grouped = await this.db.sale.groupBy({
      by: ['userId'],
      where: {
        soldAt: until ? { gte: from, lt: until } : { gte: from },
        ...(branchId ? { branchId } : {}),
      },
      _sum: { total: true, margin: true },
      _count: true,
    });
    const users = grouped.length
      ? await this.db.user.findMany({ where: { id: { in: grouped.map((g) => g.userId) } }, select: { id: true, name: true } })
      : [];
    const nameByHex = new Map(users.map((u) => [u.id.toString('hex'), u.name]));
    return grouped
      .map((g) => ({
        userId: binToUuid(g.userId),
        name: nameByHex.get(g.userId.toString('hex')) ?? null,
        salesCount: g._count,
        revenue: round2(num(g._sum.total)),
        margin: round2(num(g._sum.margin)),
      }))
      .sort((a, b) => b.revenue - a.revenue);
  }

  // --- helpers --------------------------------------------------------------

  /** The shop's own `dead_stock_days`. Exposed so an anomaly can say how long. */
  async deadStockDays(): Promise<number> {
    return this.numberSetting('dead_stock_days', 60);
  }

  private windowStart(days: number): Date {
    const start = new Date(Date.now() - (days - 1) * 86_400_000);
    return new Date(`${dayKey(start)}T00:00:00.000Z`);
  }

  private async numberSetting(key: string, def: number): Promise<number> {
    const s = await this.db.setting.findFirst({ where: { key, branchId: null } });
    return typeof s?.value === 'number' ? s.value : def;
  }

  private async productLabels(ids: Buffer[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const products = await this.db.product.findMany({
      where: { id: { in: ids } },
      select: { id: true, brand: true, model: true, variant: true },
    });
    return new Map(products.map((p) => [p.id.toString('hex'), `${p.brand} ${p.model}${p.variant ? ` ${p.variant}` : ''}`]));
  }
}
