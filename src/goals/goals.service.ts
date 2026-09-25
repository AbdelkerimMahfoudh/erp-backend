import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { AccessService } from '../rbac/access.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { dayKey } from '../common/utils/date.util';
import { ADJUSTMENT, computeProgress, isMoneyMetric, METRIC_COLUMN, type GoalMetricKey } from './goal-progress';
import { CreateGoalDto } from './dto/create-goal.dto';
import { ArchiveGoalDto } from './dto/archive-goal.dto';

const num = (d: Prisma.Decimal | number | bigint | null): number => (d == null ? 0 : Number(d));
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * One seller's figure per metric, over their sales (`s`), on the rollup's own basis
 * (`rollup.service.ts`): revenue is the recorded invoice total — a whole-invoice
 * discount included, as the rollup now reads it (docs/54 D36) — gross profit that
 * less the cost of its lines, units their quantity, and a sale is counted once
 * however many lines it has: three phones on one receipt is one sale, which is what
 * "how many sales did you make" means to a person.
 */
const PERSONAL_VALUE: Readonly<Record<GoalMetricKey, string>> = {
  gross_profit: 'COALESCE(SUM(s.total - s.total_cost), 0)',
  revenue: 'COALESCE(SUM(s.total), 0)',
  sales_count: 'COUNT(*)',
  units_sold: 'COALESCE(SUM((SELECT COALESCE(SUM(si.quantity), 0) FROM sale_items si WHERE si.sale_id = s.id AND si.voided = 0)), 0)',
};

/**
 * What one seller's returns approved in the period take off, as the rollup takes them off the
 * branch (docs/53 R2): revenue by the net refund due, profit by gross − adjustments − cost
 * credited, and one unit each (docs/54 D37 — a return is one identified unit). A returned item
 * is not a cancelled invoice: the sales count keeps it (R5).
 */
const PERSONAL_RETURN: Readonly<Record<GoalMetricKey, string>> = {
  gross_profit: 'COALESCE(SUM(rr.gross_refund - rr.adjustment_total - rr.line_cost), 0)',
  revenue: 'COALESCE(SUM(rr.net_refund_due), 0)',
  sales_count: '0',
  units_sold: 'COUNT(*)',
};

/**
 * Goals (Milestone F).
 *
 * **Progress is derived, never stored.** Every read recomputes it from
 * `daily_rollups`, which already accounts for returns — so a goal and the day's
 * analytics can never disagree about the same period. Storing progress would
 * mean invalidating it on every sale, return, refund and correction, and a
 * stored figure that drifts from its own sales is worse than no figure.
 *
 * A person's goal is attributed through `sales.user_id`, which is immutable: a
 * sale belongs to whoever made it, permanently. That is why user-scoped
 * progress reads sales directly while branch and company scope read the rollup
 * — and `goals-reconciliation.spec.ts` pins that the two agree.
 */
@Injectable()
export class GoalsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  async create(dto: CreateGoalDto) {
    const companyId = this.tenant.companyId();
    const createdById = this.tenant.userId();
    if (!createdById) throw new BadRequestException('No authenticated user');

    if (dto.periodEnd < dto.periodStart) {
      throw new BadRequestException('A goal period runs forwards');
    }

    /**
     * The scope and its two columns have to agree, and the database enforces
     * the same rule. Checking here as well turns a 500 from a CHECK violation
     * into a sentence somebody can act on.
     */
    const branchId = dto.scope === 'company' ? null : uuidToBin(this.requireBranch(dto));
    const targetUserId = dto.scope === 'user' ? uuidToBin(this.requireUser(dto)) : null;

    if (targetUserId) {
      const person = await this.db.user.findFirst({ where: { id: targetUserId }, select: { id: true } });
      if (!person) throw new BadRequestException('That person is not part of this shop');
    }

    const id = newUuidV7Bin();
    try {
      await this.db.goal.create({
        data: {
          id,
          companyId,
          scope: dto.scope,
          branchId,
          targetUserId,
          metric: dto.metric,
          periodStart: new Date(`${dto.periodStart}T00:00:00.000Z`),
          periodEnd: new Date(`${dto.periodEnd}T00:00:00.000Z`),
          periodLabel: dto.periodLabel ?? 'custom',
          targetAmount: dto.targetAmount,
          note: dto.note ?? null,
          createdById,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        /**
         * The active-goal uniqueness. Two live targets for the same person,
         * metric and period would make "am I on target" have two answers.
         */
        throw new ConflictException('That goal already exists. Archive the old one to replace it.');
      }
      throw e;
    }

    await this.audit.record({
      entityType: 'Goal',
      entityId: id,
      action: 'create',
      after: {
        scope: dto.scope,
        metric: dto.metric,
        target: dto.targetAmount,
        from: dto.periodStart,
        to: dto.periodEnd,
      },
      branchId: branchId ?? undefined,
    });
    return this.get(binToUuid(id));
  }

  /**
   * Goals in view, with progress computed for each.
   *
   * Scoped to what the reader is allowed to care about: everybody sees the
   * branch's and the company's targets, and a personal target is visible to its
   * owner and to whoever may manage goals. Somebody else's personal number is
   * not the shop's business to broadcast.
   */
  async list(includeArchived = false) {
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.userId();
    const canManage = await this.canManage();

    // A profit goal is a profit figure: nobody who may not see cost is shown one (docs/53 D35).
    const seesCost = await this.seesCost();
    const rows = await this.db.goal.findMany({
      where: {
        ...(includeArchived ? {} : { status: 'active' }),
        ...(seesCost ? {} : { metric: { not: 'gross_profit' as const } }),
        OR: [
          { scope: 'company' },
          { scope: 'branch', branchId },
          {
            scope: 'user',
            branchId,
            ...(canManage ? {} : { targetUserId: userId ?? undefined }),
          },
        ],
      },
      include: { targetUser: { select: { id: true, name: true } } },
      orderBy: [{ periodEnd: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });

    return { rows: await Promise.all(rows.map((g) => this.withProgress(g))) };
  }

  async get(id: string) {
    const branchId = this.tenant.requireBranchId();
    const goal = await this.db.goal.findFirst({
      where: { id: uuidToBin(id), OR: [{ scope: 'company' }, { branchId }] },
      include: { targetUser: { select: { id: true, name: true } } },
    });
    if (!goal) throw new NotFoundException('No such goal');
    if (goal.metric === 'gross_profit' && !(await this.seesCost())) throw new NotFoundException('No such goal');

    const canManage = await this.canManage();
    const userId = this.tenant.userId();
    if (
      goal.scope === 'user' &&
      !canManage &&
      (!userId || !goal.targetUserId?.equals(userId))
    ) {
      // Somebody else's personal target. A 404 rather than a 403, so the
      // existence of another person's number is not itself disclosed.
      throw new NotFoundException('No such goal');
    }
    return this.withProgress(goal);
  }

  /**
   * Archive, never delete. A goal that was missed is a fact about the shop's
   * history, and removing it would make every past period look met.
   */
  async archive(id: string, dto: ArchiveGoalDto) {
    const branchId = this.tenant.requireBranchId();
    const goal = await this.db.goal.findFirst({
      where: { id: uuidToBin(id), OR: [{ scope: 'company' }, { branchId }] },
    });
    if (!goal) throw new NotFoundException('No such goal');
    if (goal.status === 'archived') throw new ConflictException('That goal is already archived');
    if (!dto.reason?.trim()) throw new BadRequestException('Archiving a goal requires a reason');

    const won = await this.db.goal.updateMany({
      where: { id: goal.id, version: goal.version, status: 'active' },
      data: {
        status: 'archived',
        archivedReason: dto.reason.trim(),
        version: { increment: 1 },
      },
    });
    if (won.count === 0) {
      throw new ConflictException('refresh_required: this goal changed while you were archiving it');
    }

    await this.audit.record({
      entityType: 'Goal',
      entityId: goal.id,
      action: 'update',
      before: { status: 'active' },
      after: { status: 'archived', reason: dto.reason.trim() },
      branchId: goal.branchId ?? undefined,
    });
    return this.get(id);
  }

  // --- helpers --------------------------------------------------------------

  private requireBranch(dto: CreateGoalDto): string {
    if (!dto.branchId) throw new BadRequestException('A branch goal must say which branch');
    return dto.branchId;
  }

  private requireUser(dto: CreateGoalDto): string {
    if (!dto.targetUserId) throw new BadRequestException("A person's goal must say which person");
    return dto.targetUserId;
  }

  /**
   * Whether the reader may see everybody's personal targets.
   *
   * Resolved through `AccessService`, the same path the guard uses, rather
   * than re-deriving it from a role — nothing in this application compares a
   * role name, and a second definition of "may manage goals" would drift from
   * the first.
   */
  private async seesCost(): Promise<boolean> {
    const userId = this.tenant.userId();
    if (!userId) return false;
    const keys = await this.access.getEffectivePermissions(userId, this.tenant.branchId());
    return keys.has('cost.view');
  }

  private async canManage(): Promise<boolean> {
    const userId = this.tenant.userId();
    if (!userId) return false;
    const keys = await this.access.getEffectivePermissions(userId, this.tenant.branchId());
    return keys.has('goal.manage');
  }

  private async withProgress(goal: {
    id: Buffer;
    scope: string;
    branchId: Buffer | null;
    targetUserId: Buffer | null;
    metric: string;
    periodStart: Date;
    periodEnd: Date;
    periodLabel: string;
    targetAmount: Prisma.Decimal;
    status: string;
    archivedReason: string | null;
    note: string | null;
    version: number;
    targetUser?: { id: Buffer; name: string } | null;
  }) {
    const metric = goal.metric as GoalMetricKey;
    const periodStart = dayKey(goal.periodStart);
    const periodEnd = dayKey(goal.periodEnd);
    const achieved = await this.achieved(goal, metric, periodStart, periodEnd);

    return {
      id: binToUuid(goal.id),
      scope: goal.scope,
      branchId: goal.branchId ? binToUuid(goal.branchId) : null,
      targetUser: goal.targetUser
        ? { id: binToUuid(goal.targetUser.id), name: goal.targetUser.name }
        : null,
      metric,
      isMoney: isMoneyMetric(metric),
      periodStart,
      periodEnd,
      periodLabel: goal.periodLabel,
      status: goal.status,
      archivedReason: goal.archivedReason,
      note: goal.note,
      version: goal.version,
      progress: computeProgress({
        target: num(goal.targetAmount),
        achieved,
        periodStart,
        periodEnd,
        today: dayKey(new Date()),
      }),
    };
  }

  /**
   * What has actually been achieved over the period.
   *
   * Branch and company scope read `daily_rollups`, the authoritative figure. There
   * is no per-user rollup, so a personal goal is computed from the sale lines that
   * person made — attributed through the immutable `sales.user_id` — by the rollup's
   * own rules, so a personal figure and the branch figure describe the same sales
   * over the same days.
   *
   * A cancelled sale (0079, units 0080) counts in the period it was sold and comes
   * off in the period its cancellation was approved — never by rewriting the sale's
   * own period, which its Daily closing has already shown. Same day: nothing. Sold in
   * one period, cancelled in the next: the first keeps it, the second loses it.
   * `cancellation-periods.spec.ts` pins both paths to that rule.
   */
  private async achieved(
    goal: { scope: string; branchId: Buffer | null; targetUserId: Buffer | null },
    metric: GoalMetricKey,
    from: string,
    to: string,
  ): Promise<number> {
    if (goal.scope !== 'user') {
      const rows = await this.db.$queryRaw<{ total: unknown }[]>(
        Prisma.sql`
          SELECT COALESCE(SUM(${Prisma.raw(`\`${METRIC_COLUMN[metric]}\` - (${ADJUSTMENT[metric]})`)}), 0) AS total
          FROM daily_rollups
          WHERE company_id = ${this.tenant.companyId()}
            AND day >= ${from} AND day <= ${to}
            ${goal.branchId ? Prisma.sql`AND branch_id = ${goal.branchId}` : Prisma.empty}
        `,
      );
      return num(rows[0]?.total as number);
    }

    /**
     * Per person: the person's sales on their stored business dates, less the
     * person's sales whose cancellation was approved on a date of the period, less
     * the returns of the person's sales approved on a date of the period — the
     * rollup's `qty_sold`/`revenue`/…, `cancelled_*` and `returns_*` columns, for one seller.
     */
    const companyId = this.tenant.companyId();
    const value = Prisma.raw(PERSONAL_VALUE[metric]);
    const person = Prisma.sql`s.company_id = ${companyId} AND s.branch_id = ${goal.branchId} AND s.user_id = ${goal.targetUserId}`;
    const rows = await this.db.$queryRaw<{ sold: unknown; cancelled: unknown; returned: unknown }[]>(
      Prisma.sql`
        SELECT
          (SELECT ${value}
             FROM sales s
            WHERE ${person}
              AND s.business_date BETWEEN ${from} AND ${to}) AS sold,
          (SELECT ${value}
             FROM financial_corrections fc
             JOIN sales s ON s.id = fc.target_sale_id
            WHERE fc.company_id = ${companyId} AND ${person}
              AND fc.target_kind = 'sale' AND fc.status = 'approved'
              AND fc.correction_date BETWEEN ${from} AND ${to}) AS cancelled,
          (SELECT ${Prisma.raw(PERSONAL_RETURN[metric])}
             FROM return_reversals rr
             JOIN sales s ON s.id = rr.sale_id
            WHERE rr.company_id = ${companyId} AND ${person}
              AND rr.approval_date BETWEEN ${from} AND ${to}) AS returned
      `,
    );
    return round2(num(rows[0]?.sold as number) - num(rows[0]?.cancelled as number) - num(rows[0]?.returned as number));
  }
}
