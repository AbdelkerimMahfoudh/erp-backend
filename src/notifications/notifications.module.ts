import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { InAppChannel } from './in-app.channel';
import { NOTIFICATION_CHANNELS } from './notification-channel';

@Module({
  controllers: [NotificationsController],
  providers: [
    InAppChannel,
    NotificationsService,
    // Registered delivery channels (in-app now; add FCM/WhatsApp providers here).
    { provide: NOTIFICATION_CHANNELS, inject: [InAppChannel], useFactory: (inApp: InAppChannel) => [inApp] },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
