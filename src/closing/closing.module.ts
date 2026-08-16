import { Module } from '@nestjs/common';
import { SuppliersModule } from '../suppliers/suppliers.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ClosingController } from './closing.controller';
import { ClosingService } from './closing.service';
import { DiscrepanciesService } from './discrepancies.service';

@Module({
  imports: [AnalyticsModule, NotificationsModule, SuppliersModule], // RollupService (authoritative totals) + notifications
  controllers: [ClosingController],
  providers: [ClosingService, DiscrepanciesService],
})
export class ClosingModule {}
