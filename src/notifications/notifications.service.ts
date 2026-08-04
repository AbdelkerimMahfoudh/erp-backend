import { Inject, Injectable } from '@nestjs/common';
import { Notification } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { NOTIFICATION_CHANNELS, NotificationChannel, NotificationInput } from './notification-channel';

/**
 * Notification infrastructure. `emit` fans a notification out across all
 * registered channels (in-app now; FCM/WhatsApp later). Read APIs are tenant-
 * scoped and limited to the caller's own + broadcast notifications.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(NOTIFICATION_CHANNELS) private readonly channels: NotificationChannel[],
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
  ) {}

  async emit(input: NotificationInput): Promise<void> {
    for (const channel of this.channels) {
      await channel.deliver(input);
    }
  }

  listForUser(userId: Buffer, onlyUnread = false): Promise<Notification[]> {
    return this.db.notification.findMany({
      where: {
        OR: [{ targetUserId: userId }, { targetUserId: null }],
        ...(onlyUnread ? { isRead: false } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async markRead(userId: Buffer, id: Buffer): Promise<{ updated: number }> {
    const result = await this.db.notification.updateMany({
      where: { id, OR: [{ targetUserId: userId }, { targetUserId: null }] },
      data: { isRead: true },
    });
    return { updated: result.count };
  }
}
