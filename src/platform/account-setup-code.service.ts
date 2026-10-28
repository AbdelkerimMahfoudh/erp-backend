import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHmac, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../common/config/app-config.service';
import { HashingService } from '../common/security/hashing.service';
import { SessionsService } from '../auth/sessions.service';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { actorRef } from '../common/privacy/audit-contact';
import { StaffActivationService } from './staff-activation.service';
import { PlatformAuditService } from './platform-audit.service';
import type { PlatformAdminIdentity } from './platform-admin.service';

/**
 * One-time setup codes for accounts a platform administrator provisions (0109, D224, docs/109 §2.2).
 *
 * The administrator never chooses, sets or sees a password: the account is created with one nobody knows, and the
 * person spends this code, once, to choose their own — through the same doors an Owner's setup invitation uses
 * (`auth/owner-setup` in the app, the website's accept route), under the same throttle and the same refusal.
 *
 *  - only an HMAC-SHA256 of the code is stored, under STAFF_INVITATION_KEY in this purpose's own domain;
 *  - 72 hours; single use, claimed by its own unspent state; one live code per person (a UNIQUE generated column);
 *  - issuing a new one revokes the old, in the same transaction;
 *  - every issue, reissue, use, expiry seen at redemption and revocation is audited — never the code.
 *
 * Spending it sets the password, signs out anything signed in before, and activates a staff account when its stores
 * hold a seat for it (`StaffActivationService`, behind the subscription lock). It grants nothing else.
 */

export const ACCOUNT_SETUP_CODE_TTL_MS = 72 * 60 * 60 * 1000;
const DOMAIN = 'dukan-erp/account-setup/v1';

export interface IssuedSetupCode {
  /** Returned once. Never stored, never logged. */
  token: string;
  expiresAt: string;
  /** Always `manual`: the administrator passes it on. Nothing is sent to anybody. */
  delivery: 'manual';
}

export type SetupCodeOutcome =
  | { spent: true; companyId: Buffer; userId: Buffer; business: string; publicStoreId: string; activated: boolean }
  | { spent: false; reason: 'unknown' | 'expired' | 'unusable' };

@Injectable()
export class AccountSetupCodeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly hashing: HashingService,
    private readonly sessions: SessionsService,
    private readonly activation: StaffActivationService,
    private readonly audit: PlatformAuditService,
  ) {}

  private key(): string {
    const key = this.config.staffInvitationKey;
    if (!key) throw new ServiceUnavailableException({ code: 'setup_codes_unavailable', message: 'Setup codes are not configured on this server.' });
    return key;
  }

  hash(token: string, key = this.key()): string {
    return createHmac('sha256', key).update(`${DOMAIN}\n${token}`).digest('hex');
  }

  /**
   * Issue a code for this person in the caller's transaction, revoking any live one (`reissued`). The clear code leaves
   * only in the answer. The audit is the caller's to write after the commit (`recordIssue`), with what it knows.
   */
  async issueTx(tx: Prisma.TransactionClient, p: { companyId: Buffer; userId: Buffer; issuedBy: string; now: Date }): Promise<IssuedSetupCode & { replaced: number }> {
    const key = this.key();
    const replaced = await tx.accountSetupCode.updateMany({
      where: { userId: p.userId, usedAt: null, revokedAt: null },
      data: { revokedAt: p.now, revokedReason: 'reissued' },
    });
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(p.now.getTime() + ACCOUNT_SETUP_CODE_TTL_MS);
    await tx.accountSetupCode.create({
      data: { id: newUuidV7Bin(), companyId: p.companyId, userId: p.userId, tokenHash: this.hash(token, key), issuedBy: p.issuedBy.slice(0, 160), expiresAt, createdAt: p.now },
    });
    return { token, expiresAt: expiresAt.toISOString(), delivery: 'manual', replaced: replaced.count };
  }

  async recordIssue(ctx: { admin: PlatformAdminIdentity; ip?: string | null }, p: { companyId: Buffer; company: string; userId: Buffer; replaced: number; expiresAt: string; reason?: string | null }): Promise<void> {
    await this.audit.record({
      admin: ctx.admin,
      action: p.replaced > 0 ? 'account_setup_code.reissue' : 'account_setup_code.issue',
      targetType: 'Company',
      targetId: p.companyId,
      targetLabel: p.company,
      reason: p.reason ?? null,
      after: { person: actorRef(binToUuid(p.userId)), expiresAt: p.expiresAt, replaced: p.replaced, delivery: 'manual', outcome: 'issued' },
      ip: ctx.ip ?? null,
    });
  }

  /** Revoke this person's live code, in the caller's transaction. True when there was one. */
  async revokeTx(tx: Prisma.TransactionClient, userId: Buffer, reason: 'revoked' | 'cancelled', now: Date): Promise<boolean> {
    const moved = await tx.accountSetupCode.updateMany({ where: { userId, usedAt: null, revokedAt: null }, data: { revokedAt: now, revokedReason: reason } });
    return moved.count > 0;
  }

  /**
   * Spend a code: the person's own password. `spent: false` for every unusable code; the caller answers all of them
   * with one refusal. Two redemptions of one code at the same instant have one winner (the claim is conditional on the
   * code's unspent state, and the password is written in the same transaction).
   */
  async spend(token: string, password: string, meta: { ip?: string | null }, now = new Date()): Promise<SetupCodeOutcome> {
    if (!token || !this.config.staffInvitationKey) return { spent: false, reason: 'unknown' };
    const tokenHash = this.hash(token);
    const row = await this.prisma.accountSetupCode.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        companyId: true,
        userId: true,
        expiresAt: true,
        usedAt: true,
        revokedAt: true,
        user: { select: { deletedAt: true, invitedAt: true } },
        company: { select: { name: true, publicStoreId: true, isActive: true, closedAt: true } },
      },
    });
    if (!row) return { spent: false, reason: 'unknown' };
    if (row.usedAt || row.revokedAt || row.user.deletedAt || !row.company.isActive || row.company.closedAt) {
      await this.recordRedemption(row.companyId, row.company.name, row.userId, 'refused', meta.ip);
      return { spent: false, reason: 'unusable' };
    }
    if (row.expiresAt <= now) {
      await this.recordRedemption(row.companyId, row.company.name, row.userId, 'expired', meta.ip);
      return { spent: false, reason: 'expired' };
    }

    const passwordHash = await this.hashing.hash(password);
    const won = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.accountSetupCode.updateMany({
        where: { id: row.id, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) return false;
      await tx.user.update({ where: { id: row.userId }, data: { passwordHash } });
      return true;
    });
    if (!won) {
      await this.recordRedemption(row.companyId, row.company.name, row.userId, 'refused', meta.ip);
      return { spent: false, reason: 'unusable' };
    }
    // A password nobody knew is now a password one person knows: anything signed in before was not that person.
    await this.sessions.revokeAll(row.userId);
    const actor = actorRef(binToUuid(row.userId));
    // A staff account becomes usable once its stores hold a seat; an Owner's account already is.
    const activated = row.user.invitedAt ? (await this.activation.tryActivate(row.userId, actor)).activated : true;
    await this.recordRedemption(row.companyId, row.company.name, row.userId, 'used', meta.ip, activated);
    return { spent: true, companyId: row.companyId, userId: row.userId, business: row.company.name, publicStoreId: row.company.publicStoreId, activated };
  }

  private async recordRedemption(companyId: Buffer, company: string, userId: Buffer, outcome: 'used' | 'expired' | 'refused', ip?: string | null, activated?: boolean): Promise<void> {
    await this.audit.record({
      admin: null,
      actor: actorRef(binToUuid(userId)),
      action: outcome === 'used' ? 'account_setup_code.use' : outcome === 'expired' ? 'account_setup_code.expire' : 'account_setup_code.refused',
      targetType: 'Company',
      targetId: companyId,
      targetLabel: company,
      after: { person: actorRef(binToUuid(userId)), outcome, ...(activated === undefined ? {} : { activated }) },
      ip: ip ?? null,
    });
  }
}
