import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HashingService } from '../common/security/hashing.service';
import { AppConfigService } from '../common/config/app-config.service';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { DeviceDto } from './dto/device.dto';

interface CreateSessionParams {
  companyId: Buffer;
  userId: Buffer;
  secret: string;
  device?: DeviceDto;
  ip?: string;
  userAgent?: string;
}

/**
 * Persists refresh-token sessions (`auth_sessions`). Uses the unscoped system
 * client because auth runs before a tenant context exists; `company_id` is set
 * explicitly from the authenticated user.
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly config: AppConfigService,
  ) {}

  /** Create a session storing the Argon2 hash of the refresh secret. Returns its id. */
  async create(params: CreateSessionParams): Promise<Buffer> {
    const id = newUuidV7Bin();
    const refreshTokenHash = await this.hashing.hash(params.secret);
    const expiresAt = new Date(Date.now() + this.config.jwtRefreshTtlDays * 86_400_000);

    await this.prisma.authSession.create({
      data: {
        id,
        companyId: params.companyId,
        userId: params.userId,
        refreshTokenHash,
        expiresAt,
        lastUsedAt: new Date(),
        deviceId: params.device?.deviceId ?? null,
        deviceName: params.device?.deviceName ?? null,
        platform: params.device?.platform ?? null,
        appVersion: params.device?.appVersion ?? null,
        ip: params.ip ?? null,
        userAgent: params.userAgent?.slice(0, 255) ?? null,
      },
    });
    return id;
  }

  /**
   * Validate + rotate a session. Returns the owner on success (with the session
   * re-hashed to `newSecret`); returns null on any failure. A secret mismatch on
   * an otherwise-valid session is treated as reuse and revokes the session.
   */
  async rotate(
    sessionId: Buffer,
    presentedSecret: string,
    newSecret: string,
  ): Promise<{ userId: Buffer; companyId: Buffer } | null> {
    const session = await this.prisma.authSession.findUnique({ where: { id: sessionId } });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      return null;
    }

    const valid = await this.hashing.verify(session.refreshTokenHash, presentedSecret);
    if (!valid) {
      await this.prisma.authSession.update({
        where: { id: sessionId },
        data: { revokedAt: new Date() },
      });
      return null;
    }

    await this.prisma.authSession.update({
      where: { id: sessionId },
      data: { refreshTokenHash: await this.hashing.hash(newSecret), lastUsedAt: new Date() },
    });
    return { userId: session.userId, companyId: session.companyId };
  }

  /**
   * True if this session still backs a valid access token: it exists, is not
   * revoked or expired, belongs to `userIdStr`, and its user is active and not
   * soft-deleted. Access tokens are bound to a session (`sid`) and revalidated on
   * every request, so revoking the session — which deactivation does atomically —
   * cuts off the access token at once and keeps it dead after any reactivation
   * (the revoked session never returns; the user must log in again).
   */
  async isAccessValid(sessionId: Buffer, userIdStr: string): Promise<boolean> {
    const session = await this.prisma.authSession.findUnique({
      where: { id: sessionId },
      include: { user: { select: { isActive: true, deletedAt: true } } },
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      return false;
    }
    if (binToUuid(session.userId) !== userIdStr) {
      return false;
    }
    return session.user.isActive && session.user.deletedAt === null;
  }

  /**
   * The device a session belongs to, or null for a pre-Stage-3 session that has
   * not adopted one. Filtered by `userId` so one user cannot read another's
   * session-to-device mapping.
   */
  async deviceOf(sessionId: Buffer, userId: Buffer): Promise<Buffer | null> {
    const session = await this.prisma.authSession.findUnique({
      where: { id: sessionId },
      select: { userId: true, deviceRecordId: true },
    });
    if (!session || !session.userId.equals(userId)) return null;
    return session.deviceRecordId;
  }

  async revoke(userId: Buffer, sessionId: Buffer): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAll(userId: Buffer): Promise<number> {
    const result = await this.prisma.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }
}
