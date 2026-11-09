import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../../common/context/request-context';
import { binToUuid } from '../../common/utils/uuid.util';
import { AccessService } from '../../rbac/access.service';
import { ClosingNoticeService, type ReportPdfMaker } from '../../closing/closing-notice.service';
import { ReportDocumentsService } from '../report-documents.service';
import { PdfRenderer } from './pdf-renderer';
import { serverReportContext } from './report-pdf-context';
import { buildReportHtml, reportFileName, type ReportPdfLanguage } from './vendor/report-pdf-html';

/**
 * The app's report PDF, made on the server for WhatsApp (owner, 2026-11-09): the same document the in-app PDF prints
 * (`GET /reports/daily|monthly`), read as the Owner it goes to — with exactly that Owner's permissions at that store,
 * so the file never shows more than the Owner could see in the app — and drawn by the app's own page builder.
 */
@Injectable()
export class ReportPdfService implements ReportPdfMaker, OnModuleInit {
  private readonly logger = new Logger(ReportPdfService.name);

  constructor(
    private readonly documents: ReportDocumentsService,
    private readonly access: AccessService,
    private readonly cls: ClsService<AppClsStore>,
    private readonly renderer: PdfRenderer,
    private readonly notices: ClosingNoticeService,
  ) {}

  onModuleInit(): void {
    if (this.renderer.available) this.notices.usePdfMaker(this);
  }

  async make(o: {
    companyId: Buffer;
    branchId: Buffer;
    ownerId: Buffer;
    language: ReportPdfLanguage;
    kind: 'daily' | 'monthly';
    period: string;
  }): Promise<{ content: Buffer; filename: string }> {
    return this.cls.run(async () => {
      this.cls.set('requestId', `report-pdf:${o.kind}:${o.period}`);
      this.cls.set('companyId', o.companyId);
      this.cls.set('branchId', o.branchId);
      this.cls.set('userId', binToUuid(o.ownerId));
      this.cls.set('permissions', await this.access.getEffectivePermissions(o.ownerId, o.branchId));
      const doc = o.kind === 'daily' ? await this.documents.daily(o.period) : await this.documents.monthly(o.period);
      const ctx = serverReportContext(o.language, doc.identity.timezone || 'UTC');
      const html = buildReportHtml(doc as never, ctx);
      const content = await this.renderer.render(html);
      this.logger.log(`Report PDF made: ${o.kind} ${o.period} (${Math.round(content.length / 1024)} KB)`);
      return { content, filename: reportFileName(doc as never, o.language) };
    });
  }
}
