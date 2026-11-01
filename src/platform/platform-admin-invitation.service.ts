import { HttpException, HttpStatus, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../common/config/app-config.service';
import { HashingService } from '../common/security/hashing.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import { normaliseEmail } from '../auth/identifier';
import { PlatformAuditService } from './platform-audit.service';
import { ENROLMENT_TOKEN_TTL_MS } from './platform-mfa.service';
import { keyedDigest, parseMfaKey } from './mfa/secret-box';

/**
 * A second platform administrator, invited (0115; the owner's brief of 2026-11-01).
 *
 * Nobody chooses the invited person's password but them, and nobody else's account is ever touched:
 *
 *  - **Issued on the server only** (`prisma/platform-admin-invitation.ts`, through `deploy/production/
 *    admin-invitation.sh`). No HTTP route creates, resumes or revokes an invitation.
 *  - **An explicit state**, not an unknown password or a missing factor: `invited` cannot sign in at all; `enrolling`
 *    signs in to the two enrolment routes only (`PlatformAdminGuard`, `PlatformMfaController`); `active` is every
 *    other administrator. `issue`, `resume` and `revoke` refuse an `active` row, whoever it is.
 *  - **The setup code**: 24 hours, single use, a keyed digest only (HMAC-SHA256 under PLATFORM_MFA_KEY in this
 *    purpose's own domain). Spending it is one conditional update — still `invited`, the same digest, not expired —
 *    so two tries at once spend it once.
 *  - **Spending it** sets the password the person chose and issues a fresh enrolment token (30 minutes) to that one
 *    answer only; the account stays `enrolling` until the authenticator's first code is confirmed, and becomes
 *    `active` in that same transaction (`PlatformMfaService.confirmEnrolment`).
 *  - **One refusal for everything** — no such address, a wrong, spent or expired code, an active account — so the
 *    route cannot tell anybody whether an address, a code or an administrator exists; throttled per address.
 *  - **Audited**: issue, resume, revocation, use, expiry seen at redemption, refusal, activation. Never the code, a
 *    password, a secret or a recovery code.
 */
export const ADMIN_SETUP_CODE_TTL_MS = 24 * 60 * 60 * 1000;
export const ADMIN_PASSWORD_MIN = 12;
const DOMAIN = 'dukan-erp/admin-setup/v1';

export type AdminState = 'invited' | 'enrolling' | 'active';

export interface IssuedInvitation {
  adminId: string;
  /** Returned to the server CLI once, to be written to its handover file. Never stored, never logged. */
  code: string;
  expiresAt: Date;
}

/** The one answer a refused setup gets, whatever the reason. */
export const SETUP_REFUSED = () =>
  new HttpException({ code: 'admin_setup_refused', message: 'That setup could not be completed. Check the address and the code, or ask for a new code.' }, HttpStatus.BAD_REQUEST);

@Injectable()
export class PlatformAdminInvitationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly hashing: HashingService,
    private readonly audit: PlatformAuditService,
  ) {}

  private key(): Buffer {
    const key = parseMfaKey(this.config.platformMfaKey);
    if (!key) throw new ServiceUnavailableException({ code: 'mfa_unavailable', message: 'Administrator MFA is not configured on this server.' });
    return key;
  }

  private digest(code: string, key: Buffer): string {
    return keyedDigest(`${DOMAIN}:${code}`, key);
  }

  private newCode(): string {
    return randomBytes(24).toString('base64url');
  }

  // ── The server CLI ─────────────────────────────────────────────────────────

  /**
   * Invite a new administrator. Refuses an address that exists in ANY state — active, invited, enrolling, disabled,
   * deleted — and so never updates, resets or signs out anybody.
   */
  async issue(input: { email: string; name: string }, now = new Date()): Promise<IssuedInvitation> {
    const key = this.key();
    const email = normaliseEmail(input.email);
    const name = input.name.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('That does not look like an email address.');
    if (!name || name.length > 160) throw new Error('Give the administrator a name of 1 to 160 characters.');
    const existing = await this.prisma.platformAdmin.findUnique({ where: { email }, select: { id: true } });
    if (existing) throw new Error(`An administrator account with ${email} already exists, in some state. Nothing was changed.`);

    const id = newUuidV7Bin();
    const code = this.newCode();
    const expiresAt = new Date(now.getTime() + ADMIN_SETUP_CODE_TTL_MS);
    // A password nobody knows, as defence in depth only: the state already keeps an invited account out.
    const passwordHash = await this.hashing.hash(randomBytes(48).toString('base64url'));
    await this.prisma.$transaction(async (tx) => {
      await tx.platformAdmin.create({
        data: { id, email, name, passwordHash, adminState: 'invited', setupCodeHash: this.digest(code, key), setupCodeExpiresAt: expiresAt },
      });
      await this.audit.record(
        { admin: null, actor: 'cli', action: 'admin.invitation.issued', targetType: 'PlatformAdmin', targetId: id, targetLabel: email, reason: `Setup code valid until ${expiresAt.toISOString()}` },
        tx,
      );
    });
    return { adminId: id.toString('hex'), code, expiresAt };
  }

  /**
   * A new setup code for an invitation that is still `invited` or `enrolling` — an expired code, an abandoned
   * enrolment. Back to `invited`: the old code, any enrolment token, pending secret and session go. Refuses an
   * `active` account: this never resets an administrator.
   */
  async resume(emailRaw: string, now = new Date()): Promise<IssuedInvitation> {
    const key = this.key();
    const email = normaliseEmail(emailRaw);
    const row = await this.prisma.platformAdmin.findUnique({ where: { email } });
    if (!row || row.deletedAt || !row.isActive || row.adminState === 'active') {
      throw new Error(`No open invitation for ${email}. An active administrator is never reset here. Nothing was changed.`);
    }
    const code = this.newCode();
    const expiresAt = new Date(now.getTime() + ADMIN_SETUP_CODE_TTL_MS);
    await this.prisma.$transaction(async (tx) => {
      const n = await tx.platformAdmin.updateMany({
        where: { id: row.id, adminState: { in: ['invited', 'enrolling'] }, deletedAt: null },
        data: {
          adminState: 'invited',
          setupCodeHash: this.digest(code, key),
          setupCodeExpiresAt: expiresAt,
          passwordHash: await this.hashing.hash(randomBytes(48).toString('base64url')),
          mfaPendingSecretEnc: null,
          mfaEnrolmentTokenHash: null,
          mfaEnrolmentExpiresAt: null,
        },
      });
      if (n.count !== 1) throw new Error('The invitation changed meanwhile. Nothing was changed.');
      await tx.platformAdminSession.updateMany({ where: { adminId: row.id, revokedAt: null }, data: { revokedAt: now } });
      await this.audit.record(
        { admin: null, actor: 'cli', action: 'admin.invitation.resumed', targetType: 'PlatformAdmin', targetId: row.id, targetLabel: email, reason: `Setup code valid until ${expiresAt.toISOString()}` },
        tx,
      );
    });
    return { adminId: row.id.toString('hex'), code, expiresAt };
  }

  /** Withdraw an invitation that is not yet active: the account is disabled and deleted, its code void. */
  async revoke(emailRaw: string, now = new Date()): Promise<void> {
    const email = normaliseEmail(emailRaw);
    const row = await this.prisma.platformAdmin.findUnique({ where: { email } });
    if (!row || row.deletedAt || row.adminState === 'active') {
      throw new Error(`No open invitation for ${email}. An active administrator is never revoked here. Nothing was changed.`);
    }
    await this.prisma.$transaction(async (tx) => {
      // The CHECK keeps a code only while invited: the row leaves `invited` for good, inactive and deleted.
      const n = await tx.platformAdmin.updateMany({
        where: { id: row.id, adminState: { in: ['invited', 'enrolling'] }, deletedAt: null },
        data: { adminState: 'enrolling', setupCodeHash: null, setupCodeExpiresAt: null, isActive: false, deletedAt: now, mfaPendingSecretEnc: null, mfaEnrolmentTokenHash: null, mfaEnrolmentExpiresAt: null },
      });
      if (n.count !== 1) throw new Error('The invitation changed meanwhile. Nothing was changed.');
      await tx.platformAdminSession.updateMany({ where: { adminId: row.id, revokedAt: null }, data: { revokedAt: now } });
      await this.audit.record({ admin: null, actor: 'cli', action: 'admin.invitation.revoked', targetType: 'PlatformAdmin', targetId: row.id, targetLabel: email }, tx);
    });
  }

  /** Whether the invitation behind a handover file still needs it: `pending` until spent, expired or revoked. */
  async status(adminIdHex: string, now = new Date()): Promise<'pending' | 'done'> {
    if (!/^[0-9a-f]{32}$/.test(adminIdHex)) return 'done';
    const row = await this.prisma.platformAdmin.findUnique({
      where: { id: Buffer.from(adminIdHex, 'hex') },
      select: { adminState: true, setupCodeExpiresAt: true, deletedAt: true },
    });
    return row && !row.deletedAt && row.adminState === 'invited' && row.setupCodeExpiresAt && row.setupCodeExpiresAt > now ? 'pending' : 'done';
  }

  // ── The public setup route ─────────────────────────────────────────────────

  /**
   * Spend the setup code: the person's own password, and a fresh enrolment token for this answer only. Every
   * refusal is the same refusal, and every path spends one Argon2 hash, so neither the answer nor its time tells an
   * existing address from an unknown one.
   */
  async redeem(input: { email: string; code: string; password: string }, ip: string | null, now = new Date()): Promise<{ enrolmentToken: string; expiresAt: Date }> {
    const key = this.key();
    const email = normaliseEmail(input.email);
    const typed = typeof input.code === 'string' ? input.code.trim() : '';
    const passwordHash = await this.hashing.hash(input.password);
    if (input.password.length < ADMIN_PASSWORD_MIN) throw SETUP_REFUSED();

    const row = await this.prisma.platformAdmin.findUnique({ where: { email } });
    const digest = this.digest(typed, key);
    const matches =
      row !== null &&
      row.setupCodeHash !== null &&
      row.setupCodeHash.length === digest.length &&
      timingSafeEqual(Buffer.from(row.setupCodeHash), Buffer.from(digest));
    if (!row || row.adminState !== 'invited' || row.deletedAt || !row.isActive || !matches) {
      if (row && row.adminState === 'invited') {
        await this.audit.record({ admin: null, actor: 'public', action: 'admin.invitation.refused', targetType: 'PlatformAdmin', targetId: row.id, targetLabel: row.email, ip });
      }
      throw SETUP_REFUSED();
    }
    if (!row.setupCodeExpiresAt || row.setupCodeExpiresAt <= now) {
      await this.audit.record({ admin: null, actor: 'public', action: 'admin.invitation.expired', targetType: 'PlatformAdmin', targetId: row.id, targetLabel: row.email, ip });
      throw SETUP_REFUSED();
    }

    const enrolmentToken = this.newCode();
    const expiresAt = new Date(now.getTime() + ENROLMENT_TOKEN_TTL_MS);
    const spent = await this.prisma.$transaction(async (tx) => {
      // Claimed by its own state: a second try — the same code at the same time — finds nothing to update.
      const n = await tx.platformAdmin.updateMany({
        where: { id: row.id, adminState: 'invited', setupCodeHash: digest, setupCodeExpiresAt: { gt: now }, deletedAt: null, isActive: true },
        data: {
          adminState: 'enrolling',
          setupCodeHash: null,
          setupCodeExpiresAt: null,
          passwordHash,
          mfaSecretEnc: null,
          mfaEnabledAt: null,
          mfaPendingSecretEnc: null,
          mfaEnrolmentTokenHash: keyedDigest(enrolmentToken, key),
          mfaEnrolmentExpiresAt: expiresAt,
          mfaFailedCount: 0,
          mfaLockedUntil: null,
        },
      });
      if (n.count !== 1) return false;
      await this.audit.record({ admin: null, actor: 'public', action: 'admin.invitation.used', targetType: 'PlatformAdmin', targetId: row.id, targetLabel: row.email, ip }, tx);
      return true;
    });
    if (!spent) throw SETUP_REFUSED();
    return { enrolmentToken, expiresAt };
  }
}
