import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { ClosingModule } from '../closing/closing.module';
import { ReturnsController } from './returns.controller';
import { ReturnsService } from './returns.service';
import { ReturnNotifier } from './return-notifications';

/**
 * The reviewed return workflow (I2). Reuses the existing audit, notification,
 * tenant and RBAC infrastructure — this module adds no parallel mechanism.
 */
@Module({
  // RollupService: an approved return is reported on its approval day. ClosingService: the day's lock an approval
  // and a refund confirmation take (D159).
  imports: [AnalyticsModule, ClosingModule],
  controllers: [ReturnsController],
  providers: [ReturnsService, ReturnNotifier],
  exports: [ReturnsService],
})
export class ReturnsModule {}
