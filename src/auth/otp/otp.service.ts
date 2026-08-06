import { Inject, Injectable, Logger } from '@nestjs/common';
import { OtpDeliveryState, OtpPurpose, OtpStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfigService } from '../../common/config/app-config.service';
import { AuditService } from '../../common/audit/audit.service';
import { binToUuid, newUuidV7Bin } from '../../common/utils/uuid.util';
import {
  WHATSAPP_CHANNEL,
  WhatsAppChannel,
  DeliveryResult,
  DeliveryFailureReason,
} from '../../messaging/whatsapp-channel';
import { AUTH_OTP_TEMPLATE, validateTemplateVariables, assertLanguageSupported } from '../../messaging/templates';
import {
  codeMatches,
  generateOtpCode,
  hashOtpCode,
  isWellFormedCode,
  maskPhone,
} from './otp-code.util';

/**
 * The OTP challenge lifecycle (F1 Stage 4A).
 *
 * This is infrastructure: nothing in the production login flow calls it yet, and
 * `device_unrecognized` still blocks unchanged. It exists so Stage 4B is an
 * integration rather than a redesign.
 *
 * Three rules shape the code:
 *
 * 1. **Never claim a send that did not happen.** Delivery is attempted
 *    synchronously and its real outcome is recorded. With no provider
 *    configured the honest answer is `channel_unavailable`, and the caller is
 *    told so — a challenge marked "sent" that nobody received is the failure
 *    mode that makes an OTP system untrustworthy.
 * 2. **The code never leaves this method.** It is generated, hashed, handed to
 *    the channel, and dropped. It is never returned, logged, audited or
 *    persisted in plaintext.
 * 3. **State transitions are conditional UPDATEs, not read-then-write.** Two
 *    concurrent verifications of the same correct code must produce exactly one
 *    success, and that is decided by the database, not by a JavaScript lock.
 */

/** What a caller learns. Deliberately never includes the code. */
export interface ChallengeView {
  challengeId: string;
  purpose: OtpPurpose;
  status: OtpStatus;
  destinationMasked: string;
  expiresAt: string;
  attemptsRemaining: number;
  resendAvailableAt: string | null;
  delivery: OtpDeliveryState;
  /** True only when a channel actually accepted the message. */
  delivered: boolean;
}

export type RequestOutcome =
  | { ok: true; challenge: ChallengeView }
  | { ok: false; reason: 'otp_disabled' | 'rate_limited' | 'no_destination'; detail: string };

export type VerifyOutcome =
  | { ok: true; challengeId: string; purpose: OtpPurpose; deviceId: string | null }
  | {
      ok: false;
      reason: 'invalid_code' | 'not_found' | 'expired' | 'locked' | 'already_used' | 'cancelled';
      attemptsRemaining: number;
    };

/** Counters for operational visibility. No identifiers, no secrets. */
export interface OtpMetrics {
  requested: number;
  delivered: number;
  deliveryFailed: number;
  verified: number;
  verifyFailed: number;
  locked: number;
  expired: number;
  rateLimited: number;
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  /** Process-local counters; the project has no metrics backend yet. */
  private readonly counters: OtpMetrics = {
    requested: 0,
    delivered: 0,
    deliveryFailed: 0,
    verified: 0,
    verifyFailed: 0,
    locked: 0,
    expired: 0,
    rateLimited: 0,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    @Inject(WHATSAPP_CHANNEL) private readonly channel: WhatsAppChannel,
  ) {}

  get metrics(): Readonly<OtpMetrics> {
    return { ...this.counters };
  }

  /** OTP cannot operate without a pepper. Absent means "off", never "insecure". */
  get isEnabled(): boolean {
    return this.config.otpPepper !== null;
  }

  // ------------------------------------------------------------- requesting

  /**
   * Create a challenge, deliver it, and record what actually happened.
   *
   * The destination is taken from server-controlled data by the caller —
   * `destination` here is never a client-supplied phone number for an
   * authentication purpose. `candidatePhone` is the one exception, and it is
   * bound to the challenge so verification can check it has not moved.
   */
  async request(params: {
    companyId: Buffer;
    userId: Buffer;
    purpose: OtpPurpose;
    destination: string;
    deviceId?: Buffer | null;
    candidatePhone?: string | null;
    language?: 'en' | 'ar';
    idempotencyKey?: string | null;
  }): Promise<RequestOutcome> {
    const pepper = this.config.otpPepper;
    if (!pepper) {
      return {
        ok: false,
        reason: 'otp_disabled',
        detail: 'OTP is not configured for this deployment (no pepper set)',
      };
    }
    if (!params.destination) {
      return { ok: false, reason: 'no_destination', detail: 'This account has no phone number' };
    }

    // A retried request must reuse its challenge rather than send a second code.
    if (params.idempotencyKey) {
      const existing = await this.prisma.otpChallenge.findFirst({
        where: { companyId: params.companyId, idempotencyKey: params.idempotencyKey },
      });
      if (existing) return { ok: true, challenge: this.toView(existing) };
    }

    const limit = await this.checkSendLimits(params.userId, params.destination);
    if (limit) {
      this.counters.rateLimited++;
      return limit;
    }

    const now = new Date();
    const id = newUuidV7Bin();
    const idStr = binToUuid(id);
    const code = generateOtpCode();
    const activeKey = this.activeKeyFor(params.userId, params.purpose, params.deviceId ?? null);

    // Supersede any live challenge for the same (user, purpose, device) BEFORE
    // inserting, in one transaction: the UNIQUE index on `active_key` is what
    // makes two concurrent requests safe, and the loser retries rather than
    // creating a second live code.
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.otpChallenge.updateMany({
        where: { activeKey, status: OtpStatus.pending },
        data: { status: OtpStatus.cancelled, cancelledAt: now, activeKey: null },
      });
      return tx.otpChallenge.create({
        data: {
          id,
          companyId: params.companyId,
          userId: params.userId,
          purpose: params.purpose,
          deviceId: params.deviceId ?? null,
          destination: params.destination,
          candidatePhone: params.candidatePhone ?? null,
          codeHash: hashOtpCode(code, idStr, pepper),
          activeKey,
          expiresAt: new Date(now.getTime() + this.config.otpTtlSeconds * 1000),
          maxAttempts: this.config.otpMaxAttempts,
          idempotencyKey: params.idempotencyKey ?? null,
        },
      });
    });

    this.counters.requested++;
    await this.auditSafely('create', created.id, params.companyId, {
      purpose: params.purpose,
      destination: maskPhone(params.destination),
    }, 'OTP challenge requested');

    const delivered = await this.deliver(created.id, code, params.destination, params.language ?? 'en');
    const fresh = await this.prisma.otpChallenge.findUnique({ where: { id: created.id } });
    return { ok: true, challenge: this.toView(fresh!) };
  }

  /**
   * Hand the code to the channel and record the true outcome.
   *
   * The code is a parameter and a local; it is never written anywhere but the
   * delivery call. Delivery is synchronous on purpose — queueing it would mean
   * persisting a deliverable secret in an outbox, which is exactly the trade
   * this design refuses (see docs/23).
   */
  private async deliver(
    challengeId: Buffer,
    code: string,
    destination: string,
    language: 'en' | 'ar',
  ): Promise<boolean> {
    assertLanguageSupported(AUTH_OTP_TEMPLATE, language);
    const variables = validateTemplateVariables(AUTH_OTP_TEMPLATE, {
      code,
      ttlMinutes: String(Math.round(this.config.otpTtlSeconds / 60)),
    });

    let result: DeliveryResult;
    try {
      result = await this.channel.send({
        to: destination,
        template: AUTH_OTP_TEMPLATE.key,
        language,
        variables,
        idempotencyKey: binToUuid(challengeId),
      });
    } catch (e) {
      // An adapter that throws must not leak its exception upward — the message
      // could contain a payload. Classify and move on.
      result = {
        status: 'failed',
        reason: 'temporary',
        detail: 'Channel raised an unexpected error',
        provider: this.channel.name,
      };
      this.logger.warn(`OTP delivery threw for challenge ${binToUuid(challengeId)}`);
      void e;
    }

    const now = new Date();
    // Narrow the union once, so the outcome columns cannot disagree with the
    // state: an "accepted" row always has a provider id and no detail, and a
    // failed one always has a reason and no id.
    const outcome =
      result.status === 'accepted'
        ? {
            deliveryState: OtpDeliveryState.accepted,
            providerMessageId: result.providerMessageId,
            deliveryDetail: null,
            reason: null,
          }
        : {
            deliveryState: this.mapFailure(result.reason),
            providerMessageId: null,
            deliveryDetail: result.detail.slice(0, 200),
            reason: result.reason,
          };
    const accepted = outcome.reason === null;

    await this.prisma.otpChallenge.update({
      where: { id: challengeId },
      data: {
        provider: result.provider,
        providerMessageId: outcome.providerMessageId,
        deliveryState: outcome.deliveryState,
        deliveryDetail: outcome.deliveryDetail,
        sendCount: { increment: 1 },
        lastSentAt: now,
        resendNotBefore: new Date(now.getTime() + this.config.otpResendCooldownSeconds * 1000),
      },
    });

    if (accepted) this.counters.delivered++;
    else this.counters.deliveryFailed++;

    await this.auditSafely(
      'status_change',
      challengeId,
      null,
      { delivery: accepted ? 'accepted' : 'failed', provider: result.provider },
      accepted ? 'OTP delivery accepted by channel' : `OTP delivery failed: ${outcome.reason}`,
    );
    return accepted;
  }

  // ------------------------------------------------------------- verifying

  /**
   * Verify a submitted code.
   *
   * The winning transition is a conditional `updateMany` on `status: pending`,
   * so two concurrent submissions of the correct code produce exactly one
   * success — the second sees `count === 0` and is told the challenge is
   * already used.
   */
  async verify(params: {
    companyId: Buffer;
    userId: Buffer;
    challengeId: Buffer;
    code: string;
  }): Promise<VerifyOutcome> {
    const pepper = this.config.otpPepper;
    if (!pepper) return { ok: false, reason: 'not_found', attemptsRemaining: 0 };

    const challenge = await this.prisma.otpChallenge.findUnique({
      where: { id: params.challengeId },
    });

    // Cross-company or cross-user is "not found", never a distinct error: a
    // different answer would confirm the challenge exists elsewhere.
    if (
      !challenge ||
      !challenge.companyId.equals(params.companyId) ||
      !challenge.userId.equals(params.userId)
    ) {
      return { ok: false, reason: 'not_found', attemptsRemaining: 0 };
    }

    if (challenge.status === OtpStatus.verified) {
      return { ok: false, reason: 'already_used', attemptsRemaining: 0 };
    }
    if (challenge.status === OtpStatus.locked) {
      return { ok: false, reason: 'locked', attemptsRemaining: 0 };
    }
    if (challenge.status === OtpStatus.cancelled) {
      return { ok: false, reason: 'cancelled', attemptsRemaining: 0 };
    }
    if (challenge.status === OtpStatus.expired || challenge.expiresAt <= new Date()) {
      await this.markExpired(challenge.id);
      return { ok: false, reason: 'expired', attemptsRemaining: 0 };
    }

    const remaining = challenge.maxAttempts - challenge.attemptCount;
    if (remaining <= 0) {
      await this.lock(challenge.id);
      return { ok: false, reason: 'locked', attemptsRemaining: 0 };
    }

    const correct =
      isWellFormedCode(params.code) &&
      codeMatches(params.code, challenge.codeHash, binToUuid(challenge.id), pepper);

    if (!correct) {
      // Count the attempt atomically, then lock if that was the last one.
      const after = await this.prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { attemptCount: { increment: 1 }, lastAttemptAt: new Date() },
        select: { attemptCount: true, maxAttempts: true },
      });
      this.counters.verifyFailed++;
      const left = after.maxAttempts - after.attemptCount;
      if (left <= 0) {
        await this.lock(challenge.id);
        return { ok: false, reason: 'locked', attemptsRemaining: 0 };
      }
      await this.auditSafely('status_change', challenge.id, null, { result: 'failed' }, 'OTP verification failed');
      return { ok: false, reason: 'invalid_code', attemptsRemaining: left };
    }

    const now = new Date();
    const { count } = await this.prisma.otpChallenge.updateMany({
      // `status: pending` in the WHERE is the race guard: exactly one caller
      // can move it out of pending.
      where: { id: challenge.id, status: OtpStatus.pending },
      data: {
        status: OtpStatus.verified,
        verifiedAt: now,
        consumedAt: now,
        activeKey: null,
        attemptCount: { increment: 1 },
        lastAttemptAt: now,
      },
    });

    if (count === 0) {
      return { ok: false, reason: 'already_used', attemptsRemaining: 0 };
    }

    this.counters.verified++;
    await this.auditSafely('status_change', challenge.id, params.companyId, { result: 'verified' }, 'OTP verified');
    return {
      ok: true,
      challengeId: binToUuid(challenge.id),
      purpose: challenge.purpose,
      deviceId: challenge.deviceId ? binToUuid(challenge.deviceId) : null,
    };
  }

  // ------------------------------------------------------- other transitions

  /** Replace a live challenge with a new code, subject to the cooldown. */
  async resend(params: {
    companyId: Buffer;
    userId: Buffer;
    challengeId: Buffer;
    language?: 'en' | 'ar';
  }): Promise<RequestOutcome> {
    const challenge = await this.prisma.otpChallenge.findUnique({ where: { id: params.challengeId } });
    if (
      !challenge ||
      !challenge.companyId.equals(params.companyId) ||
      !challenge.userId.equals(params.userId) ||
      challenge.status !== OtpStatus.pending
    ) {
      return { ok: false, reason: 'otp_disabled', detail: 'No challenge to resend' };
    }
    if (challenge.resendNotBefore && challenge.resendNotBefore > new Date()) {
      this.counters.rateLimited++;
      return {
        ok: false,
        reason: 'rate_limited',
        detail: 'Please wait before asking for another code',
      };
    }

    // A resend is a NEW challenge: the old code stops working the moment the
    // replacement exists, which is what stops two codes being live at once.
    return this.request({
      companyId: challenge.companyId,
      userId: challenge.userId,
      purpose: challenge.purpose,
      destination: challenge.destination,
      deviceId: challenge.deviceId,
      candidatePhone: challenge.candidatePhone,
      language: params.language,
    });
  }

  async cancel(challengeId: Buffer): Promise<void> {
    const { count } = await this.prisma.otpChallenge.updateMany({
      where: { id: challengeId, status: OtpStatus.pending },
      data: { status: OtpStatus.cancelled, cancelledAt: new Date(), activeKey: null },
    });
    if (count > 0) {
      await this.auditSafely('status_change', challengeId, null, { result: 'cancelled' }, 'OTP challenge cancelled');
    }
  }

  /** Sweep expired challenges. Safe to call repeatedly. */
  async expireOverdue(): Promise<number> {
    const { count } = await this.prisma.otpChallenge.updateMany({
      where: { status: OtpStatus.pending, expiresAt: { lte: new Date() } },
      data: { status: OtpStatus.expired, activeKey: null },
    });
    this.counters.expired += count;
    return count;
  }

  async status(companyId: Buffer, challengeId: Buffer): Promise<ChallengeView | null> {
    const challenge = await this.prisma.otpChallenge.findUnique({ where: { id: challengeId } });
    if (!challenge || !challenge.companyId.equals(companyId)) return null;
    return this.toView(challenge);
  }

  // ---------------------------------------------------------------- internals

  private async markExpired(id: Buffer): Promise<void> {
    await this.prisma.otpChallenge.updateMany({
      where: { id, status: OtpStatus.pending },
      data: { status: OtpStatus.expired, activeKey: null },
    });
    this.counters.expired++;
  }

  private async lock(id: Buffer): Promise<void> {
    const { count } = await this.prisma.otpChallenge.updateMany({
      where: { id, status: OtpStatus.pending },
      data: { status: OtpStatus.locked, lockedAt: new Date(), activeKey: null },
    });
    if (count > 0) {
      this.counters.locked++;
      await this.auditSafely('status_change', id, null, { result: 'locked' }, 'OTP locked after too many attempts');
    }
  }

  /**
   * Per-user and per-destination send caps.
   *
   * Both matter: the per-user cap stops one account being used to hammer the
   * provider, and the per-destination cap stops one phone number being spammed
   * from several accounts.
   */
  private async checkSendLimits(
    userId: Buffer,
    destination: string,
  ): Promise<{ ok: false; reason: 'rate_limited'; detail: string } | null> {
    const now = Date.now();
    const windowStart = new Date(now - this.config.otpSendWindowSeconds * 1000);
    const dayStart = new Date(now - 24 * 60 * 60 * 1000);

    const inWindow = await this.prisma.otpChallenge.count({
      where: { userId, createdAt: { gte: windowStart } },
    });
    if (inWindow >= this.config.otpMaxSendsPerWindow) {
      return { ok: false, reason: 'rate_limited', detail: 'Too many codes requested just now' };
    }

    const perDay = await this.prisma.otpChallenge.count({
      where: { OR: [{ userId }, { destination }], createdAt: { gte: dayStart } },
    });
    if (perDay >= this.config.otpMaxSendsPerDay) {
      return { ok: false, reason: 'rate_limited', detail: 'Daily code limit reached' };
    }
    return null;
  }

  /**
   * The uniqueness key for "one live challenge".
   *
   * Includes the device so a phone-verification code and a device-verification
   * code can be live at once — they are different questions — while two codes
   * for the same question cannot.
   */
  private activeKeyFor(userId: Buffer, purpose: OtpPurpose, deviceId: Buffer | null): string {
    return `${binToUuid(userId)}:${purpose}:${deviceId ? binToUuid(deviceId) : 'none'}`;
  }

  private mapFailure(reason: DeliveryFailureReason): OtpDeliveryState {
    switch (reason) {
      case 'channel_unavailable':
        return OtpDeliveryState.channel_unavailable;
      case 'rejected':
        return OtpDeliveryState.rejected;
      case 'not_authorized':
        return OtpDeliveryState.not_authorized;
      default:
        return OtpDeliveryState.temporary_failure;
    }
  }

  /**
   * Audit without ever touching a secret.
   *
   * Never receives the code, the hash or the pepper, and the destination is
   * masked by the caller. Audit failures are swallowed: an audit problem must
   * not take down a sign-in.
   */
  private async auditSafely(
    action: 'create' | 'status_change',
    challengeId: Buffer,
    companyId: Buffer | null,
    after: Record<string, unknown>,
    reason: string,
  ): Promise<void> {
    try {
      await this.audit.record({
        entityType: 'OtpChallenge',
        entityId: challengeId,
        action,
        after: after as Prisma.InputJsonValue,
        reason,
      });
    } catch {
      this.logger.warn(`Could not audit OTP event: ${reason}`);
    }
    void companyId;
  }

  private toView(c: {
    id: Buffer;
    purpose: OtpPurpose;
    status: OtpStatus;
    destination: string;
    expiresAt: Date;
    attemptCount: number;
    maxAttempts: number;
    resendNotBefore: Date | null;
    deliveryState: OtpDeliveryState;
  }): ChallengeView {
    return {
      challengeId: binToUuid(c.id),
      purpose: c.purpose,
      status: c.status,
      destinationMasked: maskPhone(c.destination),
      expiresAt: c.expiresAt.toISOString(),
      attemptsRemaining: Math.max(0, c.maxAttempts - c.attemptCount),
      resendAvailableAt: c.resendNotBefore ? c.resendNotBefore.toISOString() : null,
      delivery: c.deliveryState,
      delivered: c.deliveryState === OtpDeliveryState.accepted,
    };
  }
}
