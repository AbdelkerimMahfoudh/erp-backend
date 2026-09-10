import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AnomaliesController } from './anomalies.controller';
import { AnomaliesService } from './anomalies.service';

/**
 * The six deterministic anomaly rules (A3).
 *
 * Depends on `AnalyticsModule` for exactly one reason: the dead-stock list, the
 * low-stock list and a seller's margin are figures that already exist there,
 * and asking for them is what stops this module becoming a second definition
 * of any of them.
 */
@Module({
  imports: [AnalyticsModule],
  controllers: [AnomaliesController],
  providers: [AnomaliesService],
  exports: [AnomaliesService],
})
export class AnomaliesModule {}
