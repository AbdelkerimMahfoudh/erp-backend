import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { PricingModule } from '../pricing/pricing.module';
import { TransfersController } from './transfers.controller';
import { TransfersService } from './transfers.service';

@Module({
  imports: [NotificationsModule, PricingModule],
  controllers: [TransfersController],
  providers: [TransfersService],
})
export class TransfersModule {}
