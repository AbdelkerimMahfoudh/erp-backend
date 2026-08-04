import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ClosingController } from './closing.controller';
import { ClosingService } from './closing.service';

@Module({
  imports: [AnalyticsModule, NotificationsModule], // RollupService (authoritative totals) + notifications
  controllers: [ClosingController],
  providers: [ClosingService],
})
export class ClosingModule {}
