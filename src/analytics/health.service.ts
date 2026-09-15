import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { dayKey } from '../common/utils/date.util';
import { combineHealth, ComponentScore, HealthResult } from './health-score.util';

const num = (d: Prisma.Decimal | number | bigint | null): number => (d == null ? 0 : Number(d));
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const NEUTRAL = 0.5;

const DEFAULT_WEIGHTS: Record<string, number> = {
  profit_trend: 0.25,
  cash_flow: 0.15,
  overdue_debts: 0.15,
  dead_stock: 0.1,
  velocity: 0.15,
};

/**
 * Store health score — six components, each normalized to 0..1 and combined
 * with the company-configurable `health_score_weights`. New/low-history stores
 * get NEUTRAL (0.5) per component rather than being penalized. Completely
 * tracking-type independent: every input comes from the shared financial /
 * inventory data (rollups, sales, inventory_valuation, product_velocity).
 */
@Injectable()
export class HealthService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
  ) {}

  async score(): Promise<HealthResult> {
    const branchId = this.tenant.branchId();
    const branchWhere = branchId ? { branchId } : {};
    const now = new Date();
    const todayDate = new Date(`${dayKey(now)}T00:00:00.000Z`);
    const deadDays = await this.numberSetting('dead_stock_days', 60);

    // Shared inventory snapshots — fetched once, feed three components.
    const [valuations, velocity, activeProducts] = await Promise.all([
      this.db.inventoryValuation.findMany({ where: branchWhere }),
      this.db.productVelocity.findMany({ where: branchWhere }),
      this.db.product.count({ where: { deletedAt: null } }),
    ]);
    const lastSoldByHex = new Map(velocity.map((v) => [v.productId.toString('hex'), v.lastSoldAt]));

    const components: ComponentScore[] = [
      await this.profitTrend(branchWhere, todayDate),
      await this.cashFlow(branchWhere, todayDate),
      await this.overdueDebts(branchWhere, todayDate),
      this.deadStock(valuations, lastSoldByHex, deadDays, now),
      this.velocityScore(valuations, velocity),
    ];

    const weights = await this.weights();
    return combineHealth(components, weights);
  }

  // --- components (each 0..1, neutral on insufficient data) -----------------

  /** Gross profit last 7d vs previous 7d. */
  private async profitTrend(branchWhere: object, today: Date): Promise<ComponentScore> {
    const d = (n: number) => new Date(today.getTime() - n * 86_400_000);
    const [last7, prev7] = await Promise.all([
      this.db.dailyRollup.aggregate({ _sum: { grossProfit: true }, _count: true, where: { ...branchWhere, day: { gte: d(6), lte: today } } }),
      this.db.dailyRollup.aggregate({ _sum: { grossProfit: true }, _count: true, where: { ...branchWhere, day: { gte: d(13), lte: d(7) } } }),
    ]);
    if (last7._count + prev7._count === 0) return { key: 'profit_trend', score: NEUTRAL, insufficientData: true };
    const a = num(last7._sum.grossProfit);
    const b = num(prev7._sum.grossProfit);
    if (a + b <= 0) return { key: 'profit_trend', score: a >= b ? NEUTRAL : 0.25 };
    return { key: 'profit_trend', score: clamp01(a / (a + b)) };
  }

  /** Collected cash vs billed over the last 30 days. */
  private async cashFlow(branchWhere: object, today: Date): Promise<ComponentScore> {
    const from = new Date(today.getTime() - 29 * 86_400_000);
    const agg = await this.db.sale.aggregate({ _sum: { amountPaid: true, total: true }, where: { ...branchWhere, soldAt: { gte: from } } });
    const total = num(agg._sum.total);
    if (total <= 0) return { key: 'cash_flow', score: NEUTRAL, insufficientData: true };
    return { key: 'cash_flow', score: clamp01(num(agg._sum.amountPaid) / total) };
  }

  /** 1 − overdue receivables / total receivables (no debt = healthy). */
  private async overdueDebts(branchWhere: object, today: Date): Promise<ComponentScore> {
    const [totalAgg, overdueAgg] = await Promise.all([
      this.db.sale.aggregate({ _sum: { balanceDue: true }, where: { ...branchWhere, balanceDue: { gt: 0 } } }),
      this.db.sale.aggregate({ _sum: { balanceDue: true }, where: { ...branchWhere, balanceDue: { gt: 0 }, dueDate: { lt: today } } }),
    ]);
    const total = num(totalAgg._sum.balanceDue);
    if (total <= 0) return { key: 'overdue_debts', score: 1 }; // no receivables → healthy
    return { key: 'overdue_debts', score: clamp01(1 - num(overdueAgg._sum.balanceDue) / total) };
  }

  /** 1 − dead-stock value / total inventory value. */
  private deadStock(
    valuations: { productId: Buffer; inventoryValue: Prisma.Decimal }[],
    lastSoldByHex: Map<string, Date | null>,
    deadDays: number,
    now: Date,
  ): ComponentScore {
    const cutoff = new Date(now.getTime() - deadDays * 86_400_000);
    let total = 0;
    let dead = 0;
    for (const v of valuations) {
      const value = num(v.inventoryValue);
      total += value;
      const last = lastSoldByHex.get(v.productId.toString('hex'));
      if (!last || last < cutoff) dead += value;
    }
    if (total <= 0) return { key: 'dead_stock', score: NEUTRAL, insufficientData: true };
    return { key: 'dead_stock', score: clamp01(1 - dead / total) };
  }

  /** Sell-through = sold_30d / (sold_30d + in-stock). */
  private velocityScore(
    valuations: { unitsCount: number; quantity: number }[],
    velocity: { sold30d: number }[],
  ): ComponentScore {
    const inStock = valuations.reduce((s, v) => s + v.unitsCount + v.quantity, 0);
    const sold30 = velocity.reduce((s, v) => s + v.sold30d, 0);
    if (sold30 + inStock === 0) return { key: 'velocity', score: NEUTRAL, insufficientData: true };
    return { key: 'velocity', score: clamp01(sold30 / (sold30 + inStock)) };
  }

  // --- helpers --------------------------------------------------------------

  private async weights(): Promise<Record<string, number>> {
    const s = await this.db.setting.findFirst({ where: { key: 'health_score_weights', branchId: null } });
    const v = s?.value;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const merged: Record<string, number> = { ...DEFAULT_WEIGHTS };
      for (const key of Object.keys(DEFAULT_WEIGHTS)) {
        const w = (v as Record<string, unknown>)[key];
        if (typeof w === 'number') merged[key] = w;
      }
      return merged;
    }
    return DEFAULT_WEIGHTS;
  }

  private async numberSetting(key: string, def: number): Promise<number> {
    const s = await this.db.setting.findFirst({ where: { key, branchId: null } });
    return typeof s?.value === 'number' ? s.value : def;
  }
}
