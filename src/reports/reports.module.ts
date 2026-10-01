import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { ClosingModule } from '../closing/closing.module';
import { LoansModule } from '../loans/loans.module';
import { ReturnsModule } from '../returns/returns.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ReportDocumentsService } from './report-documents.service';

/**
 * Reporting exports: the spreadsheets, and the daily and monthly report documents the
 * app prints as PDFs (docs/66).
 *
 * Owns no data and defines no metric: every figure comes from the module that
 * already owns it. This module's whole job is authorization, projection and
 * bytes.
 */
@Module({
  imports: [AnalyticsModule, LoansModule, ClosingModule, ReturnsModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportDocumentsService],
})
export class ReportsModule {}
