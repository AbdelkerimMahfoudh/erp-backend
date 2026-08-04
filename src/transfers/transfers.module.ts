import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { TransfersController } from './transfers.controller';
import { TransfersService } from './transfers.service';

@Module({
  imports: [NotificationsModule],
  controllers: [TransfersController],
  providers: [TransfersService],
})
export class TransfersModule {}
