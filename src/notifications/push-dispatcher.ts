import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../common/config/app-config.service';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { defaultLevel, shouldPush, NOTIFICATION_LEVELS, type NotificationLevel } from './notification-catalog';
import { pushCopy, type PushLocale } from './push-copy';

/** One message for one device. `data` carries ids only, so the app opens the exact record after sign-in. */
export interface PushMessage {
  deviceId: Buffer;
  token: string;
  title: string;
  body: string;
  data: { notificationId: string; type: string; link: string | null };
}

export interface PushProvider {
  /** One outcome per message, in order: delivered to the push service, or a short error code — never message text. */
  send(messages: readonly PushMessage[]): Promise<({ ok: true } | { ok: false; error: string })[]>;
}

export const PUSH_PROVIDER = 'PUSH_PROVIDER';

/** Expo's push service, which forwards to APNs for an iOS build that carries the push entitlement. */
export class ExpoPushProvider implements PushProvider {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async send(messages: readonly PushMessage[]) {
    if (messages.length === 0) return [];
    try {
      const res = await this.fetchImpl('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(messages.map((m) => ({ to: m.token, title: m.title, body: m.body, data: m.data, sound: 'default' }))),
      });
      if (!res.ok) return messages.map(() => ({ ok: false as const, error: `http_${res.status}` }));
      const json = (await res.json()) as { data?: { status: string; details?: { error?: string } }[] };
      return messages.map((_, i) => {
        const r = json.data?.[i];
        return r?.status === 'ok' ? { ok: true as const } : { ok: false as const, error: (r?.details?.error ?? 'unknown').slice(0, 64) };
      });
    } catch {
      return messages.map(() => ({ ok: false as const, error: 'network' }));
    }
  }
}

export interface PlanInput {
  notification: { id: Buffer; type: string; actionLink: string | null; actorUserId: Buffer | null };
  storeName: { name: string; nameAr: string | null } | null;
  audience: readonly { userId: Buffer; level: NotificationLevel }[];
  devices: readonly { id: Buffer; userId: Buffer; token: string; locale: string }[];
}

/**
 * Who is pushed, on which phone, in which language — pure, so the matrix is tested without a database. The audience
 * is already only the people who may see the event; the level and the self-action rule can only remove from it.
 */
export function planPushes(input: PlanInput): PushMessage[] {
  const out: PushMessage[] = [];
  const actor = input.notification.actorUserId ? binToUuid(input.notification.actorUserId) : null;
  for (const person of input.audience) {
    const recipient = binToUuid(person.userId);
    if (!shouldPush({ type: input.notification.type, level: person.level, recipientId: recipient, actorId: actor })) continue;
    for (const d of input.devices) {
      if (!d.userId.equals(person.userId)) continue;
      const locale = (['en', 'fr', 'ar'] as const).includes(d.locale as PushLocale) ? (d.locale as PushLocale) : 'fr';
      const store = input.storeName ? (locale === 'ar' && input.storeName.nameAr ? input.storeName.nameAr : input.storeName.name) : null;
      const copy = pushCopy(input.notification.type, locale, store);
      out.push({
        deviceId: d.id,
        token: d.token,
        ...copy,
        data: { notificationId: binToUuid(input.notification.id), type: input.notification.type, link: input.notification.actionLink },
      });
    }
  }
  return out;
}

const SWEEP_INTERVAL_MS = 15_000;
const LOOKBACK_MS = 30 * 60_000;

/**
 * Sends the pushes the notification centre's events call for (D225). Off by default (`PUSH_CHANNEL=disabled`): the
 * centre holds everything, and nothing leaves the server. On, it looks every 15 seconds at the last half hour's
 * notifications that have no delivery yet. Each delivery is one row, UNIQUE per notification and device, written
 * before the send — so a retried pass, a second instance or a restart never pushes twice. Its status and error code
 * are what an operator reads; no message text is stored or logged.
 */
@Injectable()
export class PushDispatcher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(PushDispatcher.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    @Inject(PUSH_PROVIDER) private readonly provider: PushProvider,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.pushChannel === 'disabled') return;
    this.timer = setInterval(() => void this.sweepNow(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  sweepNow(): Promise<number> {
    if (!this.running) {
      this.running = this.sweep()
        .catch((e: unknown) => {
          this.log.warn(`push sweep failed: ${e instanceof Error ? e.name : 'error'}`);
          return 0;
        })
        .finally(() => (this.running = null));
    }
    return this.running;
  }

  private async sweep(): Promise<number> {
    const since = new Date(Date.now() - LOOKBACK_MS);
    const pending = await this.prisma.notification.findMany({
      where: { createdAt: { gte: since }, deliveries: { none: {} } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 100,
    });
    let sent = 0;
    for (const n of pending) sent += await this.dispatch(n.id);
    return sent;
  }

  /** Plan, claim and send one notification's pushes. Returns how many were delivered to the push service. */
  async dispatch(notificationId: Buffer): Promise<number> {
    const n = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      select: { id: true, companyId: true, branchId: true, targetUserId: true, type: true, actionLink: true, actorUserId: true, branch: { select: { name: true, nameAr: true } } },
    });
    if (!n) return 0;
    // The audience is exactly who may see it in the centre: the person addressed, or the store's (or the business's) members.
    const people = await this.prisma.user.findMany({
      where: {
        companyId: n.companyId,
        isActive: true,
        deletedAt: null,
        ...(n.targetUserId ? { id: n.targetUserId } : n.branchId ? { userBranches: { some: { branchId: n.branchId } } } : {}),
      },
      select: { id: true, notificationPreference: { select: { level: true } }, userBranches: { select: { role: { select: { key: true } } } } },
    });
    const audience = people.map((p) => ({
      userId: p.id,
      level: (NOTIFICATION_LEVELS as readonly string[]).includes(p.notificationPreference?.level ?? '')
        ? (p.notificationPreference!.level as NotificationLevel)
        : defaultLevel(p.userBranches.map((ub) => ub.role.key)),
    }));
    const devices = await this.prisma.pushDevice.findMany({
      where: { companyId: n.companyId, revokedAt: null, userId: { in: people.map((p) => p.id) } },
      select: { id: true, userId: true, token: true, locale: true },
    });
    const messages = planPushes({ notification: n, storeName: n.branch, audience, devices });

    // Claim each delivery first: the UNIQUE row is what makes a retry, a second pass or a second instance a no-op.
    const claimed: PushMessage[] = [];
    for (const m of messages) {
      try {
        await this.prisma.pushDelivery.create({ data: { id: newUuidV7Bin(), companyId: n.companyId, notificationId: n.id, deviceId: m.deviceId, status: 'queued' } });
        claimed.push(m);
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        throw e;
      }
    }
    if (claimed.length === 0) return 0;
    const results = await this.provider.send(claimed);
    let delivered = 0;
    for (const [i, m] of claimed.entries()) {
      const r = results[i] ?? { ok: false as const, error: 'no_result' };
      if (r.ok) delivered++;
      await this.prisma.pushDelivery.updateMany({
        where: { notificationId: n.id, deviceId: m.deviceId },
        data: r.ok ? { status: 'sent' } : { status: 'failed', errorCode: r.error },
      });
      // A token the push service no longer knows is a phone that uninstalled or turned notifications off.
      if (!r.ok && r.error === 'DeviceNotRegistered') {
        await this.prisma.pushDevice.updateMany({ where: { id: m.deviceId, revokedAt: null }, data: { revokedAt: new Date() } });
      }
    }
    return delivered;
  }
}
