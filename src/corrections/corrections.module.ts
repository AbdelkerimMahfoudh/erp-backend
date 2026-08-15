import { Module } from '@nestjs/common';
import { CorrectionsController } from './corrections.controller';
import { CorrectionsService } from './corrections.service';
import { AnalyticsModule } from '../analytics/analytics.module';

@Module({
  // RollupService: an approved correction posts its compensating movement on
  // the correction day, so that day's figures must be recomputed.
  imports: [AnalyticsModule],
  controllers: [CorrectionsController],
  providers: [CorrectionsService],
  exports: [CorrectionsService],
})
export class CorrectionsModule {}
