import { ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { DeviceTrustMethod, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { HashingService } from '../common/security/hashing.service';
import { binToUuid, isUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { DeviceMetaDto } from './dto/device.dto';

/**
 * Device identity (F1 Stage 3).
 *
 * A device is recognised by a PAIR — the public id plus a secret this server
 * issued — and only the secret's Argon2id hash is ever stored. That split is
 * the whole security model:
 *
 *  - the public id alone authenticates nothing, so the device list an Owner can
 *    read is not a set of credentials;
 *  - the secret is returned exactly once and never again, so a stolen database
 *    yields nothing replayable;
 *  - a device row belongs to one (company, user), so nothing here can correlate
 *    one handset across users or companies.
 *
 * **This stage issues no OTP and marks nothing verified.** `trustMethod` says
 * plainly how trust was obtained, and `otpVerifiedAt` stays null until a real
 * code is checked in Stage 4.
 *
 * Uses the unscoped system client deliberately: device work runs during
 * authentication, before a tenant context exists. Every query therefore carries
 * `companyId`/`userId` explicitly, and every lookup is filtered by the
 * authenticated user — never by the client's word alone.
 */

/** 256 bits. Long enough that guessing is not a strategy. */
const SECRET_BYTES = 32;

/**
 * `lastSeenAt` is written at most this often per device. Without a throttle,
 * recognising a device would mean a write on every single request — turning a
 * read path into a write path for no operational benefit.
 */
const LAST_SEEN_THROTTLE_MS = 15 * 60 * 1000;

export interface DeviceView {
  id: string;
  label: string | null;
  platform: string | null;
  model: string | null;
  appVersion: string | null;
  /** `legacy` | `password` | `otp` — never a claim that OTP happened when it did not. */
  trustMethod: DeviceTrustMethod;
  otpVerified: boolean;
  reverifyRequired: boolean;
  firstSeenAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  /** True for the device making this request. */
  isCurrent: boolean;
}

/** Returned once, at enrollment. The secret never appears in any other response. */
export interface DeviceEnrollment {
  deviceId: string;
  deviceSecret: string;
  trustMethod: DeviceTrustMethod;
}

/** Exactly the columns a device response may contain — no `secretHash`. */
const DEVICE_SELECT = {
  id: true,
  label: true,
  platform: true,
  model: true,
  appVersion: true,
  trustMethod: true,
  otpVerifiedAt: true,
  reverifyRequired: true,
  firstSeenAt: true,
  lastSeenAt: true,
  revokedAt: true,
} satisfies Prisma.UserDeviceSelect;

type DeviceRow = Prisma.UserDeviceGetPayload<{ select: typeof DEVICE_SELECT }>;

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
  ) {}

  // ------------------------------------------------------------- enrollment

  /**
   * Create a device and bind a session to it, returning the secret **once**.
   *
   * `trustMethod` is chosen by the server, never by the caller:
   * `password` when a password was just verified (login), `legacy` when an
   * already-valid pre-Stage-3 session adopts a device.
   */
  async enroll(params: {
    companyId: Buffer;
    userId: Buffer;
    sessionId: Buffer;
    trustMethod: 'password' | 'legacy';
    meta?: DeviceMetaDto;
  }): Promise<DeviceEnrollment> {
    const secret = randomBytes(SECRET_BYTES).toString('base64url');
    const id = newUuidV7Bin();

    await this.prisma.$transaction(async (tx) => {
      await tx.userDevice.create({
        data: {
          id,
          companyId: params.companyId,
          userId: params.userId,
          secretHash: await this.hashing.hash(secret),
          trustMethod: params.trustMethod as DeviceTrustMethod,
          ...this.meta(params.meta),
        },
      });
      // Bind the session in the same transaction: a device nothing points at is
      // an orphan, and a session pointing at a half-created device is worse.
      await tx.authSession.update({
        where: { id: params.sessionId },
        data: { deviceRecordId: id },
      });
    });

    return { deviceId: binToUuid(id), deviceSecret: secret, trustMethod: params.trustMethod as DeviceTrustMethod };
  }

  /**
   * Recognise a device from the pair it presents, for THIS user.
   *
   * Returns the row only when the id resolves, the secret verifies, the device
   * belongs to this user, and it is not revoked. Every failure looks the same
   * from outside — a caller cannot use this to discover whether a device id
   * exists, or belongs to someone else.
   */
  async recognise(
    userId: Buffer,
    deviceIdStr: string,
    secret: string,
  ): Promise<{ id: Buffer; reverifyRequired: boolean } | null> {
    if (!isUuid(deviceIdStr) || !secret) return null;

    const device = await this.prisma.userDevice.findUnique({
      where: { id: uuidToBin(deviceIdStr) },
      select: { id: true, userId: true, secretHash: true, revokedAt: true, reverifyRequired: true },
    });
    // A revoked device must never quietly become trusted again by presenting
    // its old credential — that is the point of keeping the row.
    if (!device || device.revokedAt || !device.userId.equals(userId)) return null;
    if (!(await this.hashing.verify(device.secretHash, secret))) return null;

    return { id: device.id, reverifyRequired: device.reverifyRequired };
  }

  /** Bind a session to an already-recognised device, and touch `lastSeenAt`. */
  async attach(sessionId: Buffer, deviceId: Buffer): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.authSession.update({ where: { id: sessionId }, data: { deviceRecordId: deviceId } }),
      ...this.touchOps(deviceId),
    ]);
  }

  /**
   * Adopt a device for a session that predates Stage 3.
   *
   * Idempotent and single-shot: a session that already has a device returns it
   * unchanged rather than minting a second one, so a retry — or two app
   * launches racing — cannot produce duplicates or rebind the session.
   */
  async adoptLegacy(
    companyId: Buffer,
    userId: Buffer,
    sessionId: Buffer,
    meta?: DeviceMetaDto,
  ): Promise<DeviceEnrollment | { alreadyBound: true; deviceId: string }> {
    const session = await this.prisma.authSession.findUnique({
      where: { id: sessionId },
      select: { userId: true, deviceRecordId: true },
    });
    if (!session || !session.userId.equals(userId)) {
      throw new UnauthorizedException();
    }
    if (session.deviceRecordId) {
      // Already adopted. Returning the id (never a secret) keeps this safe to
      // call repeatedly and impossible to use for rebinding.
      return { alreadyBound: true, deviceId: binToUuid(session.deviceRecordId) };
    }
    return this.enroll({ companyId, userId, sessionId, trustMethod: 'legacy', meta });
  }

  // ------------------------------------------------------------------ reads

  /** The user's devices, newest first. Revoked ones are kept as history. */
  async listForUser(userId: Buffer, currentDeviceId: Buffer | null): Promise<DeviceView[]> {
    const rows = await this.prisma.userDevice.findMany({
      where: { userId },
      orderBy: [{ revokedAt: 'asc' }, { firstSeenAt: 'desc' }],
      select: DEVICE_SELECT,
    });
    return rows.map((r) => this.toView(r, currentDeviceId));
  }

  /**
   * An Owner reading an employee's devices. The company check is the tenant
   * boundary — this path does not use the tenant-scoped client, so it is
   * enforced here explicitly rather than assumed.
   */
  async listForCompanyUser(
    companyId: Buffer,
    targetUserIdStr: string,
    currentDeviceId: Buffer | null,
  ): Promise<DeviceView[]> {
    const target = await this.requireCompanyUser(companyId, targetUserIdStr);
    return this.listForUser(target, currentDeviceId);
  }

  // --------------------------------------------------------------- revoking

  /**
   * Revoke a device and every session it owns, atomically.
   *
   * Revocation outlives a later reactivation of the user: the device row stays
   * revoked and its sessions stay revoked, so re-enabling an account does not
   * quietly restore a phone somebody lost.
   *
   * Idempotent — revoking an already-revoked device is a no-op that still
   * reports success, because the caller's intent is already true.
   */
  async revoke(params: {
    companyId: Buffer;
    ownerUserId: Buffer;
    targetUserId: Buffer;
    deviceIdStr: string;
  }): Promise<{ deviceId: string; sessionsRevoked: number; wasCurrent: boolean; alreadyRevoked: boolean }> {
    if (!isUuid(params.deviceIdStr)) throw new NotFoundException('Device not found');
    const deviceId = uuidToBin(params.deviceIdStr);

    const device = await this.prisma.userDevice.findUnique({
      where: { id: deviceId },
      select: { id: true, userId: true, companyId: true, revokedAt: true },
    });
    // Cross-company or cross-user is "not found", never "forbidden": a 403 here
    // would confirm the device exists somewhere.
    if (!device || !device.companyId.equals(params.companyId) || !device.userId.equals(params.targetUserId)) {
      throw new NotFoundException('Device not found');
    }

    if (device.revokedAt) {
      return { deviceId: params.deviceIdStr, sessionsRevoked: 0, wasCurrent: false, alreadyRevoked: true };
    }

    const now = new Date();
    const [, sessions] = await this.prisma.$transaction([
      this.prisma.userDevice.update({
        where: { id: deviceId },
        data: { revokedAt: now, revokedById: params.ownerUserId },
      }),
      this.prisma.authSession.updateMany({
        where: { deviceRecordId: deviceId, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);

    return {
      deviceId: params.deviceIdStr,
      sessionsRevoked: sessions.count,
      wasCurrent: false,
      alreadyRevoked: false,
    };
  }

  /**
   * An explicit logout means the next sign-in on this device should re-verify
   * by OTP, even though it is the same hardware. Stage 3 records the
   * requirement; Stage 4 enforces it. Closing the app, backgrounding it or
   * losing the network do none of this — they never reach here.
   */
  async markReverifyRequired(deviceId: Buffer): Promise<void> {
    await this.prisma.userDevice.updateMany({
      where: { id: deviceId },
      data: { reverifyRequired: true },
    });
  }

  // -------------------------------------------------------------- internals

  private async requireCompanyUser(companyId: Buffer, userIdStr: string): Promise<Buffer> {
    if (!isUuid(userIdStr)) throw new NotFoundException('User not found');
    const userId = uuidToBin(userIdStr);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { companyId: true, deletedAt: true },
    });
    if (!user || user.deletedAt || !user.companyId.equals(companyId)) {
      throw new NotFoundException('User not found');
    }
    return userId;
  }

  /** Throttled: at most one write per device per {@link LAST_SEEN_THROTTLE_MS}. */
  private touchOps(deviceId: Buffer): Prisma.PrismaPromise<unknown>[] {
    const cutoff = new Date(Date.now() - LAST_SEEN_THROTTLE_MS);
    return [
      this.prisma.userDevice.updateMany({
        where: { id: deviceId, OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: cutoff } }] },
        data: { lastSeenAt: new Date() },
      }),
    ];
  }

  /** Client-supplied strings, stored for display only and length-capped. */
  private meta(meta?: DeviceMetaDto) {
    return {
      label: meta?.label?.slice(0, 120) ?? null,
      platform: meta?.platform?.slice(0, 40) ?? null,
      model: meta?.model?.slice(0, 120) ?? null,
      appVersion: meta?.appVersion?.slice(0, 40) ?? null,
    };
  }

  private toView(row: DeviceRow, currentDeviceId: Buffer | null): DeviceView {
    return {
      id: binToUuid(row.id),
      label: row.label,
      platform: row.platform,
      model: row.model,
      appVersion: row.appVersion,
      trustMethod: row.trustMethod,
      // Derived, so no caller can mistake "we have a timestamp column" for
      // "this phone was verified".
      otpVerified: row.otpVerifiedAt !== null,
      reverifyRequired: row.reverifyRequired,
      firstSeenAt: row.firstSeenAt.toISOString(),
      lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      isCurrent: currentDeviceId !== null && row.id.equals(currentDeviceId),
    };
  }

  /** Guard for Owner-side reads/revokes; keeps the 404-not-403 rule in one place. */
  async resolveCompanyUser(companyId: Buffer, userIdStr: string): Promise<Buffer> {
    return this.requireCompanyUser(companyId, userIdStr);
  }

  /** Never used to authorize — only to refuse a self-revoke mismatch clearly. */
  assertSameUser(a: Buffer, b: Buffer): void {
    if (!a.equals(b)) throw new ForbiddenException('That device belongs to another user');
  }
}
