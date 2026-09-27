import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ClosingController } from './closing.controller';
import { ClosingService } from './closing.service';
import { DiscrepanciesService } from './discrepancies.service';
import { ClosingNoticeService } from './closing-notice.service';
import { MoneyAnchorsController } from './money-anchors.controller';
import { MoneyAnchorsService } from './money-anchors.service';

@Module({
  imports: [AnalyticsModule, NotificationsModule], // RollupService (authoritative totals) + notifications
  controllers: [ClosingController, MoneyAnchorsController],
  providers: [ClosingService, DiscrepanciesService, ClosingNoticeService, MoneyAnchorsService],
  // Sales, receipts and later payments are refused while the day is closed (store_closed); nothing reopens a day by itself (docs/61).
  exports: [ClosingService],
})
export class ClosingModule {}
