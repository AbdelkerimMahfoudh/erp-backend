import { BadRequestException, ForbiddenException, Inject, Injectable, PayloadTooLargeException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AppClsStore } from '../common/context/request-context';
import { AuditService } from '../common/audit/audit.service';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { AnalyticsService } from '../analytics/analytics.service';
import { DashboardService } from '../analytics/dashboard.service';
import { LoansService } from '../loans/loans.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { writeCsv } from './csv-writer';
import { count, isoDate, money, text } from './report-values';
import {
  authorizedColumns,
  REPORTS,
  substantive,
  type ReportColumn,
  type ReportDefinition,
  type ReportKind,
} from './report-catalogue';
import { moneyHeader, t, type ReportLocale } from './report-i18n';

/**
 * The most rows one export may contain.
 *
 * Chosen rather than derived: a hundred thousand rows is roughly ten megabytes
 * of text, comfortably inside what a phone can hold in memory and hand to a
 * share sheet, and far beyond any real shop's product list. It exists so an
 * export can be REFUSED rather than truncated — a spreadsheet that silently
 * stops at row 50 000 is worse than no spreadsheet, because nothing in the file
 * says it is incomplete.
 */
export const MAX_EXPORT_ROWS = 100_000;

/** The window a period report may cover. Matches the analytics clamp. */
export const MIN_DAYS = 1;
export const MAX_DAYS = 366;

export interface ExportRequest {
  kind: ReportKind;
  locale: ReportLocale;
  /** Only meaningful for a `period` report; rejected for an `as_of` one. */
  days?: number;
}

export interface ExportResult {
  csv: string;
  filename: string;
  /** Human-readable branch scope, for the client to show beside the download. */
  scope: string;
  rowCount: number;
  columnIds: string[];
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly dashboard: DashboardService,
    private readonly loans: LoansService,
    private readonly suppliers: SuppliersService,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly cls: ClsService<AppClsStore>,
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
  ) {}

  private permissions(): ReadonlySet<string> {
    return this.cls.get('permissions') ?? new Set<string>();
  }

  /**
   * Produce one report as CSV.
   *
   * The order is deliberate and is the whole security argument: authorize,
   * then fetch, then project onto authorized columns, then serialize. By the
   * time a string exists there is nothing left in it to strip, which is why
   * nothing downstream is asked to strip anything.
   */
  async export(request: ExportRequest): Promise<ExportResult> {
    const definition = REPORTS[request.kind];
    const permissions = this.permissions();

    // 1. Authorize — the report's own extra permissions, on every request.
    for (const required of definition.requires) {
      if (!permissions.has(required)) {
        throw new ForbiddenException(`This report requires the ${required} permission.`);
      }
    }

    // 2. Bound it in time, in whichever way this report is bounded at all.
    const days = this.resolveDays(definition, request.days);

    // 3. The columns this caller may receive, decided before any data is read.
    const columns = authorizedColumns(definition, permissions);
    if (!substantive(columns)) {
      throw new ForbiddenException(
        'This report is made of figures you do not have permission to see. ' +
          'It needs the cost.view permission.',
      );
    }

    // 4. Fetch through the services that own these definitions.
    const rows = await this.rowsFor(definition, days);
    if (rows.length > MAX_EXPORT_ROWS) {
      throw new PayloadTooLargeException(
        `This report has ${rows.length} rows and the limit is ${MAX_EXPORT_ROWS}. ` +
          'Narrow the period and try again.',
      );
    }

    // 5. Project, then serialize.
    const header = this.header(columns, request.locale);
    const body = rows.map((row) => columns.map((c) => c.cell(row)));
    const csv = writeCsv(header, body);

    await this.recordExport(definition, request, days, columns, rows.length);

    return {
      csv,
      filename: this.filename(definition, request, days),
      scope: await this.branchLabel(definition, request.locale),
      rowCount: rows.length,
      columnIds: columns.map((c) => c.id),
    };
  }

  // ── time ───────────────────────────────────────────────────────────────────

  /**
   * A window for a period report; nothing at all for an as-of one.
   *
   * A date range on a current-balances report is rejected rather than ignored.
   * Ignoring it would hand back a file that answers a different question from
   * the one that was asked, and nothing in the file would say so.
   */
  private resolveDays(definition: ReportDefinition, days?: number): number | null {
    if (definition.scope === 'as_of') {
      if (days !== undefined) {
        throw new BadRequestException(
          `The ${definition.kind} report describes the present, not a period, so it takes no days parameter.`,
        );
      }
      return null;
    }
    const resolved = days ?? 30;
    if (!Number.isInteger(resolved) || resolved < MIN_DAYS || resolved > MAX_DAYS) {
      throw new BadRequestException(`days must be a whole number between ${MIN_DAYS} and ${MAX_DAYS}.`);
    }
    return resolved;
  }

  // ── data ───────────────────────────────────────────────────────────────────

  /**
   * Every row, from the service that already owns the definition.
   *
   * No SQL is written here. A second query for "profit by product" would be a
   * second definition of profit, and the first time the two disagreed the shop
   * would have no way to tell which was right.
   */
  private async rowsFor(
    definition: ReportDefinition,
    days: number | null,
  ): Promise<Record<string, unknown>[]> {
    switch (definition.kind) {
      case 'profit-by-product': {
        const { products } = await this.analytics.productPerformance(days ?? 30);
        return products as unknown as Record<string, unknown>[];
      }

      case 'movers': {
        // The same rows, ranked by what moved rather than by what earned.
        const { products } = await this.analytics.productPerformance(days ?? 30);
        return [...products].sort((a, b) => b.qtySold - a.qtySold) as unknown as Record<string, unknown>[];
      }

      case 'profit-by-employee':
        return (await this.dashboard.employeePerformance(days ?? 30)) as unknown as Record<string, unknown>[];

      case 'profit-by-branch':
        return (await this.dashboard.branchComparison(days ?? 30)) as unknown as Record<string, unknown>[];

      case 'dead-stock':
        // No limit: the dashboard's ten is a card's worth, not the report.
        return (await this.dashboard.deadStock()) as unknown as Record<string, unknown>[];

      case 'debtors-creditors':
        return this.debtorsAndCreditors();
    }
  }

  /**
   * Both directions of what is owed, as of now.
   *
   * Two sources, because the shop has two kinds of counterparty and they are
   * not the same idea: a loan is an agreed debt with a status and a ledger, and
   * a supplier balance is what has been received and not yet settled. They are
   * kept apart by the `source` column rather than added together, for the
   * reason `SummaryService.balances` gives — a single "total owed" that spans
   * both would be a number nobody could reconcile against either ledger.
   *
   * Suppliers are paged through to the end. Exporting the first page would be
   * exporting what the phone happened to have loaded.
   */
  private async debtorsAndCreditors(): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];

    const { rows: loans } = await this.loans.list(undefined, { all: true });
    for (const loan of loans) {
      if (!loan.remaining) continue; // settled, forgiven or never accepted
      rows.push({
        direction: loan.direction === 'they_owe_us' ? 'owed_to_us' : 'owed_by_us',
        source: 'loan',
        counterparty: loan.otherParty,
        status: loan.statusText,
        since: loan.createdAt,
        outstanding: loan.remaining,
      });
    }

    /*
     * `SuppliersService.list` omits `outstanding` entirely for a caller who
     * cannot see the shop's money — it is the same field-permission policy
     * this export defers to everywhere else. A row with no balance is not
     * written as zero; it is not written at all, because "we owe this supplier
     * nothing" and "you may not know what we owe this supplier" are different
     * statements and a spreadsheet cannot hold both in one cell.
     */
    let cursor: string | undefined;
    for (;;) {
      const page = await this.suppliers.list({ limit: 50, status: 'all', cursor });
      for (const supplier of page.rows) {
        const outstanding = (supplier as { outstanding?: number }).outstanding;
        if (outstanding === undefined || outstanding === 0) continue;
        rows.push({
          direction: outstanding > 0 ? 'owed_by_us' : 'owed_to_us',
          source: 'supplier',
          counterparty: supplier.name,
          status: null,
          since: null,
          outstanding: Math.abs(outstanding),
        });
      }
      cursor = page.nextCursor ?? undefined;
      if (!cursor) break;
    }

    return rows.sort((a, b) => Number(b.outstanding) - Number(a.outstanding));
  }

  // ── serialization ──────────────────────────────────────────────────────────

  private header(columns: readonly ReportColumn[], locale: ReportLocale): string[] {
    return columns.map((c) =>
      c.currency ? moneyHeader(locale, `column.${c.key}`) : t(locale, `column.${c.key}`),
    );
  }

  /**
   * Which branch the figures describe.
   *
   * `profit-by-branch` is always company-wide by construction — comparing
   * branches is the question — and says so in its own words rather than naming
   * the active branch, which would be a lie about the file's contents.
   */
  private async branchLabel(definition: ReportDefinition, locale: ReportLocale): Promise<string> {
    if (definition.kind === 'profit-by-branch') return t(locale, 'meta.companyWide');
    const branchId = this.tenant.branchId();
    if (!branchId) return t(locale, 'meta.allBranches');
    const branch = await this.db.branch.findFirst({ where: { id: branchId }, select: { name: true } });
    return branch?.name ?? t(locale, 'meta.allBranches');
  }

  /**
   * A filename a phone and a spreadsheet can both live with — and the only
   * place this file says what it is.
   *
   * The provenance lives here because it cannot live in the file: a block above
   * the table makes the CSV a ragged rectangle, and `parseCsv` eats the blank
   * separator, so the metadata arrives as data. The filename is what every
   * other export tool uses and what a person actually reads three weeks later,
   * when the risk is mistaking last month's figures for this month's.
   *
   * So the period is spelled out for a window report and the as-of date for a
   * current one — `profit-by-product_2026-08-12_to_2026-09-10_en.csv` against
   * `dead-stock_as-of_2026-09-10_en.csv`. The two cannot be confused.
   *
   * ASCII only, and built from the report KIND rather than its translated
   * title: a `Content-Disposition` header carrying Arabic needs RFC 5987
   * encoding that not every client implements, and a shop that cannot open the
   * file has no report. The language is inside the file, where it works.
   */
  private filename(definition: ReportDefinition, request: ExportRequest, days: number | null): string {
    const today = isoDate(new Date());
    const when =
      definition.scope === 'period'
        ? `${isoDate(new Date(Date.now() - ((days ?? 30) - 1) * 86_400_000))}_to_${today}`
        : `as-of_${today}`;
    return `${definition.kind}_${when}_${request.locale}.csv`;
  }

  // ── audit ──────────────────────────────────────────────────────────────────

  /**
   * Record that a file was GENERATED.
   *
   * Deliberately not "exported" or "downloaded": the server knows it produced
   * bytes and handed them to a response. Whether they reached a device, a share
   * sheet, an email or a bin is not something this process observed, and an
   * audit trail that claims otherwise is worse than one that says less.
   *
   * The row carries what was asked for and what was allowed — never a cell of
   * the file itself. An audit log holding the shop's margins would be a second
   * copy of exactly the data the column gating exists to control.
   */
  private async recordExport(
    definition: ReportDefinition,
    request: ExportRequest,
    days: number | null,
    columns: readonly ReportColumn[],
    rowCount: number,
  ): Promise<void> {
    await this.audit.record({
      entityType: 'report_export',
      action: 'create',
      after: {
        event: 'report_export_generated',
        kind: definition.kind,
        scope: definition.scope,
        ...(days === null ? { asOf: isoDate(new Date()) } : { days }),
        locale: request.locale,
        branchScope:
          definition.kind === 'profit-by-branch'
            ? 'company'
            : this.tenant.branchId()
              ? 'branch'
              : 'all_branches',
        columns: columns.map((c) => c.id),
        rowCount,
        outcome: 'generated',
      },
    });
  }
}

/* Re-exported so tests can build cells without importing three modules. */
export { count, isoDate, money, text };
