import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';

export type PushPlatform = 'ios' | 'android';
export type PushLocale = 'en' | 'fr' | 'ar';

/**
 * The phones a person receives push on (D225, 0113).
 *
 * A push token names one installation of the app on one phone, whoever is signed in on it — so it is unique across
 * every business, and read here with the system client rather than the tenant one. A counter phone that one person
 * signs out of and another signs in to, possibly in another business, moves to the newcomer: the previous person stops
 * receiving on it at once, and a scoped lookup that could not see the old row would have collided with it instead.
 *
 * Registering is idempotent: the app registers after every sign-in, launch and language change, and the same token
 * is one row whose owner, language and last-seen time follow the latest call. A token the provider reports dead is
 * revoked by the dispatcher; a rotated token arrives as a new registration and the old one is revoked by the app.
 */
@Injectable()
export class PushDevicesService {
  constructor(private readonly prisma: PrismaService) {}

  async register(userId: Buffer, companyId: Buffer, input: { token: string; platform: PushPlatform; locale: PushLocale; replaces?: string }) {
    const data = { userId, companyId, platform: input.platform, locale: input.locale, lastSeenAt: new Date(), revokedAt: null };
    let id: Buffer;
    const existing = await this.prisma.pushDevice.findUnique({ where: { token: input.token }, select: { id: true } });
    if (existing) {
      await this.prisma.pushDevice.update({ where: { id: existing.id }, data });
      id = existing.id;
    } else {
      id = newUuidV7Bin();
      try {
        await this.prisma.pushDevice.create({ data: { id, token: input.token, ...data } });
      } catch (e) {
        // Two registrations of a new token at once (a launch and a sign-in): the second becomes the update it is.
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        const row = await this.prisma.pushDevice.update({ where: { token: input.token }, data, select: { id: true } });
        id = row.id;
      }
    }
    // The token this phone had before the provider rotated it: only the same person's, and only if it is a different one.
    if (input.replaces && input.replaces !== input.token) await this.revoke(userId, input.replaces);
    return { deviceId: binToUuid(id) };
  }

  /** Signed out, notifications turned off on this phone, or a rotated token: nothing more is pushed to it. */
  async revoke(userId: Buffer, token: string) {
    const { count } = await this.prisma.pushDevice.updateMany({ where: { token, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    return { revoked: count };
  }
}
