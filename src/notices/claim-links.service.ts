import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';

/**
 * The account-ready message's portal link (post-Build-4, 0129; the owner's brief of 2026-11-03).
 *
 * - **Opaque**: 256 random bits, base64url. It names no business, no person and no number; only its SHA-256 is stored.
 * - **Short-lived and single-use**: {@link CLAIM_LINK_TTL_MS}, then refused; spent by a conditional write inside the
 *   transaction that opens the portal session, so two taps can never both open one.
 * - **Reissued, never stranded**: a new message's link revokes the earlier messages' — the message resent from the
 *   portal or the console; a delayed delivery's retry adds one beside its own. A business closed or deleted has every
 *   link revoked.
 * - **Buys one thing**: a normal portal session for the business's Owner. The free trial is still claimed on the page by
 *   that Owner, and starts then; later payments use that session, never the link.
 *
 * The raw token exists only in the message sent and in the request redeeming it: never in a row, a log line or an audit.
 */
export const CLAIM_LINK_TTL_MS = 72 * 60 * 60 * 1000;

/** A link's shape: what a redeeming request may carry at all, checked before any database read. */
export const CLAIM_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type ClaimRefusal = 'invalid' | 'expired' | 'used';

export const hashClaimToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

@Injectable()
export class ClaimLinkService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A new link for the business's Owner. The open links of any other message are revoked in the same transaction; a
   * retry of the same message keeps its earlier link valid too, in case that attempt did reach the phone.
   */
  async issue(p: { companyId: Buffer; userId: Buffer; noticeId?: Buffer | null }, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + CLAIM_LINK_TTL_MS);
    await this.prisma.$transaction(async (tx) => {
      const others = p.noticeId ? { OR: [{ noticeId: null }, { noticeId: { not: p.noticeId } }] } : {};
      await tx.portalClaimLink.updateMany({ where: { companyId: p.companyId, usedAt: null, revokedAt: null, ...others }, data: { revokedAt: now } });
      await tx.portalClaimLink.create({ data: { id: newUuidV7Bin(), companyId: p.companyId, userId: p.userId, noticeId: p.noticeId ?? null, tokenHash: hashClaimToken(token), expiresAt, createdAt: now } });
    });
    return { token, expiresAt };
  }

  /**
   * Spend a link and run `open` — the portal session's creation — in the same transaction: the link is spent only if
   * the session is opened, and of two concurrent redemptions exactly one does both.
   */
  async redeem<T>(
    token: string,
    open: (tx: Prisma.TransactionClient, link: { companyId: Buffer; userId: Buffer }) => Promise<T>,
    now = new Date(),
  ): Promise<{ ok: true; result: T } | { ok: false; reason: ClaimRefusal }> {
    if (typeof token !== 'string' || !CLAIM_TOKEN_PATTERN.test(token)) return { ok: false, reason: 'invalid' };
    const tokenHash = hashClaimToken(token);
    const link = await this.prisma.portalClaimLink.findUnique({ where: { tokenHash } });
    if (!link || link.revokedAt) return { ok: false, reason: 'invalid' };
    if (link.usedAt) return { ok: false, reason: 'used' };
    if (link.expiresAt <= now) return { ok: false, reason: 'expired' };
    return this.prisma.$transaction(async (tx) => {
      const spent = await tx.portalClaimLink.updateMany({ where: { id: link.id, usedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
      if (spent.count !== 1) return { ok: false as const, reason: 'used' as const };
      return { ok: true as const, result: await open(tx, { companyId: link.companyId, userId: link.userId }) };
    });
  }

  /** Every open link of a business revoked: it was closed, prepared for deletion or deleted. */
  revokeAll(tx: Prisma.TransactionClient, companyId: Buffer, now: Date) {
    return tx.portalClaimLink.updateMany({ where: { companyId, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
  }
}
