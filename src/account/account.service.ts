import { HttpException, HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { AccountDeletionKind, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { HashingService } from '../common/security/hashing.service';
import { OtpService } from '../auth/otp/otp.service';
import { maskPhone } from '../auth/otp/otp-code.util';
import { normalisePhone } from '../auth/identifier';
import { toE164 } from '../users/contact.util';
import type { MessageLanguage } from '../messaging/templates';
import { binToUuid, uuidToBin } from '../common/utils/uuid.util';
import { TrialSetupService } from '../platform/trial/trial-setup.service';
import { AccountDeletionService, DeletionPrincipal, DeletionRequestView } from './account-deletion.service';
import { WhatsAppRecords, type ConsentState } from '../messaging/whatsapp-records';
import {
  acceptedConsentVersion,
  consentCopy,
  consentLocaleOf,
  type ConsentCopy,
  type ConsentLocale,
} from '../messaging/whatsapp-consent';

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
  /** D224: required | deferred_by_platform | verified. `deferred_by_platform` is NOT verified. */
  phoneVerification: 'required' | 'deferred_by_platform' | 'verified';
  email: string | null;
  emailVerifiedAt: string | null;
  /** Whether a deletion code can be sent at all. */
  whatsappVerified: boolean;
  /** What "delete my account" would delete for this person. */
  deletionKind: AccountDeletionKind;
  deletion: DeletionRequestView | null;
}

/** My operational WhatsApp consent, as the app shows it (D213). Masked throughout; never the number or its hash. */
export interface WhatsAppConsentView {
  /** The copy in force: what a grant agrees to. */
  copy: ConsentCopy;
  /** My verified number, masked; null when I have none. */
  number: string | null;
  /**
   * Where my consent stands: `no_number` (nothing to consent for), `none` (never given — an account from before
   * D213 is never opted in), `granted` (to the copy in force), `outdated` (to an earlier copy), `withdrawn`.
   */
  state: 'no_number' | Exclude<ConsentState, never>;
  /** The version of my newest grant, whatever came after it. */
  grantedVersion: string | null;
  /** UTC ISO: when the consent in force was given. */
  grantedAt: string | null;
  /** UTC ISO: when it was withdrawn. */
  withdrawnAt: string | null;
  /** WhatsApp is my only verified contact: withdrawing leaves recovery to TSX-MR support. */
  onlyVerifiedContact: boolean;
  /** My own consent events for this number, newest first. */
  history: { event: string; version: string | null; locale: string | null; source: string; at: string }[];
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
    private readonly trialSetup: TrialSetupService,
    @Optional() private readonly whatsappRecords?: WhatsAppRecords,
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
        phoneVerification: true,
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
      phoneVerification: user.phoneVerification as AccountView['phoneVerification'],
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
    input: { phone: string; password: string; language?: MessageLanguage; whatsappConsentVersion?: string; whatsappConsentLocale?: string },
    ip: string | null = null,
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
    // A new number needs its own consent (D213), in every mode: the old number's never carries over. It is pending until
    // the code proves the number, and authorises nothing but that code.
    const consentVersion = acceptedConsentVersion(input.whatsappConsentVersion);
    if (!this.otp.canDeliverTo(phone)) {
      throw refuse(HttpStatus.SERVICE_UNAVAILABLE, 'verification_unavailable', 'Codes cannot be sent by this server right now.');
    }
    await this.records().recordPending({
      number: phone,
      version: consentVersion,
      locale: consentLocaleOf(input.whatsappConsentLocale, input.language ?? 'en'),
      companyId: p.companyId,
      userId: p.userId,
      source: 'account_settings',
      ip,
    });

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

  // ── Operational WhatsApp consent (D213) ──────────────────────────────

  private async contacts(p: DeletionPrincipal): Promise<{ number: string | null; emailVerified: boolean }> {
    const user = await this.prisma.user.findFirst({
      where: { id: p.userId, companyId: p.companyId, deletedAt: null },
      select: { phone: true, phoneVerifiedAt: true, email: true, emailVerifiedAt: true },
    });
    return {
      number: user?.phone && user.phoneVerifiedAt ? user.phone : null,
      emailVerified: Boolean(user?.email && user.emailVerifiedAt),
    };
  }

  private records(): WhatsAppRecords {
    if (!this.whatsappRecords) throw refuse(HttpStatus.SERVICE_UNAVAILABLE, 'consent_unavailable', 'WhatsApp consent cannot be recorded right now.');
    return this.whatsappRecords;
  }

  private async consentView(p: DeletionPrincipal, language: MessageLanguage): Promise<WhatsAppConsentView> {
    const { number, emailVerified } = await this.contacts(p);
    const copy = consentCopy(language);
    if (!number) {
      return { copy, number: null, state: 'no_number', grantedVersion: null, grantedAt: null, withdrawnAt: null, onlyVerifiedContact: false, history: [] };
    }
    const [state, history] = await Promise.all([this.records().contactState(number), this.records().consentHistory(number, p.userId)]);
    return {
      copy,
      number: maskPhone(number),
      state: state.consent,
      grantedVersion: state.consentVersion,
      grantedAt: state.consentedAt?.toISOString() ?? null,
      withdrawnAt: state.withdrawnAt?.toISOString() ?? null,
      onlyVerifiedContact: !emailVerified,
      history: history.map((h) => ({ event: h.event, version: h.version, locale: h.locale, source: h.source, at: h.at.toISOString() })),
    };
  }

  async whatsappConsent(p: DeletionPrincipal, language: MessageLanguage = 'en'): Promise<WhatsAppConsentView> {
    return this.consentView(p, language);
  }

  /**
   * Agree to the copy in force for my verified number — a new event, never an edit of an earlier one. Ends a
   * withdrawal. A replay of the same agreement writes nothing. Audited.
   */
  async grantWhatsappConsent(
    p: DeletionPrincipal,
    input: { version: string; locale?: string },
    language: MessageLanguage = 'en',
    ip: string | null = null,
  ): Promise<WhatsAppConsentView> {
    const version = acceptedConsentVersion(input.version);
    const { number } = await this.contacts(p);
    if (!number) throw refuse(HttpStatus.CONFLICT, 'whatsapp_number_required', 'Verify a WhatsApp number first.');
    const locale: ConsentLocale = consentLocaleOf(input.locale, language);
    await this.records().recordConsent({ number, version, locale, companyId: p.companyId, userId: p.userId, source: 'account_settings', ip });
    return this.consentView(p, language);
  }

  /**
   * Withdraw my operational WhatsApp consent: WhatsApp reminders and notices stop, and codes to my number with them.
   * Informational subscription notices go to my verified email instead (D213); codes, recovery and deletion
   * confirmation never do. My number and my account stay. When WhatsApp is my only verified contact the client must
   * say I understood that recovery then goes through TSX-MR support — the server refuses otherwise. Audited.
   */
  async withdrawWhatsappConsent(
    p: DeletionPrincipal,
    input: { acknowledgeSupportRecovery?: boolean },
    language: MessageLanguage = 'en',
    ip: string | null = null,
  ): Promise<WhatsAppConsentView> {
    const { number, emailVerified } = await this.contacts(p);
    if (!number) throw refuse(HttpStatus.CONFLICT, 'whatsapp_number_required', 'There is no verified WhatsApp number to withdraw consent for.');
    if (!emailVerified && input.acknowledgeSupportRecovery !== true) {
      throw refuse(
        HttpStatus.CONFLICT,
        'withdrawal_needs_acknowledgement',
        'WhatsApp is your only verified contact. Confirm that recovering your account will then go through TSX-MR support, or verify an email address first.',
        { onlyVerifiedContact: true },
      );
    }
    await this.records().withdrawConsent({ number, companyId: p.companyId, userId: p.userId, source: 'account_settings', ip });
    return this.consentView(p, language);
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

    const before = await this.prisma.user.findFirst({ where: { id: p.userId, companyId: p.companyId }, select: { phone: true, phoneVerifiedAt: true } });
    const now = new Date();
    const candidate = challenge.candidatePhone;
    try {
      /*
       * One transaction (D213): the number becomes the verified one, the agreement ticked for it with the code request
       * becomes the consent in force, and the replaced number's consent is superseded — it never carries over, nor
       * reaches whoever holds that number next. Recorded, never deleted.
       */
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: p.userId }, data: { phone: candidate, phoneVerifiedAt: now } });
        if (!this.whatsappRecords) return;
        await this.whatsappRecords.activatePending({ number: candidate, userId: p.userId, companyId: p.companyId }, tx);
        if (before?.phone && before.phoneVerifiedAt && before.phone !== candidate) {
          await this.whatsappRecords.supersede({ number: before.phone, companyId: p.companyId, userId: p.userId }, tx);
        }
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
    // The free trial (0095): an Owner who registered with an email and a number is owed the setup instructions once
    // the number is verified too — sent now, once. It never throws, and waits at most SETUP_DELIVERY_WAIT_MS for the
    // providers before the delivery goes on in the background (C14): the code is spent, so the answer must reach the
    // app — the number stays verified regardless.
    await this.trialSetup.onContactsVerified(p.companyId, p.userId);
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
