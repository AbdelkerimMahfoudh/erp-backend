import { HttpException, HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { normaliseEmail, normalisePhone } from '../auth/identifier';
import { OtpService } from '../auth/otp/otp.service';
import { maskPhone } from '../auth/otp/otp-code.util';
import { TokensService } from '../auth/tokens.service';
import { HashingService } from '../common/security/hashing.service';
import { binToUuid, isUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { EMAIL_CHANNEL, type EmailChannel } from '../messaging/email-channel';
import type { MessageLanguage } from '../messaging/templates';
import { WhatsAppRecords } from '../messaging/whatsapp-records';
import { ContactVerificationService } from '../platform/contact-verification.service';
import { moveOwnerContactTx } from '../platform/owner-identity/owner-identity';
import { PrismaService } from '../prisma/prisma.service';
import { toE164 } from '../users/contact.util';
import { acceptedConsentVersion, consentLocaleOf, type ConsentLocale } from '../messaging/whatsapp-consent';
import type { DeletionPrincipal } from './account-deletion.service';

export const CHANGE_TTL_MINUTES = 15;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;

const refuse = (status: HttpStatus, code: string, message: string) => new HttpException({ code, message }, status);
/** One answer for every refusal that could reveal somebody else's contact. */
const contactRefused = () => refuse(HttpStatus.CONFLICT, 'change_refused', 'That change could not be made. Check the details, or try another.');
const wrongCode = () => refuse(HttpStatus.BAD_REQUEST, 'invalid_code', 'That code is not right, or it has expired. Ask for a new one.');

type Channel = 'phone' | 'email';
interface CodeRef {
  channel: Channel;
  destination: string;
  id: Buffer;
}

/**
 * More → Your account → Security and sign-in (D227). A change is one row: who, what, which stage, and the code each stage is
 * waiting for. A code is checked only against that row's own challenge, so no other code from any other flow can answer it.
 * Nothing about the account moves until the last step, which commits as one transaction: a failure anywhere leaves the old
 * password or contact working. Passwords, codes and full contacts never reach a log or an audit row.
 */
@Injectable()
export class AccountSecurityService {
  private readonly logger = new Logger(AccountSecurityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly otp: OtpService,
    private readonly contacts: ContactVerificationService,
    private readonly tokens: TokensService,
    @Optional() private readonly records?: WhatsAppRecords,
    @Optional() @Inject(EMAIL_CHANNEL) private readonly email?: EmailChannel,
  ) {}

  private get emailOpen(): boolean {
    return Boolean(this.email?.isEnabled);
  }

  /** What this deployment can do, so the screen can say it rather than fail after a password. */
  capabilities() {
    return { emailChange: this.emailOpen };
  }

  // ── password ──

  async startPassword(p: DeletionPrincipal, input: { currentPassword: string; language?: MessageLanguage }) {
    const user = await this.authenticated(p, input.currentPassword);
    return this.open(p, user, 'password', null, input.language ?? 'en');
  }

  async confirmPassword(p: DeletionPrincipal, input: { changeId: string; code: string; newPassword: string }) {
    const password = input.newPassword ?? '';
    if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
      throw refuse(HttpStatus.BAD_REQUEST, 'password_weak', 'Choose a password of at least 8 characters.');
    }
    const change = await this.live(p, input.changeId, 'password', 'old_channel');
    const user = await this.userOf(p);
    // The same password again is not a change, and would rotate nothing an attacker does not already hold.
    if (await this.hashing.verify(user.passwordHash, password)) {
      throw refuse(HttpStatus.BAD_REQUEST, 'password_same', 'Choose a password different from the one you use now.');
    }
    await this.spend(p, this.codeOf(change, 'old'), input.code);

    const passwordHash = await this.hashing.hash(password);
    const secret = this.tokens.generateRefreshSecret();
    const refreshTokenHash = await this.hashing.hash(secret);
    await this.prisma.$transaction(async (tx) => {
      await this.complete(tx, change.id);
      await tx.user.update({ where: { id: p.userId }, data: { passwordHash } });
      await tx.authSession.updateMany({ where: { userId: p.userId, revokedAt: null, id: { not: p.sessionId } }, data: { revokedAt: new Date() } });
      // This session's old token dies too: whoever copied it is out, and this phone carries on with the new one.
      await tx.authSession.update({ where: { id: p.sessionId }, data: { refreshTokenHash } });
      await this.trail(tx, p, 'password_changed', {});
    });
    await this.tell(user, 'Your password was changed');
    return { changed: true, refreshToken: this.tokens.buildRefreshToken(binToUuid(p.sessionId), secret) };
  }

  // ── a contact: password, then the existing channel, then the new one ──

  async startContact(
    p: DeletionPrincipal,
    input: { kind: Channel; value: string; currentPassword: string; language?: MessageLanguage; whatsappConsentVersion?: string; whatsappConsentLocale?: ConsentLocale },
    ip: string | null = null,
  ) {
    if (input.kind === 'email' && !this.emailOpen) {
      // Said before anything happens: no address is ever marked verified without a message that really went.
      throw refuse(HttpStatus.SERVICE_UNAVAILABLE, 'email_unavailable', 'Email is not available yet, so an address cannot be changed.');
    }
    const user = await this.authenticated(p, input.currentPassword);
    const next = this.normalised(input.kind, input.value);
    if (next === (input.kind === 'phone' ? user.phone : user.email)) throw contactRefused();

    if (input.kind === 'phone') {
      const consent = acceptedConsentVersion(input.whatsappConsentVersion);
      if (!this.otp.canDeliverTo(next)) throw refuse(HttpStatus.SERVICE_UNAVAILABLE, 'verification_unavailable', 'Codes cannot be sent at the moment.');
      await this.records?.recordPending({
        number: next,
        version: consent,
        locale: consentLocaleOf(input.whatsappConsentLocale, input.language ?? 'en'),
        companyId: p.companyId,
        userId: p.userId,
        source: 'account_settings',
        ip,
      });
    }
    // Nothing here says whether somebody else holds the new contact: that is decided at the end, in one generic answer.
    return this.open(p, user, input.kind, next, input.language ?? 'en');
  }

  /** The existing channel said yes: a code goes to the new one, unless it is taken, which looks no different from here. */
  async confirmOld(p: DeletionPrincipal, input: { changeId: string; code: string; language?: MessageLanguage }) {
    const change = await this.live(p, input.changeId, ['phone', 'email'], 'old_channel');
    await this.spend(p, this.codeOf(change, 'old'), input.code);
    const kind = change.kind as Channel;
    const taken = await this.takenInCompany(p, kind, change.newContact!);
    const code = taken ? null : await this.send(p, kind, change.newContact!, input.language ?? 'en');
    const moved = await this.prisma.credentialChange.updateMany({
      where: { id: change.id, stage: 'old_channel' },
      data: { stage: 'new_channel', newCodeId: code?.id ?? null, newCodeChannel: kind },
    });
    if (!moved.count) throw wrongCode();
    return { changeId: input.changeId, stage: 'new_channel', destinationMasked: mask(kind, change.newContact!) };
  }

  async confirmNew(p: DeletionPrincipal, input: { changeId: string; code: string }) {
    const change = await this.live(p, input.changeId, ['phone', 'email'], 'new_channel');
    if (!change.newCodeId) throw wrongCode();
    const kind = change.kind as Channel;
    const next = change.newContact!;
    await this.spend(p, this.codeOf(change, 'new'), input.code);
    const user = await this.userOf(p);
    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.complete(tx, change.id);
        await tx.user.update({
          where: { id: p.userId },
          data: kind === 'phone' ? { phone: next, phoneVerifiedAt: now } : { email: next, emailVerifiedAt: now },
        });
        // An Owner's contact is theirs across the platform: a clash rolls all of this back.
        await moveOwnerContactTx(tx, { id: p.userId, companyId: p.companyId }, kind, next);
        if (kind === 'phone' && this.records) {
          await this.records.activatePending({ number: next, userId: p.userId, companyId: p.companyId }, tx);
          if (user.phone && user.phoneVerifiedAt) await this.records.supersede({ number: user.phone, companyId: p.companyId, userId: p.userId }, tx);
        }
        await tx.authSession.updateMany({ where: { userId: p.userId, revokedAt: null, id: { not: p.sessionId } }, data: { revokedAt: now } });
        await this.trail(tx, p, kind === 'phone' ? 'whatsapp_changed' : 'email_changed', { to: mask(kind, next) });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw contactRefused();
      if (e instanceof HttpException && (e.getResponse() as { code?: string }).code === 'contact_unavailable') throw contactRefused();
      throw e;
    }
    await this.tell(user, kind === 'phone' ? 'Your WhatsApp number was changed' : 'Your email address was changed');
    return { changed: true, kind, destinationMasked: mask(kind, next) };
  }

  async cancel(p: DeletionPrincipal, changeId: string) {
    if (!isUuid(changeId)) return { cancelled: false };
    const { count } = await this.prisma.credentialChange.updateMany({
      where: { id: uuidToBin(changeId), userId: p.userId, companyId: p.companyId, stage: { in: ['old_channel', 'new_channel'] } },
      data: { stage: 'cancelled', newContact: null },
    });
    return { cancelled: count === 1 };
  }

  /** What happened to this person's own sign-in, newest first. Masked already: nothing else was ever written. */
  async history(p: DeletionPrincipal) {
    const rows = await this.prisma.auditLog.findMany({
      where: { companyId: p.companyId, entityType: 'User', entityId: p.userId, reason: { startsWith: 'security:' } },
      orderBy: { id: 'desc' },
      take: 30,
      select: { reason: true, at: true },
    });
    return rows.map((r) => ({ event: r.reason!.slice('security:'.length), at: r.at.toISOString() }));
  }

  // ── the parts ──

  private async userOf(p: DeletionPrincipal) {
    const user = await this.prisma.user.findFirst({ where: { id: p.userId, companyId: p.companyId, deletedAt: null, isActive: true } });
    if (!user) throw refuse(HttpStatus.UNAUTHORIZED, 'reauthentication_failed', 'That password did not match.');
    return user;
  }

  private async authenticated(p: DeletionPrincipal, password: string) {
    const user = await this.userOf(p);
    if (!(await this.hashing.verify(user.passwordHash, password ?? ''))) {
      await this.trailOutside(p, 'password_refused');
      throw refuse(HttpStatus.UNAUTHORIZED, 'reauthentication_failed', 'That password did not match.');
    }
    return user;
  }

  private normalised(kind: Channel, value: string): string {
    if (kind === 'phone') {
      const phone = normalisePhone(value) ?? toE164(value);
      if (!phone) throw refuse(HttpStatus.BAD_REQUEST, 'invalid_contact', 'Enter a WhatsApp number with its country code.');
      return phone;
    }
    const email = normaliseEmail(value ?? '');
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw refuse(HttpStatus.BAD_REQUEST, 'invalid_contact', 'Enter an email address.');
    return email;
  }

  private async open(p: DeletionPrincipal, user: { phone: string | null; phoneVerifiedAt: Date | null; email: string | null; emailVerifiedAt: Date | null }, kind: 'password' | Channel, newContact: string | null, language: MessageLanguage) {
    // The channel this account has already proven: never the one being changed to, never an unverified one.
    const channel: Channel | null = user.phone && user.phoneVerifiedAt ? 'phone' : user.email && user.emailVerifiedAt ? 'email' : null;
    if (!channel) throw refuse(HttpStatus.CONFLICT, 'no_verified_channel', 'Verify your WhatsApp number first.');
    const destination = channel === 'phone' ? user.phone! : user.email!;

    // One change at a time: a new one ends whatever was still waiting. An ended change keeps no contact (privacy review,
    // D227): a number someone tried to move to may be somebody else's. Expired rows are cleared here too.
    await this.prisma.credentialChange.updateMany({ where: { userId: p.userId, stage: { in: ['old_channel', 'new_channel'] } }, data: { stage: 'cancelled', newContact: null } });
    await this.prisma.credentialChange.updateMany({ where: { userId: p.userId, newContact: { not: null } }, data: { newContact: null } });
    const code = await this.send(p, channel, destination, language);
    const id = newUuidV7Bin();
    await this.prisma.credentialChange.create({
      data: {
        id,
        companyId: p.companyId,
        userId: p.userId,
        kind,
        stage: 'old_channel',
        newContact,
        oldCodeId: code.id,
        oldCodeChannel: channel,
        expiresAt: new Date(Date.now() + CHANGE_TTL_MINUTES * 60_000),
      },
    });
    return { changeId: binToUuid(id), stage: 'old_channel', channel, destinationMasked: mask(channel, destination) };
  }

  private async send(p: DeletionPrincipal, channel: Channel, destination: string, language: MessageLanguage): Promise<CodeRef> {
    if (channel === 'phone') {
      const outcome = await this.otp.request({
        companyId: p.companyId,
        userId: p.userId,
        purpose: 'credential_change',
        destination,
        ...(destination ? { candidatePhone: destination } : {}),
        language,
      });
      if (!outcome.ok) {
        if (outcome.reason === 'rate_limited') throw refuse(HttpStatus.TOO_MANY_REQUESTS, 'too_many_codes', 'Too many codes. Try again in a little while.');
        throw refuse(HttpStatus.SERVICE_UNAVAILABLE, 'verification_unavailable', 'The code could not be sent.');
      }
      if (!outcome.challenge.delivered) throw refuse(HttpStatus.SERVICE_UNAVAILABLE, 'code_undeliverable', 'The code could not be delivered.');
      return { channel, destination, id: uuidToBin(outcome.challenge.challengeId) };
    }
    if (!this.emailOpen) throw refuse(HttpStatus.SERVICE_UNAVAILABLE, 'email_unavailable', 'Email is not available yet.');
    try {
      await this.contacts.start(destination, language);
    } catch {
      throw refuse(HttpStatus.SERVICE_UNAVAILABLE, 'code_undeliverable', 'The code could not be delivered.');
    }
    const id = await this.contacts.latestChallengeFor(destination);
    if (!id) throw refuse(HttpStatus.SERVICE_UNAVAILABLE, 'code_undeliverable', 'The code could not be delivered.');
    return { channel, destination, id };
  }

  private async live(p: DeletionPrincipal, changeId: string, kind: string | string[], stage: 'old_channel' | 'new_channel') {
    if (!isUuid(changeId)) throw wrongCode();
    const change = await this.prisma.credentialChange.findFirst({ where: { id: uuidToBin(changeId), userId: p.userId, companyId: p.companyId } });
    const kinds = Array.isArray(kind) ? kind : [kind];
    if (!change || !kinds.includes(change.kind) || change.stage !== stage || change.expiresAt <= new Date()) throw wrongCode();
    return change;
  }

  private codeOf(change: { oldCodeId: Buffer; oldCodeChannel: string; newCodeId: Buffer | null; newCodeChannel: string | null }, which: 'old' | 'new') {
    return which === 'old'
      ? { id: change.oldCodeId, channel: change.oldCodeChannel as Channel }
      : { id: change.newCodeId!, channel: change.newCodeChannel as Channel };
  }

  /** Single use: the challenge's own guard lets exactly one caller through, with the attempt limits it always had. */
  private async spend(p: DeletionPrincipal, code: { id: Buffer; channel: Channel }, value: string) {
    if (code.channel === 'phone') {
      const verdict = await this.otp.verify({ companyId: p.companyId, userId: p.userId, challengeId: code.id, code: value });
      if (!verdict.ok) {
        if (verdict.reason === 'locked') throw refuse(HttpStatus.CONFLICT, 'too_many_attempts', 'Too many wrong codes. Ask for a new one.');
        throw wrongCode();
      }
      if (verdict.purpose !== 'credential_change') throw wrongCode();
      return;
    }
    if ((await this.contacts.confirmChallenge(code.id, value)) !== 'ok') throw wrongCode();
    const { count } = await this.prisma.contactVerification.updateMany({ where: { id: code.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (count !== 1) throw wrongCode();
  }

  private async complete(tx: Prisma.TransactionClient, id: Buffer) {
    const { count } = await tx.credentialChange.updateMany({ where: { id, stage: { in: ['old_channel', 'new_channel'] } }, data: { stage: 'completed', completedAt: new Date(), newContact: null } });
    if (count !== 1) throw wrongCode();
  }

  private async takenInCompany(p: DeletionPrincipal, kind: Channel, value: string) {
    const clash = await this.prisma.user.findFirst({ where: { companyId: p.companyId, id: { not: p.userId }, deletedAt: null, ...(kind === 'phone' ? { phone: value } : { email: value }) }, select: { id: true } });
    return clash !== null;
  }

  private trail(db: Prisma.TransactionClient, p: DeletionPrincipal, event: string, after: Record<string, unknown>) {
    return db.auditLog.create({
      data: { companyId: p.companyId, userId: p.userId, entityType: 'User', entityId: p.userId, action: 'update', after: after as Prisma.InputJsonValue, reason: `security:${event}` },
    });
  }

  private async trailOutside(p: DeletionPrincipal, event: string) {
    try {
      await this.trail(this.prisma, p, event, {});
    } catch {
      this.logger.warn('Could not record a security event');
    }
  }

  /** Told on the channel that did not change hands, best effort: the change itself stands either way. */
  private async tell(user: { email: string | null; emailVerifiedAt: Date | null; language?: string | null }, what: string) {
    if (!this.email?.isEnabled || !user.email || !user.emailVerifiedAt) return;
    try {
      await this.email.send({
        to: user.email,
        template: 'security.alert',
        language: 'en',
        variables: { what, when: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC' },
        idempotencyKey: `security:${binToUuid(newUuidV7Bin())}`,
      });
    } catch {
      this.logger.warn('Could not send a security notice');
    }
  }
}

function mask(kind: Channel, value: string): string {
  if (kind === 'phone') return maskPhone(value);
  const [name, domain] = value.split('@');
  return `${name!.slice(0, 1)}***@${domain}`;
}
