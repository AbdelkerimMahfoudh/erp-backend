import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AccountDeletionKind, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { HashingService } from '../common/security/hashing.service';
import { OtpService } from '../auth/otp/otp.service';
import { maskPhone } from '../auth/otp/otp-code.util';
import { normalisePhone } from '../auth/identifier';
import { toE164 } from '../users/contact.util';
import type { MessageLanguage } from '../messaging/templates';
import { binToUuid, uuidToBin } from '../common/utils/uuid.util';
import { AccountDeletionService, DeletionPrincipal, DeletionRequestView } from './account-deletion.service';

/**
 * The signed-in person's own account (docs/64 §5).
 *
 * Everything here is about the caller and only the caller: who they are, the
 * WhatsApp number they can prove, and what deleting their account would mean.
 * Reachable in every subscription state, because a pending or suspended shop
 * still has people who must be able to verify a number, see where they stand,
 * sign out and ask for deletion.
 */

export interface AccountView {
  id: string;
  name: string;
  login: string;
  personalId: string;
  phone: string | null;
  phoneVerifiedAt: string | null;
  email: string | null;
  emailVerifiedAt: string | null;
  /** Whether a deletion code can be sent at all. */
  whatsappVerified: boolean;
  /** What "delete my account" would delete for this person. */
  deletionKind: AccountDeletionKind;
  deletion: DeletionRequestView | null;
}

export interface PhoneVerificationStart {
  challengeId: string;
  destinationMasked: string;
  expiresAt: string;
  attemptsRemaining: number;
  resendAvailableAt: string | null;
  delivered: boolean;
}

function refuse(status: HttpStatus, code: string, message: string, extra: Record<string, unknown> = {}): HttpException {
  return new HttpException({ code, message, ...extra }, status);
}

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly otp: OtpService,
    private readonly deletion: AccountDeletionService,
  ) {}

  async me(p: DeletionPrincipal): Promise<AccountView> {
    const user = await this.prisma.user.findFirst({
      where: { id: p.userId, companyId: p.companyId, deletedAt: null },
      select: {
        id: true,
        name: true,
        login: true,
        personalId: true,
        phone: true,
        phoneVerifiedAt: true,
        email: true,
        emailVerifiedAt: true,
      },
    });
    if (!user) throw refuse(HttpStatus.UNAUTHORIZED, 'unauthorized', 'Sign in again.');

    const [deletionKind, deletion] = await Promise.all([
      this.deletion.kindFor(p.companyId, p.userId),
      this.deletion.current(p),
    ]);
    return {
      id: binToUuid(user.id),
      name: user.name,
      login: user.login,
      personalId: user.personalId,
      phone: user.phone,
      phoneVerifiedAt: user.phoneVerifiedAt?.toISOString() ?? null,
      email: user.email,
      emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
      whatsappVerified: Boolean(user.phone && user.phoneVerifiedAt),
      deletionKind,
      deletion,
    };
  }

  /**
   * Prove a WhatsApp number: the password again, then a code to THAT number.
   *
   * The number is bound to the challenge (`candidatePhone`), so a number
   * changed mid-flight cannot inherit the proof, and nothing is written to
   * the user until the code comes back.
   */
  async startPhoneVerification(
    p: DeletionPrincipal,
    input: { phone: string; password: string; language?: MessageLanguage },
  ): Promise<PhoneVerificationStart> {
    const user = await this.prisma.user.findFirst({
      where: { id: p.userId, companyId: p.companyId, deletedAt: null, isActive: true },
      select: { id: true, phone: true, phoneVerifiedAt: true, passwordHash: true },
    });
    const ok = user ? await this.hashing.verify(user.passwordHash, input.password) : await this.hashing.verifyDummy(input.password);
    if (!ok || !user) throw refuse(HttpStatus.UNAUTHORIZED, 'reauthentication_failed', 'That password did not match.');

    const phone = normalisePhone(input.phone) ?? toE164(input.phone);
    if (!phone) {
      throw refuse(HttpStatus.BAD_REQUEST, 'invalid_phone', 'Enter a WhatsApp number, e.g. 43 21 09 87 or +222 43210987');
    }
    if (user.phone === phone && user.phoneVerifiedAt) {
      throw refuse(HttpStatus.CONFLICT, 'already_verified', 'This number is already verified.');
    }
    const clash = await this.prisma.user.findFirst({
      where: { companyId: p.companyId, phone, id: { not: p.userId }, deletedAt: null },
      select: { id: true },
    });
    if (clash) {
      throw refuse(HttpStatus.CONFLICT, 'phone_in_use', 'Another person in this business already uses that number.');
    }
    // Before a challenge is written: with no channel it could never go out, and
    // "could not be delivered to that number" would blame a number that is fine.
    if (!this.otp.canDeliver) {
      throw refuse(HttpStatus.SERVICE_UNAVAILABLE, 'verification_unavailable', 'Codes cannot be sent by this server right now.');
    }

    const outcome = await this.otp.request({
      companyId: p.companyId,
      userId: p.userId,
      purpose: 'phone_verification',
      destination: phone,
      candidatePhone: phone,
      language: input.language ?? 'en',
    });
    if (!outcome.ok) {
      if (outcome.reason === 'rate_limited') throw refuse(HttpStatus.TOO_MANY_REQUESTS, 'too_many_codes', outcome.detail);
      throw refuse(HttpStatus.SERVICE_UNAVAILABLE, 'verification_unavailable', 'The code could not be sent.');
    }
    const c = outcome.challenge;
    if (!c.delivered) {
      // Visible, never faked: the challenge exists and its delivery failed.
      throw refuse(HttpStatus.SERVICE_UNAVAILABLE, 'code_undeliverable', 'The code could not be delivered to that number.', {
        delivery: c.delivery,
        challengeId: c.challengeId,
      });
    }
    await this.audit(p, 'update', { phoneVerificationRequested: maskPhone(phone) }, 'WhatsApp number verification requested');
    return {
      challengeId: c.challengeId,
      destinationMasked: c.destinationMasked,
      expiresAt: c.expiresAt,
      attemptsRemaining: c.attemptsRemaining,
      resendAvailableAt: c.resendAvailableAt,
      delivered: c.delivered,
    };
  }

  /** The code came back: the number becomes this person's verified WhatsApp number. */
  async confirmPhoneVerification(
    p: DeletionPrincipal,
    input: { challengeId: string; code: string },
  ): Promise<{ phone: string; phoneVerifiedAt: string }> {
    const challengeId = uuidToBin(input.challengeId);
    const verdict = await this.otp.verify({ companyId: p.companyId, userId: p.userId, challengeId, code: input.code });
    if (!verdict.ok) {
      switch (verdict.reason) {
        case 'invalid_code':
          throw refuse(HttpStatus.BAD_REQUEST, 'invalid_code', 'That code is not right.', {
            attemptsRemaining: verdict.attemptsRemaining,
          });
        case 'expired':
          throw refuse(HttpStatus.GONE, 'code_expired', 'That code has expired. Ask for a new one.');
        case 'locked':
          throw refuse(HttpStatus.CONFLICT, 'too_many_attempts', 'Too many wrong codes. Ask for a new one.');
        default:
          throw refuse(HttpStatus.CONFLICT, 'code_not_active', 'That code is not active.');
      }
    }
    // A deletion code — or any other purpose — must never verify a number.
    if (verdict.purpose !== 'phone_verification') {
      throw refuse(HttpStatus.CONFLICT, 'code_not_active', 'That code is not a number-verification code.');
    }
    const challenge = await this.prisma.otpChallenge.findUnique({
      where: { id: challengeId },
      select: { candidatePhone: true },
    });
    if (!challenge?.candidatePhone) {
      throw refuse(HttpStatus.CONFLICT, 'code_not_active', 'That code carries no number to verify.');
    }

    const now = new Date();
    try {
      await this.prisma.user.update({
        where: { id: p.userId },
        data: { phone: challenge.candidatePhone, phoneVerifiedAt: now },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw refuse(HttpStatus.CONFLICT, 'phone_in_use', 'Another person in this business already uses that number.');
      }
      throw e;
    }
    // A login identifier changed: every OTHER session ends, this one continues.
    await this.prisma.authSession.updateMany({
      where: { userId: p.userId, revokedAt: null, id: { not: p.sessionId } },
      data: { revokedAt: now },
    });
    await this.audit(
      p,
      'update',
      { phone: maskPhone(challenge.candidatePhone), phoneVerifiedAt: now.toISOString() },
      'WhatsApp number verified by its holder',
    );
    return { phone: challenge.candidatePhone, phoneVerifiedAt: now.toISOString() };
  }

  private async audit(p: DeletionPrincipal, action: 'update', after: Record<string, unknown>, reason: string): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          companyId: p.companyId,
          userId: p.userId,
          entityType: 'User',
          entityId: p.userId,
          action,
          after: after as Prisma.InputJsonValue,
          reason,
        },
      });
    } catch {
      this.logger.warn(`Could not audit account event: ${reason}`);
    }
  }
}
