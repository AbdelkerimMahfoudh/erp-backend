import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { LoansModule } from '../loans/loans.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/**
 * Reporting exports.
 *
 * Owns no data and defines no metric: every figure comes from the module that
 * already owns it. This module's whole job is authorization, projection and
 * bytes.
 */
@Module({
  imports: [AnalyticsModule, LoansModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
