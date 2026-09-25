import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { binToUuid } from '../common/utils/uuid.util';
import { ClsService } from 'nestjs-cls';
import { AppClsStore } from '../common/context/request-context';
import { dayKey } from '../common/utils/date.util';
import { periodRange, shiftDate, type DateRange, type HomePeriod } from '../common/business-day';
import { BusinessDayService, dateKey, dateValue } from '../common/business-day/business-day.service';
import { assertAssignedToBranch } from '../rbac/active-branch';
import { previousDayNeedsReview, standingOf } from '../closing/closing-lifecycle';
import { dayActivity } from '../closing/closing-report.queries';
import { PartnerRankingService } from '../consignment/partner-ranking.service';
import { AnalyticsService } from './analytics.service';
import { barsSumTo, dailyBars, groupedBars, hourlyBars, type Bar } from './home-series';
import { periodFigures, sellerFigures } from './period-figures';

const num = (d: Prisma.Decimal | number | bigint | null): number => (d == null ? 0 : Number(d));
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** The rollup columns a net figure needs: the sale day's facts and the adjustments approved on the day. */
const NET_SUM = {
  revenue: true,
  cogs: true,
  grossProfit: true,
  netProfit: true,
  salesCount: true,
  qtySold: true,
  cancelledRevenue: true,
  cancelledCogs: true,
  cancelledCount: true,
  cancelledQty: true,
  returnsRevenue: true,
  returnsAdjustments: true,
  returnsGrossProfit: true,
} as const;

type NetSum = { [K in keyof typeof NET_SUM]?: Prisma.Decimal | number | null };

/**
 * A rollup sum, net (docs/53): revenue less cancellations and returns' net refund due, gross
 * profit less both profit effects, count and units less cancellations (a return is its own
 * event). `netProfit` is the rollup's own, already net.
 */
function netOf(s: NetSum) {
  const revenue = num(s.revenue ?? null) - num(s.cancelledRevenue ?? null) - (num(s.returnsRevenue ?? null) - num(s.returnsAdjustments ?? null));
  const grossProfit =
    num(s.grossProfit ?? null) - (num(s.cancelledRevenue ?? null) - num(s.cancelledCogs ?? null)) - num(s.returnsGrossProfit ?? null);
  return {
    revenue: round2(revenue),
    grossProfit: round2(grossProfit),
    netProfit: round2(num(s.netProfit ?? null)),
    salesCount: num(s.salesCount ?? null) - num(s.cancelledCount ?? null),
    qtySold: num(s.qtySold ?? null) - num(s.cancelledQty ?? null),
  };
}

/**
 * Owner-dashboard aggregates. Reads the rollups built in 2D.1–2D.2 (plus a
 * live read for employee performance). Every figure is
 * tracking-type independent. Branch-scoped when X-Branch-Id is set, else
 * company-wide; branch comparison is always company-wide.
 */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly analytics: AnalyticsService,
    private readonly cls: ClsService<AppClsStore>,
    private readonly businessDay: BusinessDayService,
    private readonly ranking: PartnerRankingService,
  ) {}

  /**
   * Home (docs/50 §3.5): one read for the whole screen.
   *
   * No route-level permission — Home is for everyone — so each section is
   * gated here by what the caller may see: money needs `report.view`, the top
   * partner `consignment.view`, the closing card `closing.count`; the
   * arrivals need only membership of the branch, which is asserted because
   * a route without a permission skips the guard's branch check.
   *
   * Every figure keys on STORED business dates (0076), the ranges are the
   * server's, and the bars are the sales value cut up — never a second query
   * — so what is plotted adds up to what is stated.
   *
   * A cancelled sale (0079) stays in the sales value of the day it was sold and
   * appears again, as a cancellation, on the day the cancellation was approved; a
   * return comes off on its approval day, by its net refund due; an expense
   * reversal on its correction day (docs/53). The figures come from the one dated
   * definition the Money screen and the reports read (`period-figures.ts`).
   */
  async home(period: HomePeriod = 'week') {
    const branchId = this.tenant.requireBranchId();
    await assertAssignedToBranch(this.db, this.tenant.requireUserId(), branchId);
    const perms = this.cls.get('permissions') ?? new Set<string>();
    const described = await this.businessDay.describe(branchId);
    const range = periodRange(period, described.businessDate);
    const dateRange = { gte: dateValue(range.from), lte: dateValue(range.to) };

    const [figures, partner, arrivals, closing] = await Promise.all([
      perms.has('report.view') ? this.homeFigures(branchId, period, range, dateRange, described.timezone, described.businessDate) : Promise.resolve(null),
      perms.has('consignment.view') ? this.ranking.top() : Promise.resolve(null),
      this.arrivals(branchId),
      perms.has('closing.count') ? this.closingCard(branchId, described.businessDate) : Promise.resolve(null),
    ]);

    return {
      period,
      range,
      businessDay: {
        businessDate: described.businessDate,
        timezone: described.timezone,
        startsAt: described.startsAt,
        endsAt: described.endsAt,
        startedEarly: described.startedEarly,
      },
      figures: figures?.figures ?? null,
      series: figures?.series ?? null,
      topPartner: partner ? partner.top : null,
      partners: partner ? { available: true, partnersExist: partner.partnersExist, ranked: partner.rankedPartners } : { available: false, partnersExist: false, ranked: 0 },
      arrivals,
      closing,
      generatedAt: new Date().toISOString(),
    };
  }

  private async homeFigures(
    branchId: Buffer,
    period: HomePeriod,
    range: DateRange,
    dateRange: { gte: Date; lte: Date },
    timezone: string,
    businessDate: string,
  ) {
    const companyId = this.tenant.companyId();
    const saleWhere = { branchId, isReversed: false, businessDate: dateRange };

    const [sales, collected, dated] = await Promise.all([
      /**
       * The sales themselves — the series is cut from these rows, so the bars
       * and the sales value are one number.
       */
      period === 'today'
        ? this.db.sale.findMany({ where: saleWhere, select: { soldAt: true, total: true, balanceDue: true } })
        : this.db.sale.groupBy({ by: ['businessDate'], where: saleWhere, _sum: { total: true, balanceDue: true }, _count: true }),
      // Money actually received on these business dates — including a balance
      // collected today on an older sale.
      this.db.payment.aggregate({ where: { businessDate: dateRange, sale: { branchId } }, _sum: { amount: true } }),
      // Invoices, cancellations, returns and expenses, each on the date that carries it — as the Daily closing counts them.
      periodFigures(this.db, companyId, branchId, range.from, range.to),
    ]);

    let salesValue = 0;
    let stillOwed = 0;
    let bars: Bar[];
    if (period === 'today') {
      const rows = sales as { soldAt: Date; total: Prisma.Decimal; balanceDue: Prisma.Decimal }[];
      salesValue = round2(rows.reduce((n, r) => n + num(r.total), 0));
      stillOwed = round2(rows.reduce((n, r) => n + num(r.balanceDue), 0));
      bars = hourlyBars(rows.map((r) => ({ soldAt: r.soldAt, total: num(r.total) })), timezone, businessDate);
    } else {
      const groups = sales as { businessDate: Date; _sum: { total: Prisma.Decimal | null; balanceDue: Prisma.Decimal | null }; _count: number }[];
      const days = groups.map((g) => ({ date: dateKey(g.businessDate), value: round2(num(g._sum.total)) }));
      salesValue = round2(days.reduce((n, d) => n + d.value, 0));
      stillOwed = round2(groups.reduce((n, g) => n + num(g._sum.balanceDue), 0));
      bars = period === 'week' ? dailyBars(days, range) : groupedBars(days, range);
    }
    if (!barsSumTo(bars, salesValue)) {
      // Cannot happen by construction; if it ever does, say so rather than plot a lie.
      throw new Error('Home series does not add up to the sales value');
    }

    return {
      figures: {
        /** The invoices of the range, on their sale dates — what the bars cut up. */
        salesValue,
        /** Invoices less whole-sale cancellations (docs/53 R5); returns are counted apart. */
        salesCount: dated.net.salesCount,
        /** Phones on the invoices less phones on cancelled invoices (R6); returned phones are `returns.phones`. */
        phonesSold: dated.net.phones,
        /** Sales cancelled in the range, on the day each cancellation was approved; the sales value above keeps them on their own day. */
        cancellations: { count: dated.cancellations.count, value: dated.cancellations.value, phones: dated.cancellations.phones },
        /** Returns approved in the range, on their approval day, by their net refund due. */
        returns: { count: dated.returns.count, value: dated.returns.value, phones: dated.returns.phones },
        /** salesValue − returns − cancellations: the Daily closing's net sales over the range. */
        netSalesValue: dated.net.salesValue,
        collected: round2(num(collected._sum.amount)),
        /** Confirmed expenses on their own dates, less reversals approved in the range — negative when only a reversal fell here. */
        expenses: dated.expenses.net,
        expensesRecorded: dated.expenses.recorded,
        expensesReversed: dated.expenses.reversed,
        expensesCount: dated.expenses.recordedCount,
        /** Outstanding today on the sales made in these business dates. */
        stillOwed,
        stillOwedScope: 'these_sales' as const,
      },
      series: {
        unit: period === 'today' ? ('hour' as const) : period === 'week' ? ('day' as const) : ('week' as const),
        total: salesValue,
        bars,
      },
    };
  }

  /**
   * The three most recently received phones at this branch, whatever their
   * status now — the same three the Stock screen shows first with Phones and
   * All statuses, because both order by `id` (UUIDv7, i.e. intake order).
   * Units exist only once an intake is confirmed: a draft import commits none.
   * The identifier is masked to its last four digits; the full IMEI never
   * travels in this payload.
   */
  private async arrivals(branchId: Buffer) {
    const units = await this.db.unit.findMany({
      // A phone whose purchase was cancelled never arrived (0079).
      where: { branchId, product: { trackingType: 'imei' }, status: { not: 'voided' } },
      orderBy: { id: 'desc' },
      take: 3,
      select: {
        id: true,
        dateIn: true,
        status: true,
        imeiPrimary: true,
        serialNo: true,
        product: { select: { brand: true, model: true, variant: true } },
      },
    });
    return units.map((u) => {
      const identifier = u.imeiPrimary ?? u.serialNo ?? '';
      return {
        unitId: binToUuid(u.id),
        label: `${u.product.brand} ${u.product.model}`.trim(),
        variant: u.product.variant,
        receivedAt: u.dateIn,
        status: u.status,
        identifierKind: u.imeiPrimary ? ('imei' as const) : ('serial' as const),
        identifierLast4: identifier.slice(-4),
      };
    });
  }

  /** The closing card: where today stands, and whether yesterday still needs a look. */
  private async closingCard(branchId: Buffer, businessDate: string) {
    const previousDate = shiftDate(businessDate, -1);
    const [today, previous] = await Promise.all([
      this.db.dailyClosing.findUnique({
        where: { branchId_closingDate: { branchId, closingDate: dateValue(businessDate) } },
        select: { status: true, countedAt: true, firstClosedAt: true, closedAt: true, reopenedAt: true, reopenCount: true },
      }),
      this.db.dailyClosing.findUnique({
        where: { branchId_closingDate: { branchId, closingDate: dateValue(previousDate) } },
        select: { status: true },
      }),
    ]);
    const prevRow = previous ? { status: previous.status, businessDate: previousDate } : null;
    // Nothing recorded yesterday is not an overdue closing (docs/51 D8): the same test Closing & history uses.
    const prevActive = previous ? true : await dayActivity(this.db, this.tenant.companyId(), branchId, previousDate);
    return {
      businessDate,
      standing: standingOf(today ? { status: today.status, businessDate } : null, businessDate),
      lastCountedAt: today?.countedAt ?? null,
      firstClosedAt: today?.firstClosedAt ?? null,
      closedAt: today?.status === 'locked' ? today.closedAt : null,
      reopenedAt: today?.status === 'reopened' ? today.reopenedAt : null,
      reopenCount: today?.reopenCount ?? 0,
      previousDay: {
        businessDate: previousDate,
        standing: standingOf(prevRow, businessDate, prevActive, previousDate),
        needsReview: previousDayNeedsReview(prevRow, prevActive),
      },
    };
  }

  /** Compact "how is my store doing right now?" snapshot. */
  async snapshot() {
    const branchId = this.tenant.branchId();
    const now = new Date();
    const todayDate = new Date(`${dayKey(now)}T00:00:00.000Z`);
    const monthStart = new Date(`${dayKey(now).slice(0, 8)}01T00:00:00.000Z`);

    const [today, month, inventory] = await Promise.all([
      this.db.dailyRollup.aggregate({ where: { day: todayDate, ...(branchId ? { branchId } : {}) }, _sum: NET_SUM }),
      this.db.dailyRollup.aggregate({ where: { day: { gte: monthStart, lte: todayDate }, ...(branchId ? { branchId } : {}) }, _sum: NET_SUM }),
      this.analytics.inventoryValue(),
    ]);
    const t = netOf(today._sum);
    const m = netOf(month._sum);

    // Net of returns and cancellations on their approval days (docs/53), as Results reads the same rollup.
    return {
      today: { revenue: t.revenue, grossProfit: t.grossProfit, netProfit: t.netProfit, salesCount: t.salesCount, qtySold: t.qtySold },
      month: { revenue: m.revenue, grossProfit: m.grossProfit, netProfit: m.netProfit },
      inventory: {
        inventoryValue: inventory.totals.inventoryValue,
        expectedProfit: inventory.totals.expectedProfit,
        productCount: inventory.totals.productCount,
      },
    };
  }

  /** Full dashboard: snapshot + rankings + dead stock + comparisons. */
  async dashboard() {
    const [home, performance, deadStock, branchComparison, employeePerformance] = await Promise.all([
      this.snapshot(),
      this.analytics.productPerformance(30),
      this.deadStock(10),
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

  /** Revenue/profit per branch over a window (always company-wide). */
  async branchComparison(days: number) {
    const from = this.windowStart(days);
    const grouped = await this.db.dailyRollup.groupBy({
      by: ['branchId'],
      where: { day: { gte: from } },
      _sum: NET_SUM,
    });
    const branches = grouped.length
      ? await this.db.branch.findMany({ where: { id: { in: grouped.map((g) => g.branchId) } }, select: { id: true, name: true } })
      : [];
    const nameByHex = new Map(branches.map((b) => [b.id.toString('hex'), b.name]));
    return grouped
      .map((g) => {
        // Net of returns and cancellations on their approval days (docs/53), as Results reads the same rollup.
        const n = netOf(g._sum);
        return {
          branchId: binToUuid(g.branchId),
          name: nameByHex.get(g.branchId.toString('hex')) ?? null,
          revenue: n.revenue,
          grossProfit: n.grossProfit,
          netProfit: n.netProfit,
        };
      })
      .sort((a, b) => b.revenue - a.revenue);
  }

  /**
   * Revenue and margin per seller over a window of business dates (docs/53 D34): the seller's
   * invoices on their sale dates, less their own sales' cancellations and returns on the dates
   * those were approved. `salesCount` = invoices − whole-sale cancellations (R5); `returnsCount`
   * is its own count.
   *
   * `endingDaysAgo` shifts the window back without changing anything else, so
   * "the last thirty days" and "the thirty before that" come from ONE
   * definition of a seller's margin. Computing the earlier window separately is
   * exactly how two figures that must be comparable stop being comparable.
   */
  async employeePerformance(days: number, endingDaysAgo = 0) {
    const branchId = this.tenant.branchId() ?? null;
    const from = dayKey(this.windowStart(days + endingDaysAgo));
    const until = endingDaysAgo > 0 ? dayKey(this.windowStart(endingDaysAgo)) : null;
    const sellers = await sellerFigures(this.db, this.tenant.companyId(), branchId, from, until);
    const users = sellers.length
      ? await this.db.user.findMany({ where: { id: { in: sellers.map((s) => s.userId) } }, select: { id: true, name: true } })
      : [];
    const nameByHex = new Map(users.map((u) => [u.id.toString('hex'), u.name]));
    return sellers
      .map((s) => ({
        userId: binToUuid(s.userId),
        name: nameByHex.get(s.userId.toString('hex')) ?? null,
        salesCount: s.salesCount,
        returnsCount: s.returns,
        revenue: s.revenue,
        margin: s.margin,
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
