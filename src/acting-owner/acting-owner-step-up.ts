import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { OtpPurpose } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { OtpService } from '../auth/otp/otp.service';
import { binToUuid, isUuid, uuidToBin } from '../common/utils/uuid.util';
import type { MessageLanguage } from '../messaging/templates';

/**
 * The second factor for appointing or removing an Acting Owner (D225): the Owner's password, then a one-time code sent
 * to the Owner's verified WhatsApp number — the same {@link OtpService} account deletion uses, with its hashing,
 * single use, attempt lock, expiry and per-person and per-number send limits. Nothing here sends or checks a code by
 * itself.
 *
 * The code is bound to ONE change: the challenge's idempotency key carries a digest of what the Owner is confirming
 * (who, from when, until when — or which appointment is removed), so a code asked for "Mohamed until Friday" cannot
 * confirm "Aminetou until revoked", and a code sent for any other purpose cannot confirm either.
 *
 * Purpose: `acting_owner_step_up`, its own (0114). The service matches on the purpose, so no code issued for a
 * sign-in, a phone, a device or a deletion can confirm an appointment, and this code confirms nothing else.
 */
export const STEP_UP_PURPOSE: OtpPurpose = OtpPurpose.acting_owner_step_up;
export const STEP_UP_KEY_PREFIX = 'acting-owner:';

export type StepUpAction =
  | { action: 'appoint'; delegateId: string; startsAt: Date | null; endsAt: Date | null }
  | { action: 'revoke'; delegationId: string };

/** What the Owner is confirming, as a digest: equal only for the very same change. */
export function stepUpDigest(a: StepUpAction): string {
  const canonical =
    a.action === 'appoint'
      ? ['appoint', a.delegateId.toLowerCase(), a.startsAt ? String(a.startsAt.getTime()) : 'now', a.endsAt ? String(a.endsAt.getTime()) : 'open']
      : ['revoke', a.delegationId.toLowerCase()];
  return createHash('sha256').update(canonical.join('|')).digest('hex').slice(0, 32);
}

export interface StepUpChallenge {
  challengeId: string;
  destinationMasked: string;
  expiresAt: string;
  resendAvailableAt: string | null;
}

const refuse = (status: HttpStatus, code: string, message: string, extra: Record<string, unknown> = {}) => new HttpException({ code, message, ...extra }, status);

@Injectable()
export class ActingOwnerStepUp {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly otp: OtpService,
  ) {}

  /** Send a code to the Owner's verified WhatsApp number for this one change. The password was checked by the caller. */
  async request(p: { companyId: Buffer; userId: Buffer; change: StepUpAction; language?: MessageLanguage }): Promise<StepUpChallenge> {
    if (!this.otp.canDeliver) {
      throw refuse(HttpStatus.SERVICE_UNAVAILABLE, 'step_up_unavailable', 'Confirmation codes cannot be sent right now. Nothing was changed.');
    }
    const owner = await this.db.user.findUnique({ where: { id: p.userId }, select: { phone: true, phoneVerifiedAt: true } });
    if (!owner?.phone || !owner.phoneVerifiedAt) {
      throw refuse(HttpStatus.CONFLICT, 'whatsapp_number_required', 'Verify your WhatsApp number first. The confirmation code is sent only there.');
    }
    const outcome = await this.otp.request({
      companyId: p.companyId,
      userId: p.userId,
      purpose: STEP_UP_PURPOSE,
      destination: owner.phone,
      language: p.language ?? 'en',
      // Fresh each time (a new code supersedes the last one), and bound to the change it confirms.
      idempotencyKey: `${STEP_UP_KEY_PREFIX}${stepUpDigest(p.change)}:${randomUUID()}`,
    });
    if (!outcome.ok) {
      if (outcome.reason === 'rate_limited') throw refuse(HttpStatus.TOO_MANY_REQUESTS, 'too_many_codes', outcome.detail);
      throw refuse(HttpStatus.SERVICE_UNAVAILABLE, 'step_up_unavailable', 'The confirmation code could not be sent. Nothing was changed.');
    }
    if (!outcome.challenge.delivered) {
      throw refuse(HttpStatus.SERVICE_UNAVAILABLE, 'step_up_unavailable', 'The confirmation code could not be sent. Nothing was changed.', {
        delivery: outcome.challenge.delivery,
      });
    }
    return {
      challengeId: outcome.challenge.challengeId,
      destinationMasked: outcome.challenge.destinationMasked,
      expiresAt: outcome.challenge.expiresAt,
      resendAvailableAt: outcome.challenge.resendAvailableAt,
    };
  }

  /**
   * Spend the code for this one change, or refuse. The challenge must be this person's, sent by this flow, for this
   * change; then {@link OtpService.verify} decides — single use, attempts counted, locked after the last.
   */
  async confirm(p: { companyId: Buffer; userId: Buffer; change: StepUpAction; challengeId: string; code: string }): Promise<string> {
    const notActive = () => refuse(HttpStatus.CONFLICT, 'code_not_active', 'That code is not active for this change. Ask for a new one.');
    if (!isUuid(p.challengeId)) throw notActive();
    const challengeId = uuidToBin(p.challengeId);
    const challenge = await this.db.otpChallenge.findFirst({ where: { id: challengeId, userId: p.userId }, select: { purpose: true, idempotencyKey: true } });
    if (!challenge || challenge.purpose !== STEP_UP_PURPOSE || !challenge.idempotencyKey?.startsWith(`${STEP_UP_KEY_PREFIX}${stepUpDigest(p.change)}:`)) {
      throw notActive();
    }
    const verdict = await this.otp.verify({ companyId: p.companyId, userId: p.userId, challengeId, code: p.code });
    if (verdict.ok) return binToUuid(challengeId);
    switch (verdict.reason) {
      case 'invalid_code':
        throw refuse(HttpStatus.BAD_REQUEST, 'invalid_code', 'That code is not right.', { attemptsRemaining: verdict.attemptsRemaining });
      case 'expired':
        throw refuse(HttpStatus.GONE, 'code_expired', 'That code has expired. Ask for a new one.');
      case 'locked':
        throw refuse(HttpStatus.TOO_MANY_REQUESTS, 'code_locked', 'Too many wrong codes. Ask for a new one.');
      default:
        throw notActive();
    }
  }
}
