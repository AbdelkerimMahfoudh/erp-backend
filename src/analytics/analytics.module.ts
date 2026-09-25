import { Module } from '@nestjs/common';
import { RollupService } from './rollup.service';
import { RollupListener } from './rollup.listener';
import { ROLLUP_QUEUE } from './rollup-queue';
import { RollupOutboxService } from './rollup-outbox.service';
import { AnalyticsService } from './analytics.service';
import { SummaryService } from './summary.service';
import { AnalyticsController } from './analytics.controller';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { HealthService } from './health.service';
import { HealthController } from './health.controller';
import { ConsignmentModule } from '../consignment/consignment.module';

/**
 * Analytics rollups + reads (2D.1–2D.2). SpineEventBus (global EventsModule)
 * kicks the queue after a commit; PrismaService (global) backs the recompute. The
 * queue works durable requests written inside each business transaction (0081,
 * docs/52); ROLLUP_QUEUE is exported so the modules that commit changes can kick it.
 */
@Module({
  imports: [ConsignmentModule],
  controllers: [AnalyticsController, DashboardController, HealthController],
  providers: [
    SummaryService,
    RollupService,
    RollupOutboxService,
    { provide: ROLLUP_QUEUE, useExisting: RollupOutboxService },
    RollupListener,
    AnalyticsService,
    DashboardService,
    HealthService,
  ],
  exports: [RollupService, ROLLUP_QUEUE, AnalyticsService, DashboardService],
})
export class AnalyticsModule {}
