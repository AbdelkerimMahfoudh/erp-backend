import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RollupService } from '../analytics/rollup.service';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { dayKey } from '../common/utils/date.util';
import { CreateClosingDto } from './dto/create-closing.dto';

const num = (d: Prisma.Decimal | number | null): number => (d == null ? 0 : Number(d));
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Daily closing + digest. The branch-day rollup is recomputed first so it is
 * the single authoritative source for revenue / COGS / gross / expenses / net
 * profit — all tracking-type independent. One transaction writes the closing,
 * the digest, and its per-line detail; then an in-app notification and a
 * historical comparison are returned.
 */
@Injectable()
export class ClosingService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly rollups: RollupService,
  ) {}

  async close(dto: CreateClosingDto) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const day = dto.date ?? dayKey(new Date());
    const dayDate = new Date(`${day}T00:00:00.000Z`);
    const start = dayDate;
    const end = new Date(dayDate.getTime() + 86_400_000);

    const already = await this.db.dailyClosing.findUnique({
      where: { branchId_closingDate: { branchId, closingDate: dayDate } },
    });
    if (already) throw new ConflictException(`Day ${day} is already closed for this branch`);

    // Authoritative aggregation: refresh then read the branch-day rollup.
    await this.rollups.recomputeDaily(companyId, branchId, day);
    const rollup = await this.db.dailyRollup.findUnique({
      where: { branchId_day: { branchId, day: dayDate } },
    });
    const revenue = round2(num(rollup?.revenue ?? 0));
    const cogs = round2(num(rollup?.cogs ?? 0));
    const grossProfit = round2(num(rollup?.grossProfit ?? 0));
    const expenses = round2(num(rollup?.expenses ?? 0));
    const netProfit = round2(num(rollup?.netProfit ?? 0));

    // Expected cash = cash payments taken on the day at this branch.
    const cash = await this.db.payment.aggregate({
      _sum: { amount: true },
      where: { method: 'cash', sale: { branchId, soldAt: { gte: start, lt: end } } },
    });
    const expectedCash = round2(num(cash._sum.amount));
    const difference = round2(dto.countedCash - expectedCash);

    const lines = await this.buildDigestLines(companyId, branchId, start, end);

    const result = await this.db.$transaction(async (tx) => {
      const closingId = newUuidV7Bin();
      await tx.dailyClosing.create({
        data: {
          id: closingId,
          companyId,
          branchId,
          closingDate: dayDate,
          expectedCash,
          countedCash: dto.countedCash,
          difference,
          totalSales: revenue,
          totalProfit: netProfit,
          isLocked: true,
          closedById: this.tenant.userId() ?? null,
        },
      });

      const digestId = newUuidV7Bin();
      await tx.dailyDigest.create({
        data: {
          id: digestId,
          companyId,
          branchId,
          closingId,
          digestDate: dayDate,
          revenue,
          costOfGoodsSold: cogs,
          grossProfit,
        },
      });
      if (lines.length > 0) {
        await tx.digestLine.createMany({ data: lines.map((l) => ({ ...l, id: newUuidV7Bin(), companyId, digestId })) });
      }

      await this.audit.recordTx(tx, {
        entityType: 'DailyClosing',
        entityId: closingId,
        action: 'create',
        after: { day, revenue, netProfit, difference },
        branchId,
      });
      return { closingId, digestId };
    });

    await this.notifications.emit({
      type: 'closing.completed',
      title: `Day ${day} closed`,
      body: `Revenue ${revenue} · Net profit ${netProfit}`,
      branchId,
    });

    const comparison = await this.historicalComparison(branchId, dayDate);
    return {
      closingId: binToUuid(result.closingId),
      date: day,
      digest: { revenue, costOfGoodsSold: cogs, grossProfit, expenses, netProfit, lineCount: lines.length },
      cash: { expected: expectedCash, counted: round2(dto.countedCash), difference },
      comparison,
    };
  }

  async getClosing(date: string) {
    const branchId = this.tenant.requireBranchId();
    const closing = await this.db.dailyClosing.findUnique({
      where: { branchId_closingDate: { branchId, closingDate: new Date(`${date}T00:00:00.000Z`) } },
    });
    if (!closing) throw new NotFoundException(`No closing for ${date}`);
    return closing;
  }

  async getDigest(date: string) {
    const branchId = this.tenant.requireBranchId();
    const dayDate = new Date(`${date}T00:00:00.000Z`);
    const digest = await this.db.dailyDigest.findUnique({
      where: { branchId_digestDate: { branchId, digestDate: dayDate } },
      include: { lines: true },
    });
    if (!digest) throw new NotFoundException(`No digest for ${date}`);
    const rollup = await this.db.dailyRollup.findUnique({ where: { branchId_day: { branchId, day: dayDate } } });
    return {
      date,
      revenue: round2(num(digest.revenue)),
      costOfGoodsSold: round2(num(digest.costOfGoodsSold)),
      grossProfit: round2(num(digest.grossProfit)),
      expenses: round2(num(rollup?.expenses ?? 0)),
      netProfit: round2(num(rollup?.netProfit ?? 0)),
      lines: digest.lines.map((l) => ({
        identifier: l.identifier,
        productLabel: l.productLabel,
        salePrice: num(l.salePrice),
        purchaseCost: num(l.purchaseCost),
        profit: num(l.profit),
        soldAt: l.soldAt,
        employeeId: l.employeeId ? binToUuid(l.employeeId) : null,
      })),
      comparison: await this.historicalComparison(branchId, dayDate),
    };
  }

  // --- helpers --------------------------------------------------------------

  private async buildDigestLines(companyId: Buffer, branchId: Buffer, start: Date, end: Date) {
    const items = await this.db.saleItem.findMany({
      where: { voided: false, sale: { branchId, soldAt: { gte: start, lt: end } } },
      include: {
        unit: { select: { imeiPrimary: true, serialNo: true, product: { select: { brand: true, model: true, variant: true } } } },
        product: { select: { brand: true, model: true, variant: true } },
        sale: { select: { userId: true, soldAt: true } },
      },
    });
    const label = (p?: { brand: string; model: string; variant: string | null } | null) =>
      p ? `${p.brand} ${p.model}${p.variant ? ` ${p.variant}` : ''}` : null;

    return items.map((it) => {
      const salePrice = round2(num(it.price) * it.quantity - num(it.discount));
      const purchaseCost = round2(num(it.cost) * it.quantity);
      return {
        identifier: it.unit ? it.unit.imeiPrimary ?? it.unit.serialNo : null,
        productLabel: label(it.unit?.product ?? it.product),
        employeeId: it.sale.userId,
        salePrice,
        purchaseCost,
        profit: round2(salePrice - purchaseCost),
        method: null,
        soldAt: it.sale.soldAt,
      };
    });
  }

  private async historicalComparison(branchId: Buffer, dayDate: Date) {
    const yesterday = new Date(dayDate.getTime() - 86_400_000);
    const lastWeek = new Date(dayDate.getTime() - 7 * 86_400_000);
    const monthStart = new Date(`${dayKey(dayDate).slice(0, 8)}01T00:00:00.000Z`);

    const dayFig = async (d: Date) => {
      const r = await this.db.dailyRollup.findUnique({ where: { branchId_day: { branchId, day: d } } });
      return { revenue: round2(num(r?.revenue ?? 0)), netProfit: round2(num(r?.netProfit ?? 0)) };
    };
    const mtd = await this.db.dailyRollup.aggregate({
      _sum: { revenue: true, netProfit: true },
      where: { branchId, day: { gte: monthStart, lte: dayDate } },
    });

    return {
      today: await dayFig(dayDate),
      yesterday: await dayFig(yesterday),
      sameDayLastWeek: await dayFig(lastWeek),
      monthToDate: { revenue: round2(num(mtd._sum.revenue)), netProfit: round2(num(mtd._sum.netProfit)) },
    };
  }
}
