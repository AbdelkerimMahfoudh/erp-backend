import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { InAppChannel } from './in-app.channel';
import { NOTIFICATION_CHANNELS } from './notification-channel';
import { PushDevicesService } from './push-devices.service';
import { ExpoPushProvider, PUSH_PROVIDER, PushDispatcher } from './push-dispatcher';

@Module({
  controllers: [NotificationsController],
  providers: [
    InAppChannel,
    NotificationsService,
    PushDevicesService,
    // Registered delivery channels (in-app now; add FCM/WhatsApp providers here).
    { provide: NOTIFICATION_CHANNELS, inject: [InAppChannel], useFactory: (inApp: InAppChannel) => [inApp] },
    // D225: push, off unless PUSH_CHANNEL=expo.
    { provide: PUSH_PROVIDER, useFactory: () => new ExpoPushProvider() },
    PushDispatcher,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
