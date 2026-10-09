import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { binToUuid } from '../common/utils/uuid.util';
import { isDateString } from '../common/business-day';
import { BusinessDayService, dateKey, dateValue } from '../common/business-day/business-day.service';
import { requireAgentActivity } from './agent-access';
import { aggregateAgentReport, periodRangeOf, type ReportRebalancingLeg, type ReportTransaction } from './agent-report-rules';
import { accountsWithMoney, floatKey, readFloat, type FloatProvider, type FloatView } from './float-positions';
import { AgentReportQueryDto } from './dto/report.dto';

const num = (d: Prisma.Decimal | number | null): number => (d == null ? 0 : Number(d));

/**
 * The counter's reports (D157): a period's exchanges aggregated by the pure
 * rules, the floats as they stood at the period's end, and the float counts
 * whose difference opened a question at a closing of the period. Business-day
 * semantics throughout: the rows carry the business date they were stored
 * with, and a past period ends at its last day's 06:00 boundary.
 */
@Injectable()
export class AgentReportsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly businessDay: BusinessDayService,
  ) {}

  async report(query: AgentReportQueryDto) {
    const branchId = this.tenant.requireBranchId();
    await requireAgentActivity(this.db, branchId);
    const today = await this.businessDay.today(branchId);
    const date = query.date ?? today;
    if (!isDateString(date)) throw new BadRequestException('date must be YYYY-MM-DD');
    const { from, to } = periodRangeOf(query.period, date);
    const range = { gte: dateValue(from), lte: dateValue(to) };

    const [transactions, legs, providers, withMoney, counts] = await Promise.all([
      this.db.agentTransaction.findMany({
        where: { branchId, businessDate: range },
        select: { providerId: true, provider: { select: { label: true } }, direction: true, amount: true, commissionAmount: true, status: true, recordedById: true, recordedByName: true, businessDate: true },
      }),
      this.db.agentMovement.findMany({
        where: { branchId, kind: 'rebalancing', businessDate: range },
        select: { rebalancingId: true, accountKind: true, direction: true, amount: true, businessDate: true },
      }),
      this.db.agentProvider.findMany({ select: { id: true, kind: true, label: true, isActive: true }, orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] }),
      accountsWithMoney(this.db, branchId),
      this.db.agentFloatCount.findMany({
        where: { branchId, difference: { not: null }, closing: { closingDate: range } },
        select: {
          providerId: true,
          provider: { select: { label: true } },
          expected: true,
          counted: true,
          difference: true,
          explanation: true,
          closing: { select: { closingDate: true } },
          discrepancies: { select: { status: true }, orderBy: { openedAt: 'desc' }, take: 1 },
        },
        orderBy: { closing: { closingDate: 'asc' } },
      }),
    ]);

    const rows: ReportTransaction[] = transactions.map((t) => ({
      providerId: binToUuid(t.providerId),
      providerLabel: t.provider.label,
      direction: t.direction,
      amount: num(t.amount),
      commission: num(t.commissionAmount),
      status: t.status,
      recordedById: binToUuid(t.recordedById),
      recordedByName: t.recordedByName,
      businessDate: dateKey(t.businessDate),
    }));
    const rebalancingLegs: ReportRebalancingLeg[] = legs
      .filter((l) => l.rebalancingId !== null)
      .map((l) => ({ rebalancingId: binToUuid(l.rebalancingId as Buffer), account: l.accountKind, direction: l.direction, amount: num(l.amount), businessDate: dateKey(l.businessDate) }));

    // The floats at the period's end: now for a period still running, else the last day's boundary.
    const asOf = to >= today ? new Date() : (await this.businessDay.windowOf(to)).end;
    const floatProviders: FloatProvider[] = providers.map((p) => ({ id: binToUuid(p.id), label: p.label, kind: p.kind, isActive: p.isActive }));
    const floats: FloatView[] = await Promise.all(
      floatProviders.filter((p) => p.isActive || withMoney.has(floatKey('provider', p.id))).map((p) => readFloat(this.db, p, 'provider', { branchId, businessDate: to >= today ? today : to, asOf })),
    );

    return {
      ...aggregateAgentReport({ period: query.period, from, to, transactions: rows, rebalancingLegs }),
      positions: {
        floats,
        discrepancies: counts
          .filter((c) => num(c.difference) !== 0)
          .map((c) => ({
            businessDate: dateKey(c.closing.closingDate),
            providerId: binToUuid(c.providerId),
            label: c.provider.label,
            expected: c.expected == null ? null : num(c.expected),
            counted: c.counted == null ? null : num(c.counted),
            difference: num(c.difference),
            explanation: c.explanation,
            status: c.discrepancies[0]?.status ?? null,
          })),
      },
    };
  }
}
