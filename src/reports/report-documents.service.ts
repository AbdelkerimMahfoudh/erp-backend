import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AppClsStore } from '../common/context/request-context';
import { AuditService } from '../common/audit/audit.service';
import { BusinessDayService } from '../common/business-day/business-day.service';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { PrismaService } from '../prisma/prisma.service';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { ClosingService } from '../closing/closing.service';
import { ReturnsService } from '../returns/returns.service';
import { SummaryService } from '../analytics/summary.service';
import { figuresByDay } from '../analytics/period-figures';
import { openReceivables } from '../sales/open-receivables';
import {
  dailyDocument,
  monthlyDocument,
  monthRange,
  type DailyDocument,
  type MonthlyDocument,
  type MonthRange,
  type ReportIdentity,
} from './report-documents';

/**
 * Reads the figures a report document prints, from the services that already own them,
 * and hands them to the pure assembly in `report-documents.ts` (docs/66).
 *
 * Authorization is the routes' (`report.view`, and `closing.count` for the daily one) plus,
 * inside, the same permission each source applies on its own route: the closing gates its
 * report for this caller, the refund figures need `return.view`, and the result needs
 * `cost.view`. A document never shows somebody more than the screens they can open.
 *
 * Read-only: nothing here writes a business record. The one write is the audit row that
 * says a document was served — what was asked for and what was allowed, never a figure.
 */
@Injectable()
export class ReportDocumentsService {
  constructor(
    private readonly closing: ClosingService,
    private readonly returns: ReturnsService,
    private readonly summary: SummaryService,
    private readonly businessDay: BusinessDayService,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly cls: ClsService<AppClsStore>,
    private readonly prisma: PrismaService,
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
  ) {}

  private held(key: string): boolean {
    return this.cls.get('permissions')?.has(key) ?? false;
  }

  /** The daily report of one business date — the current one when none is given. */
  async daily(date?: string): Promise<DailyDocument> {
    const branchId = this.tenant.requireBranchId();
    const report = await this.closing.report(date);
    const [identity, refunds, receivables] = await Promise.all([
      this.identity(branchId, report.timezone),
      this.held('return.view') ? this.returns.refundSummary({ from: report.date, to: report.date }) : Promise.resolve(null),
      openReceivables(this.db, branchId),
    ]);
    const doc = dailyDocument({ identity, report, refunds, receivables, generatedAt: new Date() });
    await this.served('daily', { date: doc.date, source: doc.basis.source }, doc.sections);
    return doc;
  }

  /** The monthly report of one calendar month — the current one, to date, when none is given. */
  async monthly(month?: string): Promise<MonthlyDocument> {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const today = await this.businessDay.today(branchId);
    let range: MonthRange;
    try {
      range = monthRange(month, today);
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : 'month must be YYYY-MM');
    }
    const [identity, summary, days, refunds, receivables] = await Promise.all([
      this.identity(branchId, await this.businessDay.timezone(companyId)),
      this.summary.forPeriod(range.from, range.to),
      figuresByDay(this.db, companyId, branchId, range.from, range.to),
      this.held('return.view') ? this.returns.refundSummary({ from: range.from, to: range.to }) : Promise.resolve(null),
      openReceivables(this.db, branchId),
    ]);
    const doc = monthlyDocument({
      identity,
      range,
      summary,
      days,
      refunds,
      receivables,
      costView: this.held('cost.view'),
      generatedAt: new Date(),
    });
    await this.served('monthly', { month: doc.month, complete: doc.complete }, doc.sections);
    return doc;
  }

  /** The shop's and the branch's names — nothing else about either. */
  private async identity(branchId: Buffer, timezone: string): Promise<ReportIdentity> {
    // `Company` has no company column for the tenant client to scope by: the unscoped client, by id.
    const [company, branch] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: this.tenant.companyId() }, select: { name: true } }),
      this.db.branch.findFirst({ where: { id: branchId }, select: { name: true } }),
    ]);
    return { company: company?.name ?? '', branch: branch?.name ?? '', timezone };
  }

  /**
   * The same trail a spreadsheet export leaves (`report_export`): which document, for which
   * period, with which sections. Whether the phone then printed or shared it is not something
   * this server saw, and the row does not claim it.
   */
  private async served(kind: 'daily' | 'monthly', period: Record<string, string | boolean>, sections: object): Promise<void> {
    await this.audit.record({
      entityType: 'report_export',
      action: 'create',
      after: { event: 'report_document_served', kind, ...period, sections: { ...sections }, outcome: 'served' },
    });
  }
}
