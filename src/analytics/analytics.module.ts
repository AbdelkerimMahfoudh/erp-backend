import { Module } from '@nestjs/common';
import { RollupService } from './rollup.service';
import { RollupListener } from './rollup.listener';
import { ROLLUP_QUEUE } from './rollup-queue';
import { InProcessRollupQueue } from './in-process-rollup-queue';
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
 * drives the listener; PrismaService (global) backs the recompute. The queue
 * binding is the only thing that changes to move rollups onto BullMQ later.
 * ROLLUP_QUEUE is exported so receiving can refresh branch snapshots on intake.
 */
@Module({
  imports: [ConsignmentModule],
  controllers: [AnalyticsController, DashboardController, HealthController],
  providers: [
    SummaryService,
    RollupService,
    { provide: ROLLUP_QUEUE, useClass: InProcessRollupQueue },
    RollupListener,
    AnalyticsService,
    DashboardService,
    HealthService,
  ],
  exports: [RollupService, ROLLUP_QUEUE, AnalyticsService, DashboardService],
})
export class AnalyticsModule {}
