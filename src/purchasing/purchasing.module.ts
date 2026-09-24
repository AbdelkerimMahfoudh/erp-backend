import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TrackingModule } from '../tracking/tracking.module';
import { RecognitionModule } from '../scanner/recognition.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { PurchasingController } from './purchasing.controller';
import { ClosingModule } from '../closing/closing.module';
import { PurchasingService } from './purchasing.service';

@Module({
  imports: [InventoryModule, NotificationsModule, TrackingModule, RecognitionModule, AnalyticsModule, ClosingModule],
  controllers: [PurchasingController],
  providers: [PurchasingService],
})
export class PurchasingModule {}
