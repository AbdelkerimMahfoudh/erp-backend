import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../common/config/app-config.service';
import { binToUuid, isUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { AuditService } from '../common/audit/audit.service';
import { AcquisitionService } from './acquisition.service';
import { referralLink, signReferralToken } from './referral-token';

/**
 * "Invite someone to Dukan ERP" (0103, D221): a signed-in Owner, Manager or Employee shares a link that lets somebody
 * register their own business. Not an employee invitation, not a setup code, not a promoter: the link opens the
 * ordinary registration, and a business registered through it is attributed to the inviting business — the person who
 * made the link is kept for the audit only.
 *
 * One live link per person and language, made on first use and handed back after that, until its maker revokes it. No
 * recipient is ever recorded — the person shares it with their phone's own share sheet, and Dukan ERP sends nothing.
 * The inviter is shown their own links and nothing else: not who registered through them, nor how many.
 */

export type InvitationLanguage = 'en' | 'fr' | 'ar';

export interface InvitingUser {
  companyId: Buffer;
  userId: Buffer;
}

@Injectable()
export class ReferralInvitationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly acquisition: AcquisitionService,
    private readonly audit: AuditService,
  ) {}

  /** This person's live links, one per language at most. Never another person's, never another business's. */
  async mine(user: InvitingUser) {
    const key = this.config.referralKey;
    const rows = await this.prisma.referralInvitation.findMany({
      where: { companyId: user.companyId, createdByUserId: user.userId, revokedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, publicRef: true, language: true, createdAt: true },
    });
    return { invitations: key && this.config.portalOrigin ? rows.map((r) => this.view(key, r)) : [] };
  }

  /** The person's live link in this language: the existing one, or a new one. */
  async createOrGet(user: InvitingUser, language: InvitationLanguage) {
    const key = this.acquisition.requireReferralKey();
    this.requirePortal();
    const existing = await this.live(user, language);
    if (existing) return this.view(key, existing);

    const id = newUuidV7Bin();
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.referralInvitation.create({
          data: { id, publicRef: randomBytes(16), companyId: user.companyId, createdByUserId: user.userId, language },
        });
        await this.audit.recordTx(tx as never, { entityType: 'referral_invitation', entityId: id, action: 'create', after: { language } });
      });
    } catch (e) {
      // Two taps at once: the one-live-per-person-and-language key let one through; the other hands that one back.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await this.live(user, language);
        if (winner) return this.view(key, winner);
      }
      throw e;
    }
    return this.view(key, (await this.live(user, language))!);
  }

  /** Stop a link: it opens nothing from now on. Only the person who made it can; a business it already brought keeps its attribution. */
  async revoke(user: InvitingUser, id: string) {
    if (!isUuid(id)) throw new NotFoundException('No such invitation.');
    const invitationId = uuidToBin(id);
    const done = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM referral_invitations WHERE id = ${invitationId} FOR UPDATE`);
      const row = await tx.referralInvitation.findFirst({
        where: { id: invitationId, companyId: user.companyId, createdByUserId: user.userId },
        select: { revokedAt: true, language: true },
      });
      if (!row) return false;
      if (row.revokedAt) return true;
      await tx.referralInvitation.update({ where: { id: invitationId }, data: { revokedAt: new Date(), revokedByUserId: user.userId } });
      await this.audit.recordTx(tx as never, { entityType: 'referral_invitation', entityId: invitationId, action: 'status_change', after: { revoked: true, language: row.language } });
      return true;
    });
    if (!done) throw new NotFoundException('No such invitation.');
    return { revoked: true };
  }

  private live(user: InvitingUser, language: InvitationLanguage) {
    return this.prisma.referralInvitation.findFirst({
      where: { companyId: user.companyId, createdByUserId: user.userId, language, revokedAt: null },
      select: { id: true, publicRef: true, language: true, createdAt: true },
    });
  }

  private view(key: string, row: { id: Buffer; publicRef: Buffer; language: string; createdAt: Date }) {
    const token = signReferralToken(key, { kind: 'user_invite', ref: row.publicRef, version: 0 });
    return { id: binToUuid(row.id), language: row.language as InvitationLanguage, createdAt: row.createdAt.toISOString(), link: referralLink(this.config.portalOrigin, token) };
  }

  private requirePortal(): void {
    if (!this.config.portalOrigin) {
      throw new ServiceUnavailableException({ code: 'referral_links_unavailable', message: 'Registration links cannot be made on this server: PORTAL_ORIGIN is not configured.' });
    }
  }
}
