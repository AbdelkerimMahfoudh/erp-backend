import { Module } from '@nestjs/common';
import { ReturnsController } from './returns.controller';
import { ReturnsService } from './returns.service';
import { ReturnNotifier } from './return-notifications';

/**
 * The reviewed return workflow (I2). Reuses the existing audit, notification,
 * tenant and RBAC infrastructure — this module adds no parallel mechanism.
 */
@Module({
  controllers: [ReturnsController],
  providers: [ReturnsService, ReturnNotifier],
  exports: [ReturnsService],
})
export class ReturnsModule {}
