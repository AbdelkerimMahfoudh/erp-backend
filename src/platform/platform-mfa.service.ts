import { ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { PlatformAdmin } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../common/config/app-config.service';
import { HashingService } from '../common/security/hashing.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import { normaliseEmail } from '../auth/identifier';
import { PlatformAuditService } from './platform-audit.service';
import type { PlatformAdminIdentity } from './platform-admin.service';
import { generateTotpSecret, otpauthUri, verifyTotp } from './mfa/totp';
import { keyedDigest, open, parseMfaKey, seal } from './mfa/secret-box';
import { generateRecoveryCodes, looksLikeRecoveryCode, normaliseRecoveryCode } from './mfa/recovery-codes';

/**
 * Mandatory TOTP for platform administrators (correction phase, 2026-10-12; docs/48).
 *
 * The rules, each enforced here rather than by convention:
 *
 *  - **No session reaches anything without its second factor.** A password opens a *pending* session that reaches
 *    the MFA routes only (`PlatformAdminGuard`); a TOTP code or a recovery code completes it.
 *  - **A password alone can never enrol.** First enrolment and every reset need a one-time enrolment token that
 *    only the server CLI issues (`prisma/platform-admin-mfa.ts`), valid thirty minutes, stored as a keyed digest.
 *    Somebody holding a stolen password cannot bind their own authenticator.
 *  - **Enrolment is confirmed before it counts:** the secret is kept pending until a code from it verifies.
 *  - **The secret is sealed at rest** (AES-256-GCM under `PLATFORM_MFA_KEY`); recovery codes are keyed digests,
 *    single-use, and a new set revokes the old.
 *  - **Replay and guessing:** a step at or before the last one used is refused; five failures lock the second
 *    factor for fifteen minutes (with the route throttle in front).
 *  - **Step-up** for every high-impact action is the password *and* a fresh code, recorded on the session and
 *    honoured for five minutes, server-side (`assertFreshStepUp`).
 *  - **Audited:** enrolment, verification, every failure, the lock, recovery-code use and regeneration, resets.
 *    Never a secret, a code or a token in an audit row or a log line.
 */

export const STEP_UP_TTL_MS = 5 * 60 * 1000;
export const MFA_MAX_FAILURES = 5;
export const MFA_LOCK_MS = 15 * 60 * 1000;
export const ENROLMENT_TOKEN_TTL_MS = 30 * 60 * 1000;
export const TOTP_ISSUER = 'Dukan ERP';

export type MfaState = 'required' | 'enrolment_required';

const refuse = (status: HttpStatus, code: string, message: string, extra: Record<string, unknown> = {}) => new HttpException({ code, message, ...extra }, status);

@Injectable()
export class PlatformMfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly audit: PlatformAuditService,
    private readonly hashing: HashingService,
  ) {}

  /** The sealing key, or a refusal: without it no second factor can be checked, so nothing administrative opens. */
  private key(): Buffer {
    const key = parseMfaKey(this.config.platformMfaKey);
    if (!key) {
      throw new ServiceUnavailableException({
        code: 'mfa_unavailable',
        message: 'Administrator MFA is not configured on this server (PLATFORM_MFA_KEY). Nothing administrative can open.',
      });
    }
    return key;
  }

  stateOf(admin: Pick<PlatformAdmin, 'mfaEnabledAt' | 'mfaSecretEnc'>): MfaState {
    return admin.mfaEnabledAt && admin.mfaSecretEnc ? 'required' : 'enrolment_required';
  }

  // ── Issued by the server CLI only ────────────────────────────────────────

  /**
   * Reset an administrator's second factor and issue the one-time enrolment token. **No HTTP route reaches this.**
   * Every session and recovery code goes with the old factor.
   */
  async issueEnrolmentToken(emailRaw: string, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
    const key = this.key();
    const admin = await this.prisma.platformAdmin.findFirst({ where: { email: normaliseEmail(emailRaw), deletedAt: null } });
    if (!admin) throw new NotFoundException('No platform administrator has that address.');
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(now.getTime() + ENROLMENT_TOKEN_TTL_MS);
    await this.prisma.$transaction(async (tx) => {
      await tx.platformAdmin.update({
        where: { id: admin.id },
        data: {
          mfaSecretEnc: null,
          mfaEnabledAt: null,
          mfaLastStep: null,
          mfaPendingSecretEnc: null,
          mfaEnrolmentTokenHash: keyedDigest(token, key),
          mfaEnrolmentExpiresAt: expiresAt,
          mfaFailedCount: 0,
          mfaLockedUntil: null,
        },
      });
      await tx.platformAdminRecoveryCode.updateMany({ where: { adminId: admin.id, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
      await tx.platformAdminSession.updateMany({ where: { adminId: admin.id, revokedAt: null }, data: { revokedAt: now } });
    });
    await this.audit.record({ admin: null, actor: 'cli', action: 'admin.mfa.reset', targetType: 'PlatformAdmin', targetId: admin.id, targetLabel: admin.email, reason: 'Enrolment token issued on the server' });
    return { token, expiresAt };
  }

  // ── Enrolment, from a pending session ────────────────────────────────────

  async startEnrolment(admin: PlatformAdminIdentity, enrolmentToken: string, ip: string | null, now = new Date()): Promise<{ secret: string; otpauthUri: string }> {
    const key = this.key();
    const row = await this.load(admin.id);
    const valid =
      row.mfaEnrolmentTokenHash !== null &&
      row.mfaEnrolmentExpiresAt !== null &&
      row.mfaEnrolmentExpiresAt > now &&
      typeof enrolmentToken === 'string' &&
      keyedDigest(enrolmentToken.trim(), key) === row.mfaEnrolmentTokenHash;
    if (!valid) {
      await this.audit.record({ admin, action: 'admin.mfa.enrolment_refused', targetType: 'PlatformAdmin', targetId: admin.id, targetLabel: admin.email, ip });
      throw refuse(HttpStatus.FORBIDDEN, 'enrolment_token_invalid', 'That enrolment token is not valid. Ask for a new one on the server.');
    }
    const secret = generateTotpSecret();
    await this.prisma.platformAdmin.update({ where: { id: admin.id }, data: { mfaPendingSecretEnc: seal(secret, key) } });
    await this.audit.record({ admin, action: 'admin.mfa.enrolment_started', targetType: 'PlatformAdmin', targetId: admin.id, targetLabel: admin.email, ip });
    return { secret, otpauthUri: otpauthUri({ issuer: TOTP_ISSUER, account: admin.email, secret }) };
  }

  /** The first code from the new authenticator: only now does the factor count. The recovery codes are shown once. */
  async confirmEnrolment(admin: PlatformAdminIdentity, sessionId: Buffer, code: string, ip: string | null, now = new Date()): Promise<{ recoveryCodes: string[] }> {
    const key = this.key();
    const row = await this.load(admin.id);
    this.assertNotLocked(row, now);
    const pending = open(row.mfaPendingSecretEnc, key);
    const tokenStillValid = row.mfaEnrolmentTokenHash !== null && row.mfaEnrolmentExpiresAt !== null && row.mfaEnrolmentExpiresAt > now;
    if (!pending || !tokenStillValid) throw refuse(HttpStatus.CONFLICT, 'enrolment_not_started', 'Start the enrolment again with your enrolment token.');
    const step = verifyTotp(pending, code, now.getTime(), null);
    if (step === null) {
      await this.fail(row, admin, ip, now);
      throw refuse(HttpStatus.FORBIDDEN, 'mfa_code_invalid', 'That code did not match. Check the time on your phone and try the next code.');
    }
    const recoveryCodes = generateRecoveryCodes();
    await this.prisma.$transaction(async (tx) => {
      await tx.platformAdmin.update({
        where: { id: admin.id },
        data: {
          mfaSecretEnc: row.mfaPendingSecretEnc,
          mfaEnabledAt: now,
          mfaLastStep: BigInt(step),
          mfaPendingSecretEnc: null,
          mfaEnrolmentTokenHash: null,
          mfaEnrolmentExpiresAt: null,
          mfaFailedCount: 0,
          mfaLockedUntil: null,
        },
      });
      await this.replaceRecoveryCodes(tx, admin.id, recoveryCodes, key, now);
      await tx.platformAdminSession.update({ where: { id: sessionId }, data: { mfaVerifiedAt: now } });
    });
    await this.audit.record({ admin, action: 'admin.mfa.enrolled', targetType: 'PlatformAdmin', targetId: admin.id, targetLabel: admin.email, ip });
    return { recoveryCodes };
  }

  // ── Completing a sign-in ─────────────────────────────────────────────────

  async verify(admin: PlatformAdminIdentity, sessionId: Buffer, input: { code?: string; recoveryCode?: string }, ip: string | null, now = new Date()): Promise<void> {
    const key = this.key();
    const row = await this.load(admin.id);
    if (this.stateOf(row) !== 'required') throw refuse(HttpStatus.CONFLICT, 'mfa_enrolment_required', 'Set up your authenticator first, with the enrolment token from the server.');
    this.assertNotLocked(row, now);

    if (input.recoveryCode !== undefined) {
      const used = await this.useRecoveryCode(admin.id, input.recoveryCode, key, now);
      if (!used) {
        await this.fail(row, admin, ip, now);
        throw refuse(HttpStatus.FORBIDDEN, 'recovery_code_invalid', 'That recovery code is not valid, or was already used.');
      }
      await this.prisma.$transaction([
        this.prisma.platformAdminSession.update({ where: { id: sessionId }, data: { mfaVerifiedAt: now } }),
        this.prisma.platformAdmin.update({ where: { id: admin.id }, data: { mfaFailedCount: 0 } }),
      ]);
      const left = await this.prisma.platformAdminRecoveryCode.count({ where: { adminId: admin.id, usedAt: null, revokedAt: null } });
      await this.audit.record({ admin, action: 'admin.mfa.recovery_used', targetType: 'PlatformAdmin', targetId: admin.id, targetLabel: admin.email, after: { recoveryCodesLeft: left }, ip });
      return;
    }

    const step = this.checkCode(row, input.code ?? '', key, now);
    if (step === null) {
      await this.fail(row, admin, ip, now);
      throw refuse(HttpStatus.FORBIDDEN, 'mfa_code_invalid', 'That code did not match, or was already used. Wait for the next code.');
    }
    await this.prisma.$transaction([
      this.prisma.platformAdminSession.update({ where: { id: sessionId }, data: { mfaVerifiedAt: now } }),
      this.prisma.platformAdmin.update({ where: { id: admin.id }, data: { mfaLastStep: BigInt(step), mfaFailedCount: 0 } }),
    ]);
    await this.audit.record({ admin, action: 'admin.mfa.verified', targetType: 'PlatformAdmin', targetId: admin.id, targetLabel: admin.email, ip });
  }

  // ── Step-up ──────────────────────────────────────────────────────────────

  /** The password and a fresh code, recorded on THIS session for five minutes. */
  async stepUp(admin: PlatformAdminIdentity, sessionId: Buffer, password: string, code: string, ip: string | null, now = new Date()): Promise<{ expiresAt: Date }> {
    const key = this.key();
    const row = await this.load(admin.id);
    this.assertNotLocked(row, now);
    const passwordOk = await this.hashing.verify(row.passwordHash, password ?? '');
    const step = passwordOk ? this.checkCode(row, code ?? '', key, now) : null;
    if (!passwordOk || step === null) {
      await this.fail(row, admin, ip, now);
      throw refuse(HttpStatus.FORBIDDEN, 'step_up_failed', 'That password or code did not match.');
    }
    await this.prisma.$transaction([
      this.prisma.platformAdminSession.update({ where: { id: sessionId }, data: { stepUpAt: now } }),
      this.prisma.platformAdmin.update({ where: { id: admin.id }, data: { mfaLastStep: BigInt(step), mfaFailedCount: 0 } }),
    ]);
    await this.audit.record({ admin, action: 'admin.step_up', targetType: 'PlatformAdmin', targetId: admin.id, targetLabel: admin.email, ip });
    return { expiresAt: new Date(now.getTime() + STEP_UP_TTL_MS) };
  }

  /** Every high-impact action: a step-up on THIS session within the last five minutes. */
  async assertFreshStepUp(sessionId: Buffer | undefined, now = new Date()): Promise<void> {
    const session = sessionId ? await this.prisma.platformAdminSession.findUnique({ where: { id: sessionId }, select: { stepUpAt: true, mfaVerifiedAt: true, revokedAt: true } }) : null;
    const fresh = session && !session.revokedAt && session.mfaVerifiedAt && session.stepUpAt && now.getTime() - session.stepUpAt.getTime() <= STEP_UP_TTL_MS;
    if (!fresh) {
      throw new ForbiddenException({ code: 'step_up_required', message: 'Confirm with your password and a code from your authenticator to complete this action.' });
    }
  }

  /** A new set of recovery codes — after a fresh step-up; the old set stops working. */
  async regenerateRecoveryCodes(admin: PlatformAdminIdentity, sessionId: Buffer, ip: string | null, now = new Date()): Promise<{ recoveryCodes: string[] }> {
    const key = this.key();
    await this.assertFreshStepUp(sessionId, now);
    const recoveryCodes = generateRecoveryCodes();
    await this.prisma.$transaction(async (tx) => this.replaceRecoveryCodes(tx, admin.id, recoveryCodes, key, now));
    await this.audit.record({ admin, action: 'admin.mfa.recovery_regenerated', targetType: 'PlatformAdmin', targetId: admin.id, targetLabel: admin.email, ip });
    return { recoveryCodes };
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async load(adminId: Buffer): Promise<PlatformAdmin> {
    const row = await this.prisma.platformAdmin.findUnique({ where: { id: adminId } });
    if (!row || !row.isActive || row.deletedAt) throw new ForbiddenException('Not signed in');
    return row;
  }

  private checkCode(row: PlatformAdmin, code: string, key: Buffer, now: Date): number | null {
    const secret = open(row.mfaSecretEnc, key);
    if (!secret || !row.mfaEnabledAt) return null;
    return verifyTotp(secret, code, now.getTime(), row.mfaLastStep === null ? null : Number(row.mfaLastStep));
  }

  private assertNotLocked(row: PlatformAdmin, now: Date): void {
    if (row.mfaLockedUntil && row.mfaLockedUntil > now) {
      throw refuse(HttpStatus.TOO_MANY_REQUESTS, 'mfa_locked', 'Too many wrong codes. Try again later.', { retryAt: row.mfaLockedUntil.toISOString() });
    }
  }

  private async fail(row: PlatformAdmin, admin: PlatformAdminIdentity, ip: string | null, now: Date): Promise<void> {
    const failures = row.mfaFailedCount + 1;
    const locked = failures >= MFA_MAX_FAILURES;
    await this.prisma.platformAdmin.update({
      where: { id: row.id },
      data: locked ? { mfaFailedCount: 0, mfaLockedUntil: new Date(now.getTime() + MFA_LOCK_MS) } : { mfaFailedCount: failures },
    });
    await this.audit.record({ admin, action: locked ? 'admin.mfa.locked' : 'admin.mfa.failed', targetType: 'PlatformAdmin', targetId: admin.id, targetLabel: admin.email, after: { failures }, ip });
  }

  private async replaceRecoveryCodes(tx: Pick<PrismaService, 'platformAdminRecoveryCode'>, adminId: Buffer, codes: string[], key: Buffer, now: Date): Promise<void> {
    await tx.platformAdminRecoveryCode.updateMany({ where: { adminId, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
    for (const code of codes) {
      await tx.platformAdminRecoveryCode.create({ data: { id: newUuidV7Bin(), adminId, codeHash: keyedDigest(normaliseRecoveryCode(code), key) } });
    }
  }

  /** Spent atomically: of two requests racing with the same code, exactly one wins. */
  private async useRecoveryCode(adminId: Buffer, typed: string, key: Buffer, now: Date): Promise<boolean> {
    if (!looksLikeRecoveryCode(typed)) return false;
    const spent = await this.prisma.platformAdminRecoveryCode.updateMany({
      where: { adminId, codeHash: keyedDigest(normaliseRecoveryCode(typed), key), usedAt: null, revokedAt: null },
      data: { usedAt: now },
    });
    return spent.count === 1;
  }
}
