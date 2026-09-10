import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { AppClsStore } from '../common/context/request-context';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { dayKey } from '../common/utils/date.util';
import { DashboardService } from '../analytics/dashboard.service';
import {
  Anomaly,
  ANOMALY_WINDOW_DAYS,
  belowCostAnomalies,
  cashShortfallAnomalies,
  deadStockAnomalies,
  lowStockAnomalies,
  NOTIFYING_CODES,
  orderAnomalies,
  overdueDebtAnomalies,
  sellerMarginAnomalies,
  withoutDismissed,
} from './anomaly-rules';

/**
 * The six anomaly rules, read from what the shop already has (A3).
 *
 * ## Where every number comes from
 *
 * | Rule | Source |
 * |---|---|
 * | low stock | `ProductVelocity` + the same stock counts the dashboard uses |
 * | dead stock | `DashboardService.deadStock` — the existing list, unchanged |
 * | overdue debt | sale receivables past due, the health score's own definition |
 * | seller margin | `DashboardService.employeePerformance`, two windows |
 * | cash shortfall | `ClosingDiscrepancy` — the closing decided what "short" is |
 * | below cost | `DiscountApproval` rows actually **consumed** by a sale |
 *
 * Nothing here computes revenue, profit, cost, expected cash or stock value in
 * a new way. Where a figure was already being produced by a service, this asks
 * that service — a second definition of profit is the failure mode, and a
 * "needs your attention" panel is a spectacularly bad place to introduce one.
 *
 * ## Who sees what
 *
 * The endpoint needs `report.view`. On top of that: overdue debt needs
 * `loan.view`; the shortfall rule needs `closing.perform` or the Owner; and the
 * two rules that involve margin and cost are **Owner-only and gated on
 * `cost.view`** — an employee must never read a colleague's margin.
 *
 * A rule the caller may not see is **never computed**, not computed and
 * filtered. A figure that is never fetched cannot leak through a log, an error
 * message or a future refactor that forgets which list was the safe one.
 */

/** Seven days, as approved. Dismissing is a snooze, not a delete. */
export const DISMISSAL_DAYS = 7;
/** Ninety days, then the dismissal record is dropped. A prompt, not a record. */
export const DISMISSAL_RETENTION_DAYS = 90;

@Injectable()
export class AnomaliesService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly dashboard: DashboardService,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  private may(permission: string): boolean {
    return this.cls.get('permissions')?.has(permission) ?? false;
  }

  /** The Owner, for the two rules that carry margin and cost. */
  private isOwner(): boolean {
    return this.may('discount.override') && this.may('cost.view');
  }

  /**
   * Everything worth this person's attention, right now.
   *
   * Computed on read. Nothing is stored, because a stored anomaly is a second
   * copy of a figure that is already stale by the time anybody reads it.
   */
  async list() {
    const now = new Date();
    const suppressed = await this.suppressedKeys(now);

    const groups = await Promise.all([
      this.lowStock(),
      this.deadStock(),
      this.may('loan.view') ? this.overdueDebt(now) : Promise.resolve([]),
      this.isOwner() ? this.sellerMargin() : Promise.resolve([]),
      this.may('closing.perform') || this.isOwner() ? this.cashShortfall(now) : Promise.resolve([]),
      this.isOwner() ? this.belowCostCluster(now) : Promise.resolve([]),
    ]);

    const found = orderAnomalies(withoutDismissed(groups.flat(), suppressed));
    await this.notify(found, now);

    return {
      rows: found,
      /*
       * When this was worked out. An anomaly panel with no timestamp invites
       * somebody to act at four o'clock on a figure from the morning.
       */
      generatedAt: now.toISOString(),
      windowDays: ANOMALY_WINDOW_DAYS,
    };
  }

  /**
   * "I know about this one."
   *
   * Suppresses that key for the whole company for seven days, and records who
   * said so. Company-wide because an anomaly is about the business — making
   * every person dismiss the same shortfall separately turns a prompt into
   * paperwork.
   */
  async dismiss(key: string) {
    if (!this.may('report.view')) throw new ForbiddenException('Not allowed to dismiss anomalies');
    const userId = this.tenant.userId();
    if (!userId) throw new ForbiddenException('Not signed in');

    const now = new Date();
    const suppressedUntil = new Date(now.getTime() + DISMISSAL_DAYS * 86_400_000);
    const row = await this.db.anomalyDismissal.create({
      data: {
        id: newUuidV7Bin(),
        companyId: this.tenant.companyId(),
        anomalyKey: key,
        dismissedById: userId,
        dismissedAt: now,
        suppressedUntil,
      },
    });

    /*
     * Audited, because "why did nobody see the shortfall?" has to have an
     * answer. Dismissing is a decision, even though it changes no money.
     */
    await this.audit.record({
      entityType: 'anomaly_dismissal',
      entityId: row.id,
      action: 'create',
      after: { event: 'anomaly_dismissed', anomalyKey: key, suppressedUntil: suppressedUntil.toISOString() },
    });

    return { key, suppressedUntil: suppressedUntil.toISOString() };
  }

  /**
   * Which keys are silenced right now — and a retention sweep on the way past.
   *
   * No scheduler. Ninety-day-old dismissals are dropped by whoever reads next,
   * the same lazy pattern the approvals use to expire: a row nobody is looking
   * at is doing no harm, and a background job to tidy something unobserved is
   * infrastructure for its own sake.
   */
  private async suppressedKeys(now: Date): Promise<ReadonlySet<string>> {
    const cutoff = new Date(now.getTime() - DISMISSAL_RETENTION_DAYS * 86_400_000);
    await this.db.anomalyDismissal.deleteMany({ where: { dismissedAt: { lt: cutoff } } });

    const rows = await this.db.anomalyDismissal.findMany({
      where: { suppressedUntil: { gt: now } },
      select: { anomalyKey: true },
    });
    return new Set(rows.map((r) => r.anomalyKey));
  }

  // ── The six ──────────────────────────────────────────────────────────────

  private async lowStock(): Promise<Anomaly[]> {
    const branchId = this.tenant.branchId();
    // The dashboard's own low-stock list, so the threshold is the shop's and
    // there is only one answer to "what counts as low?".
    const low = await this.dashboard.lowStock();
    if (low.length === 0) return [];

    const velocity = await this.db.productVelocity.findMany({
      where: branchId ? { branchId } : {},
      select: { productId: true, sold30d: true },
    });
    const soldByUuid = new Map(velocity.map((v) => [binToUuid(v.productId), v.sold30d]));

    return lowStockAnomalies(
      low.map((row) => ({
        productId: row.productId,
        label: row.label ?? row.productId,
        inStock: row.inStock,
        soldInWindow: soldByUuid.get(row.productId) ?? 0,
      })),
    );
  }

  private async deadStock(): Promise<Anomaly[]> {
    const [rows, days] = await Promise.all([
      this.dashboard.deadStock(),
      this.dashboard.deadStockDays(),
    ]);
    return deadStockAnomalies(
      rows.map((row) => ({
        productId: row.productId,
        label: row.label ?? row.productId,
        inStock: row.inStock,
        days,
      })),
    );
  }

  private async overdueDebt(now: Date): Promise<Anomaly[]> {
    const branchId = this.tenant.branchId();
    const today = new Date(`${dayKey(now)}T00:00:00.000Z`);
    /*
     * The app's existing definition of overdue, from the health score: a sale
     * with a balance still owed and a due date in the past. Writing a second
     * one here is how two screens end up disagreeing about who owes what.
     */
    const where = {
      balanceDue: { gt: new Prisma.Decimal(0) },
      dueDate: { lt: today },
      ...(branchId ? { branchId } : {}),
    };
    const [count, agg] = await Promise.all([
      this.db.sale.count({ where }),
      this.db.sale.aggregate({ where, _sum: { balanceDue: true } }),
    ]);
    return overdueDebtAnomalies({ count, amount: Number(agg._sum.balanceDue ?? 0) });
  }

  private async sellerMargin(): Promise<Anomaly[]> {
    // Two windows from ONE definition of a seller's margin — the dashboard's.
    const [current, previous] = await Promise.all([
      this.dashboard.employeePerformance(ANOMALY_WINDOW_DAYS),
      this.dashboard.employeePerformance(ANOMALY_WINDOW_DAYS, ANOMALY_WINDOW_DAYS),
    ]);
    const beforeByUser = new Map(previous.map((row) => [row.userId, row]));

    return sellerMarginAnomalies(
      current
        .filter((row) => beforeByUser.has(row.userId))
        .map((row) => {
          const before = beforeByUser.get(row.userId)!;
          return {
            userId: row.userId,
            name: row.name ?? row.userId,
            current: { sales: row.salesCount, revenue: row.revenue, margin: row.margin },
            previous: { sales: before.salesCount, revenue: before.revenue, margin: before.margin },
          };
        }),
    );
  }

  private async cashShortfall(now: Date): Promise<Anomaly[]> {
    const branchId = this.tenant.branchId();
    const from = new Date(now.getTime() - ANOMALY_WINDOW_DAYS * 86_400_000);
    /*
     * The closing already decided what a shortage is and raised the row. A
     * negative amount is money missing; a surplus is its own investigation and
     * is not this rule's business.
     */
    const rows = await this.db.closingDiscrepancy.findMany({
      where: {
        openedAt: { gte: from },
        amount: { lt: new Prisma.Decimal(0) },
        ...(branchId ? { branchId } : {}),
      },
      select: { amount: true },
    });
    return cashShortfallAnomalies({
      count: rows.length,
      amount: rows.reduce((sum, r) => sum + Number(r.amount), 0),
    });
  }

  private async belowCostCluster(now: Date): Promise<Anomaly[]> {
    const from = new Date(now.getTime() - ANOMALY_WINDOW_DAYS * 86_400_000);
    /*
     * Only approvals actually SPENT on a sale. Asking is not selling, and a
     * rejected request is the system working — counting either would report
     * people for using the workflow correctly.
     */
    const grouped = await this.db.discountApproval.groupBy({
      by: ['requesterId'],
      where: { status: 'consumed', belowCost: true, consumedAt: { gte: from } },
      _count: true,
    });
    if (grouped.length === 0) return [];

    const users = await this.db.user.findMany({
      where: { id: { in: grouped.map((g) => g.requesterId) } },
      select: { id: true, name: true },
    });
    const nameByHex = new Map(users.map((u) => [u.id.toString('hex'), u.name]));

    return belowCostAnomalies(
      grouped.map((g) => ({
        userId: binToUuid(g.requesterId),
        name: nameByHex.get(g.requesterId.toString('hex')) ?? binToUuid(g.requesterId),
        count: g._count,
      })),
    );
  }

  // ── Telling somebody who is not looking ──────────────────────────────────

  /**
   * Three of the six are worth interrupting for. The other three are read.
   *
   * ## Why this happens on a read
   *
   * There is no scheduler in this project, and inventing one for a prompt would
   * be infrastructure for its own sake. So the rules are evaluated when
   * somebody opens the screen — and the notification goes to **the people who
   * need to act**, not to the reader. A manager opening the panel is how the
   * Owner learns about a below-cost cluster; the Owner opening it is how the
   * branch learns the drawer keeps coming up short.
   *
   * Deduplicated per anomaly key per **day** by a key the database enforces, so
   * refreshing the screen twenty times produces one message.
   */
  private async notify(anomalies: readonly Anomaly[], now: Date): Promise<void> {
    const notifying = anomalies.filter((a) => NOTIFYING_CODES.has(a.code));
    if (notifying.length === 0) return;

    const companyId = this.tenant.companyId();
    const branchId = this.tenant.branchId() ?? null;
    const day = dayKey(now);

    for (const item of notifying) {
      const recipients = await this.recipientsFor(item.code);
      for (const userId of recipients) {
        try {
          await this.db.notification.create({
            data: {
              id: newUuidV7Bin(),
              companyId,
              branchId,
              targetUserId: userId,
              type: item.code,
              // English fallback only. The app rebuilds the sentence from
              // `payload` in the reader's own language.
              title: 'Something needs your attention',
              body: null,
              actionLink: '/analytics',
              dedupeKey: `anomaly:${item.key}:${day}`,
              payload: { event: item.code, ...item.params } as Prisma.InputJsonValue,
            },
          });
        } catch (e) {
          // Already told today. That is success, not failure.
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
          throw e;
        }
      }
    }
  }

  /**
   * Who can act on this, by permission rather than by role name.
   *
   * A below-cost cluster is the Owner's to judge; a shortfall belongs to
   * whoever closes the drawer; a debt belongs to whoever chases it.
   */
  private async recipientsFor(code: Anomaly['code']): Promise<Buffer[]> {
    const permission =
      code === 'anomaly.below_cost_cluster'
        ? 'discount.override'
        : code === 'anomaly.cash_shortfall'
          ? 'closing.perform'
          : 'loan.view';

    const assignments = await this.db.userBranch.findMany({
      where: {
        user: { isActive: true, deletedAt: null },
        role: { rolePermissions: { some: { permission: { key: permission } } } },
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    return assignments.map((a) => a.userId);
  }
}
