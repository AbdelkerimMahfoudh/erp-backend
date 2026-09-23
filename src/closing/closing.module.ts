import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ClosingController } from './closing.controller';
import { ClosingService } from './closing.service';
import { DiscrepanciesService } from './discrepancies.service';
import { ClosingNoticeService } from './closing-notice.service';

@Module({
  imports: [AnalyticsModule, NotificationsModule], // RollupService (authoritative totals) + notifications
  controllers: [ClosingController],
  providers: [ClosingService, DiscrepanciesService, ClosingNoticeService],
  // Sales reopen a closed day from inside their own transaction (0076).
  exports: [ClosingService],
})
export class ClosingModule {}
