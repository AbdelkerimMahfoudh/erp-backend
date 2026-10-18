import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { HashingService } from '../common/security/hashing.service';
import { SessionsService } from '../auth/sessions.service';
import { binToUuid, isUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { PlatformAuditService } from './platform-audit.service';
import type { PlatformAdminIdentity } from './platform-admin.service';

/**
 * How a business's Owner gets their first password (0075).
 *
 * A platform administrator can create a business for a shop that never filled
 * the form — over the phone, at the counter. That Owner needs a password, and
 * the one thing this must never become is an administrator typing a password
 * into a chat. So the business is created with a password nobody knows, and
 * the administrator is handed a one-time invitation instead. The Owner spends
 * it, once, to set their own.
 *
 * Only the hash of the invitation is stored — exactly like a session token —
 * so a leaked database hands nobody a working key. It expires in three days,
 * it is spent atomically, and issuing a new one revokes every unspent one, so
 * "I lost it" has one answer and no loose keys.
 *
 * **Delivery is manual, and the response says so.** No message provider is
 * configured (see docs/37), and pretending an invitation was sent when nothing
 * sent it is the failure the contact-verification work already refused. The
 * administrator passes it on themselves, through whatever channel they and
 * the Owner already share.
 *
 * Accepting an invitation grants nothing beyond the password. Entitlement is
 * the subscription's decision, and this does not touch it.
 */

export const OWNER_INVITATION_TTL_HOURS = 72;
/** The tenant minimum. Registration asks for the same; nothing shorter is invented here. */
export const OWNER_PASSWORD_MIN_LENGTH = 8;

export interface IssuedInvitation {
  /** Returned once. Never stored, never logged. */
  token: string;
  expiresAt: Date;
  owner: { name: string; destinationMasked: string | null };
  /** Always `manual`: the administrator passes the invitation on. */
  delivery: 'manual';
  /** Unspent invitations this one replaced. */
  replaced: number;
}

/** Enough to recognise the address, not enough to learn it. */
function maskDestination(value: string | null): string | null {
  if (!value) return null;
  const at = value.indexOf('@');
  if (at > 0) return value.slice(0, Math.min(2, at)) + '***' + value.slice(at);
  return value.length > 4 ? '***' + value.slice(-4) : '***';
}

@Injectable()
export class OwnerInvitationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly sessions: SessionsService,
    private readonly audit: PlatformAuditService,
  ) {}

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Mint an invitation for the business's Owner, revoking any still unspent. */
  async issue(
    companyUuid: string,
    ctx: { admin: PlatformAdminIdentity; ip?: string | null; reason?: string | null },
  ): Promise<IssuedInvitation> {
    if (!isUuid(companyUuid)) throw new BadRequestException('Unknown business');
    const companyId = uuidToBin(companyUuid);

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true, name: true },
    });
    if (!company) throw new NotFoundException('Unknown business');

    // The Owner is the account the business was created with.
    const owner = await this.prisma.user.findFirst({
      where: { companyId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, email: true, phone: true, isActive: true },
    });
    if (!owner || !owner.isActive) {
      throw new BadRequestException('This business has no active Owner to invite.');
    }

    const now = new Date();
    const replaced = await this.prisma.ownerInvitation.updateMany({
      where: { companyId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + OWNER_INVITATION_TTL_HOURS * 60 * 60 * 1000);
    await this.prisma.ownerInvitation.create({
      data: {
        id: newUuidV7Bin(),
        companyId,
        userId: owner.id,
        tokenHash: this.hashToken(token),
        issuedBy: ctx.admin.email,
        expiresAt,
      },
    });

    await this.audit.record({
      admin: ctx.admin,
      action: 'owner_invitation.issue',
      targetType: 'Company',
      targetId: companyId,
      targetLabel: company.name,
      reason: ctx.reason ?? null,
      // The token is not here, and `redact` would strip it if it were.
      after: {
        owner: owner.name,
        expiresAt: expiresAt.toISOString(),
        replaced: replaced.count,
        delivery: 'manual',
      },
      ip: ctx.ip ?? null,
    });

    return {
      token,
      expiresAt,
      owner: { name: owner.name, destinationMasked: maskDestination(owner.email ?? owner.phone) },
      delivery: 'manual',
      replaced: replaced.count,
    };
  }

  /**
   * Spend an invitation: the Owner sets their password.
   *
   * One refusal for every failure — unknown, expired, spent, revoked, or an
   * Owner since deactivated — so the public route cannot be used to tell live
   * invitations from dead ones. The row is claimed by its own unspent state, so
   * two accepts of one token produce one winner.
   */
  async accept(
    token: string,
    password: string,
    meta: { ip?: string | null },
  ): Promise<{ publicStoreId: string; businessName: string }> {
    if (!password || password.length < OWNER_PASSWORD_MIN_LENGTH) {
      throw new BadRequestException(`Use a password of at least ${OWNER_PASSWORD_MIN_LENGTH} characters.`);
    }
    const refuse = () => new BadRequestException('That invitation cannot be used.');
    if (!token) throw refuse();

    const now = new Date();
    const invitation = await this.prisma.ownerInvitation.findFirst({
      where: { tokenHash: this.hashToken(token), acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
      select: {
        id: true,
        companyId: true,
        userId: true,
        user: { select: { isActive: true, deletedAt: true } },
        company: { select: { name: true, publicStoreId: true } },
      },
    });
    if (!invitation || !invitation.user.isActive || invitation.user.deletedAt) throw refuse();

    const passwordHash = await this.hashing.hash(password);

    const claimed = await this.prisma.ownerInvitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: now },
    });
    if (claimed.count !== 1) throw refuse();

    await this.prisma.user.update({ where: { id: invitation.userId }, data: { passwordHash } });
    // A password nobody knew is now a password one person knows. Anything
    // signed in before this moment was not that person.
    await this.sessions.revokeAll(invitation.userId);

    await this.audit.record({
      admin: null,
      actor: `owner:${binToUuid(invitation.userId)}`,
      action: 'owner_invitation.accept',
      targetType: 'Company',
      targetId: invitation.companyId,
      targetLabel: invitation.company.name,
      after: { acceptedAt: now.toISOString() },
      ip: meta.ip ?? null,
    });

    return { publicStoreId: invitation.company.publicStoreId, businessName: invitation.company.name };
  }
}
