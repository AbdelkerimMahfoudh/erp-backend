import { Injectable } from '@nestjs/common';
import { OtpPurpose, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { binToUuid, newUuidV7Bin } from '../../common/utils/uuid.util';
import { generateIntentToken, hashIntentToken } from './otp-code.util';

/**
 * Pre-authentication verification intent (F1 Stage 4A).
 *
 * The problem it solves: a correct password from an unrecognised device must
 * lead *somewhere* without handing out an access token first. An access token
 * is authority; "your password was right, now prove the device" is not.
 *
 * So a successful password check on an unknown device will (in Stage 4B) mint
 * one of these instead — a short-lived, opaque, single-use ticket bound to one
 * company, user, purpose and candidate device. It authorises exactly one thing:
 * continuing that verification.
 *
 * **Stage 4A builds and tests it; nothing issues one in production yet.** The
 * login flow still returns `device_unrecognized` and blocks, unchanged.
 */

/** Short by design: it exists only to bridge one interactive flow. */
const DEFAULT_TTL_SECONDS = 10 * 60;

export interface IssuedIntent {
  /** The raw token. Returned once, never stored, never logged. */
  token: string;
  intentId: string;
  expiresAt: string;
}

export type IntentResolution =
  | {
      ok: true;
      intentId: Buffer;
      companyId: Buffer;
      userId: Buffer;
      purpose: OtpPurpose;
      deviceId: Buffer | null;
      /** The challenge this intent is bound to, when one was recorded. */
      challengeId: Buffer | null;
    }
  | { ok: false; reason: 'not_found' | 'expired' | 'consumed' | 'mismatch' };

@Injectable()
export class VerificationIntentService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Mint an intent. The raw token is returned to the caller exactly once; only
   * its SHA-256 is stored, so the table is inert if it leaks.
   */
  async issue(params: {
    companyId: Buffer;
    userId: Buffer;
    purpose: OtpPurpose;
    deviceId?: Buffer | null;
    challengeId?: Buffer | null;
    ttlSeconds?: number;
  }): Promise<IssuedIntent> {
    const token = generateIntentToken();
    const id = newUuidV7Bin();
    const expiresAt = new Date(Date.now() + (params.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000);

    await this.prisma.verificationIntent.create({
      data: {
        id,
        companyId: params.companyId,
        userId: params.userId,
        purpose: params.purpose,
        deviceId: params.deviceId ?? null,
        challengeId: params.challengeId ?? null,
        tokenHash: hashIntentToken(token),
        expiresAt,
      },
    });

    return { token, intentId: binToUuid(id), expiresAt: expiresAt.toISOString() };
  }

  /**
   * Look an intent up by its raw token, without consuming it.
   *
   * Every mismatch — wrong company, wrong user, wrong device, wrong purpose —
   * collapses into one `mismatch` reason so a caller cannot use this to probe
   * which part was wrong.
   */
  async resolve(
    token: string,
    expect: {
      companyId?: Buffer;
      userId?: Buffer;
      purpose?: OtpPurpose;
      deviceId?: Buffer | null;
    } = {},
  ): Promise<IntentResolution> {
    if (!token) return { ok: false, reason: 'not_found' };

    const intent = await this.prisma.verificationIntent.findUnique({
      where: { tokenHash: hashIntentToken(token) },
    });
    if (!intent) return { ok: false, reason: 'not_found' };
    if (intent.consumedAt) return { ok: false, reason: 'consumed' };
    if (intent.expiresAt <= new Date()) return { ok: false, reason: 'expired' };

    if (expect.companyId && !intent.companyId.equals(expect.companyId)) {
      return { ok: false, reason: 'mismatch' };
    }
    if (expect.userId && !intent.userId.equals(expect.userId)) {
      return { ok: false, reason: 'mismatch' };
    }
    if (expect.purpose && intent.purpose !== expect.purpose) {
      return { ok: false, reason: 'mismatch' };
    }
    if (expect.deviceId !== undefined) {
      const same =
        (expect.deviceId === null && intent.deviceId === null) ||
        (expect.deviceId !== null && intent.deviceId !== null && intent.deviceId.equals(expect.deviceId));
      if (!same) return { ok: false, reason: 'mismatch' };
    }

    return {
      ok: true,
      intentId: intent.id,
      companyId: intent.companyId,
      userId: intent.userId,
      purpose: intent.purpose,
      deviceId: intent.deviceId,
      challengeId: intent.challengeId,
    };
  }

  /**
   * Consume an intent **atomically with the action it authorises**.
   *
   * The conditional `updateMany` on `consumedAt: null` is what makes it
   * single-use: two concurrent callers race, one gets `count === 1`, the other
   * gets zero and is refused. Running the caller's work inside the same
   * transaction means a crash cannot leave an intent spent with nothing done,
   * or an action done with the intent still spendable.
   */
  async consume<T>(
    intentId: Buffer,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<{ ok: true; result: T } | { ok: false; reason: 'consumed' }> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.verificationIntent.updateMany({
        where: { id: intentId, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      if (count === 0) return { ok: false as const, reason: 'consumed' as const };
      return { ok: true as const, result: await work(tx) };
    });
  }

  /** Housekeeping. Expired intents are worthless; keeping them is only noise. */
  async purgeExpired(before: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.verificationIntent.deleteMany({
      where: { expiresAt: { lt: before } },
    });
    return count;
  }
}
