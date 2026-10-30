import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Notification } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { NOTIFICATION_LEVELS, classify, defaultLevel, typesIn, type NotificationLevel } from './notification-catalog';

/** The centre's filters (D225). */
export type NotificationFilter = 'all' | 'approvals' | 'sales' | 'stock' | 'money';
export const NOTIFICATION_FILTERS: readonly NotificationFilter[] = ['all', 'approvals', 'sales', 'stock', 'money'];
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
    opts: { onlyUnread?: boolean; cursor?: Buffer; limit?: number; filter?: NotificationFilter } = {},
  ): Promise<{ rows: (Notification & { category: string })[]; nextCursor: string | null; unreadCount: number }> {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 50);
    const scope = await this.visibleTo(userId);
    const unread = this.unreadBy(userId);
    // D225: the centre's filters — the catalogue's types for each; All is everything the person may see.
    const filter = opts.filter && opts.filter !== 'all' ? { type: { in: typesIn(opts.filter) } } : {};

    const rows = await this.db.notification.findMany({
      where: { AND: [scope, filter, ...(opts.onlyUnread ? [unread] : [])] },
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      orderBy: { id: 'desc' },
      take: limit + 1,
      include: { reads: { where: { userId }, select: { readAt: true } } },
    });

    const page = rows.slice(0, limit).map(({ reads, ...row }) => ({
      ...row,
      // Read by THIS person — per person, on every device (0113). A row marked read before 0113 stays read.
      isRead: reads.length > 0 || (row.targetUserId !== null && row.isRead),
      category: classify(row.type).category,
    }));
    return {
      rows: page,
      nextCursor: rows.length > limit ? binToUuid(page[page.length - 1]!.id) : null,
      // Drives the tab badge without a second round trip.
      unreadCount: await this.db.notification.count({ where: { AND: [scope, unread] } }),
    };
  }

  /** Not yet read by this person: no read mark of theirs, and not a row of theirs already marked before 0113. */
  private unreadBy(userId: Buffer) {
    return { reads: { none: { userId } }, OR: [{ targetUserId: null }, { isRead: false }] };
  }

  /**
   * What one user may see: their own notifications, and broadcasts that name no
   * branch or a branch they are assigned to.
   *
   * A broadcast row carries the branch it is about, but the list used to ignore
   * it, so every user of every branch read another branch's sales (invoice and
   * total), closings and staff shortages (docs/25 §10 recorded the defect; docs/03
   * §2: a manager cannot see other branches' data).
   */
  private async visibleTo(userId: Buffer) {
    const assigned = await this.db.userBranch.findMany({ where: { userId }, select: { branchId: true } });
    return {
      OR: [
        { targetUserId: userId },
        { targetUserId: null, OR: [{ branchId: null }, { branchId: { in: assigned.map((a) => a.branchId) } }] },
      ],
    };
  }

  /** One notification, if this person may see it. */
  visibleOne(userId: Buffer, id: Buffer) {
    return this.visibleTo(userId).then((scope) =>
      this.db.notification.findFirst({ where: { id, ...scope }, select: { id: true, actionLink: true, branchId: true, type: true } }),
    );
  }

  /**
   * Read, by this person only (0113): a broadcast read by one member of the store stays unread for the others. The
   * mark follows the person to every device. Only a notification they may see can be marked.
   */
  async markRead(userId: Buffer, id: Buffer): Promise<{ updated: number }> {
    const visible = await this.db.notification.findFirst({ where: { id, ...(await this.visibleTo(userId)) }, select: { id: true, companyId: true } });
    if (!visible) return { updated: 0 };
    await this.db.notificationRead.upsert({
      where: { notificationId_userId: { notificationId: id, userId } },
      create: { notificationId: id, userId, companyId: visible.companyId },
      update: {},
    });
    return { updated: 1 };
  }

  /** Every notification this person may see, read — "Mark all as read". */
  async markAllRead(userId: Buffer): Promise<{ updated: number }> {
    const rows = await this.db.notification.findMany({
      where: { AND: [await this.visibleTo(userId), this.unreadBy(userId)] },
      select: { id: true, companyId: true },
      take: 500,
    });
    if (rows.length === 0) return { updated: 0 };
    await this.db.notificationRead.createMany({
      data: rows.map((r) => ({ notificationId: r.id, userId, companyId: r.companyId })),
      skipDuplicates: true,
    });
    return { updated: rows.length };
  }

  /** The person's push level, or the default for their role (D225). */
  async preferenceOf(userId: Buffer): Promise<{ level: NotificationLevel; isDefault: boolean; levels: readonly NotificationLevel[] }> {
    const row = await this.db.notificationPreference.findUnique({ where: { userId } });
    if (row && (NOTIFICATION_LEVELS as readonly string[]).includes(row.level)) {
      return { level: row.level as NotificationLevel, isDefault: false, levels: NOTIFICATION_LEVELS };
    }
    const roles = await this.db.userBranch.findMany({ where: { userId }, select: { role: { select: { key: true } } } });
    return { level: defaultLevel(roles.map((r) => r.role.key)), isDefault: true, levels: NOTIFICATION_LEVELS };
  }

  /** Changes how much is PUSHED, never what may be seen: the centre and every permission are unchanged. */
  async setPreference(userId: Buffer, level: NotificationLevel) {
    const companyId = await this.companyOf(userId);
    await this.db.notificationPreference.upsert({
      where: { userId },
      create: { userId, level, companyId },
      update: { level },
    });
    return this.preferenceOf(userId);
  }

  /** The person's own business: every row written for them carries it, whichever client writes it. */
  private async companyOf(userId: Buffer): Promise<Buffer> {
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { companyId: true } });
    if (!user) throw new NotFoundException('User not found');
    return user.companyId;
  }
}
