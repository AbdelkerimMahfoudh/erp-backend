import { Inject, Injectable } from '@nestjs/common';
import { Notification } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { binToUuid } from '../common/utils/uuid.util';
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

  /**
   * The caller's own notifications plus company broadcasts, newest first.
   *
   * Keyset-paginated on the UUIDv7 primary key, the same as the catalog and
   * price history. The previous fixed `take: 100` was bounded but had no way to
   * reach anything older, so a busy shop's Owner would simply stop seeing the
   * beginning of their own history.
   */
  async listForUser(
    userId: Buffer,
    opts: { onlyUnread?: boolean; cursor?: Buffer; limit?: number } = {},
  ): Promise<{ rows: Notification[]; nextCursor: string | null; unreadCount: number }> {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 50);
    const scope = { OR: [{ targetUserId: userId }, { targetUserId: null }] };

    const rows = await this.db.notification.findMany({
      where: { ...scope, ...(opts.onlyUnread ? { isRead: false } : {}) },
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      orderBy: { id: 'desc' },
      take: limit + 1,
    });

    const page = rows.slice(0, limit);
    return {
      rows: page,
      nextCursor: rows.length > limit ? binToUuid(page[page.length - 1]!.id) : null,
      // Drives the tab badge without a second round trip.
      unreadCount: await this.db.notification.count({ where: { ...scope, isRead: false } }),
    };
  }

  async markRead(userId: Buffer, id: Buffer): Promise<{ updated: number }> {
    const result = await this.db.notification.updateMany({
      where: { id, OR: [{ targetUserId: userId }, { targetUserId: null }] },
      data: { isRead: true },
    });
    return { updated: result.count };
  }
}
