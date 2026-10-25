import { BadRequestException, ConflictException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../common/config/app-config.service';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { LookupLimiter } from './lookup-limiter';
import { normalisePromoCode } from './promo-code';
import { verifyReferralToken } from './referral-token';

/**
 * Where a self-registered business came from (0103, D221): a promoter — by their six-digit code or their QR link — or
 * another business's invitation. Attribution and factual counts only: who brought a registration, and how many.
 *
 * Three things happen here:
 *
 *  - **public lookups** — a code or a link, before registering: usable or not, and the promoter's display name. One
 *    answer for every kind of unusable (unknown, retired, deactivated, revoked, tampered), so the lifecycle of a code is
 *    never told to a stranger; and every unusable answer spends one of the caller's few wrong guesses
 *    ({@link LookupLimiter});
 *  - **the attribution**, inside the registration's own transaction: the source is checked again there, and the
 *    business and its one original attribution commit or roll back together. A source that stopped being usable since
 *    the lookup refuses the registration with `acquisition_unavailable` and saves nothing — it is never silently
 *    attributed to somebody else, nor silently dropped;
 *  - **reporting** for the platform administrator.
 */

/** What a registration may carry: at most one source. */
export interface AcquisitionClaim {
  promoCode?: string;
  referralToken?: string;
}

export type LookupAnswer =
  | { usable: false }
  | { usable: true; source: 'promoter'; promoterName: string; code: string }
  | { usable: true; source: 'user_invite' };

export type AcquisitionSource = 'promoter' | 'user_invite';
export type AcquisitionMechanism = 'promo_code' | 'promoter_qr' | 'user_invite';

const UNUSABLE: LookupAnswer = { usable: false };

/** A registration's source stopped being usable between the lookup and the submission: nothing was saved. */
export class AcquisitionUnavailableException extends ConflictException {
  constructor(readonly source: AcquisitionSource) {
    super({
      code: 'acquisition_unavailable',
      source,
      message:
        source === 'promoter'
          ? 'This promo code is unavailable. Remove it to create your business. Nothing was saved.'
          : 'This invitation is no longer available. Continue without it to create your business. Nothing was saved.',
    });
  }
}

/** The facts a promoter's code is usable on: its promoter active, the code its current one and not retired. */
export function promoterCodeUsable(code: { id: Buffer; retiredAt: Date | null; promoter: { isActive: boolean; currentCodeId: Buffer | null } }): boolean {
  return code.retiredAt === null && code.promoter.isActive && code.promoter.currentCodeId !== null && code.promoter.currentCodeId.equals(code.id);
}

/** An invitation is usable while it is not revoked, its business is open and the person who made it still works there. */
export function invitationUsable(invitation: {
  revokedAt: Date | null;
  company: { isActive: boolean; closedAt: Date | null };
  createdBy: { isActive: boolean; deletedAt: Date | null };
}): boolean {
  return (
    invitation.revokedAt === null &&
    invitation.company.isActive &&
    invitation.company.closedAt === null &&
    invitation.createdBy.isActive &&
    invitation.createdBy.deletedAt === null
  );
}

const CODE_FACTS = {
  id: true,
  promoterId: true,
  code: true,
  version: true,
  retiredAt: true,
  promoter: { select: { id: true, displayName: true, isActive: true, currentCodeId: true } },
} as const;

const INVITATION_FACTS = {
  id: true,
  companyId: true,
  createdByUserId: true,
  revokedAt: true,
  company: { select: { isActive: true, closedAt: true } },
  createdBy: { select: { isActive: true, deletedAt: true } },
} as const;

type Db = Prisma.TransactionClient | PrismaService;

/** One resolved source, ready to be written. */
type Resolved =
  | { source: 'promoter'; mechanism: 'promo_code' | 'promoter_qr'; promoterId: Buffer; codeId: Buffer; version: number; name: string; code: string }
  | { source: 'user_invite'; mechanism: 'user_invite'; invitationId: Buffer; inviterCompanyId: Buffer; inviterUserId: Buffer };

@Injectable()
export class AcquisitionService {
  private readonly log = new Logger('Acquisition');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly limiter: LookupLimiter,
  ) {}

  // ── Public lookups ─────────────────────────────────────────────────────────

  /** A typed promo code: usable, with the promoter's display name — or the one unusable answer. */
  async lookupCode(typed: unknown, address: string | null | undefined): Promise<LookupAnswer> {
    this.guard(address, 'code');
    const resolved = await this.resolveCode(this.prisma, normalisePromoCode(typed), 'promo_code');
    return this.answer(resolved, address, 'code');
  }

  /** A registration link's token: a promoter's QR (with its code, to prefill) or an invitation — or the one unusable answer. */
  async lookupLink(token: unknown, address: string | null | undefined): Promise<LookupAnswer> {
    this.guard(address, 'link');
    const resolved = await this.resolveToken(this.prisma, token);
    return this.answer(resolved, address, 'link');
  }

  // ── The registration ───────────────────────────────────────────────────────

  /**
   * The claim's shape, before anything is saved: at most one source. Both at once is the registrant's choice to make,
   * never the server's; a claim with neither is no claim.
   */
  claimOf(input: AcquisitionClaim | undefined): AcquisitionClaim | null {
    const promoCode = input?.promoCode?.trim() ? input.promoCode : undefined;
    const referralToken = input?.referralToken?.trim() ? input.referralToken : undefined;
    if (promoCode && referralToken) {
      throw new BadRequestException({
        code: 'acquisition_conflict',
        message: 'Choose one: the promo code or the invitation. Nothing was saved.',
      });
    }
    if (!promoCode && !referralToken) return null;
    return promoCode ? { promoCode } : { referralToken };
  }

  /** Throws while this address has spent its wrong guesses: a registration carrying a source is a lookup too. */
  assertMayClaim(address: string | null | undefined): void {
    this.limiter.assertAllowed(address);
  }

  /** A registration refused for its source counts as a wrong guess. */
  recordRefusedClaim(address: string | null | undefined): void {
    this.limiter.recordFailure(address);
  }

  /**
   * Write the business's one original attribution, in the registration's transaction, after the company and its
   * registration attempt exist. The source is resolved again here, under a shared lock on its row, so a code retired or
   * a promoter deactivated in the same instant either commits before (and this refuses) or waits for this.
   */
  async attributeTx(tx: Prisma.TransactionClient, claim: AcquisitionClaim, ctx: { companyId: Buffer; attemptId: Buffer; at: Date }): Promise<void> {
    const resolved = claim.promoCode
      ? await this.resolveCode(tx, normalisePromoCode(claim.promoCode), 'promo_code', true)
      : await this.resolveToken(tx, claim.referralToken, true);
    if (!resolved) throw new AcquisitionUnavailableException(claim.promoCode || this.kindOf(claim.referralToken) === 'promoter' ? 'promoter' : 'user_invite');

    await tx.businessAcquisition.create({
      data: {
        id: newUuidV7Bin(),
        companyId: ctx.companyId,
        registrationAttemptId: ctx.attemptId,
        source: resolved.source,
        mechanism: resolved.mechanism,
        attributedAt: ctx.at,
        ...(resolved.source === 'promoter'
          ? { promoterId: resolved.promoterId, promoterCodeId: resolved.codeId, codeVersion: resolved.version, promoterName: resolved.name }
          : { invitationId: resolved.invitationId, inviterCompanyId: resolved.inviterCompanyId, inviterUserId: resolved.inviterUserId }),
      },
    });
    this.log.log(JSON.stringify({ event: 'acquisition.attributed', source: resolved.source, mechanism: resolved.mechanism }));
  }

  // ── Resolution ─────────────────────────────────────────────────────────────

  private async resolveCode(db: Db, code: string | null, mechanism: 'promo_code' | 'promoter_qr', lock = false): Promise<Resolved | null> {
    if (!code) return null;
    if (lock) await db.$queryRaw(Prisma.sql`SELECT id FROM promoter_codes WHERE code = ${code} FOR SHARE`);
    const row = await db.promoterCode.findUnique({ where: { code }, select: CODE_FACTS });
    if (!row || !promoterCodeUsable(row)) return null;
    if (lock) await db.$queryRaw(Prisma.sql`SELECT id FROM promoters WHERE id = ${row.promoterId} FOR SHARE`);
    return { source: 'promoter', mechanism, promoterId: row.promoterId, codeId: row.id, version: row.version, name: row.promoter.displayName, code: row.code };
  }

  private async resolveToken(db: Db, token: unknown, lock = false): Promise<Resolved | null> {
    const key = this.config.referralKey;
    if (!key) return null;
    const claim = verifyReferralToken(key, token);
    if (!claim) return null;

    if (claim.kind === 'promoter') {
      if (lock) await db.$queryRaw(Prisma.sql`SELECT id FROM promoters WHERE public_ref = ${claim.ref} FOR SHARE`);
      const promoter = await db.promoter.findUnique({ where: { publicRef: claim.ref }, select: { currentCode: { select: { code: true, version: true } } } });
      // The link is the code's: only the current version opens, so regenerating the code retires every printed QR.
      if (!promoter?.currentCode || promoter.currentCode.version !== claim.version) return null;
      return this.resolveCode(db, promoter.currentCode.code, 'promoter_qr', lock);
    }

    if (lock) await db.$queryRaw(Prisma.sql`SELECT id FROM referral_invitations WHERE public_ref = ${claim.ref} FOR SHARE`);
    const invitation = await db.referralInvitation.findUnique({ where: { publicRef: claim.ref }, select: INVITATION_FACTS });
    if (!invitation || claim.version !== 0 || !invitationUsable(invitation)) return null;
    return { source: 'user_invite', mechanism: 'user_invite', invitationId: invitation.id, inviterCompanyId: invitation.companyId, inviterUserId: invitation.createdByUserId };
  }

  /** Which kind a token claims to be — only to word a refusal; it decides nothing. */
  private kindOf(token: unknown): 'promoter' | 'user_invite' | null {
    if (typeof token !== 'string') return null;
    const first = Buffer.from(token.slice(0, 2), 'base64url')[0];
    return first === 1 ? 'promoter' : first === 2 ? 'user_invite' : null;
  }

  private guard(address: string | null | undefined, via: 'code' | 'link'): void {
    try {
      this.limiter.assertAllowed(address);
    } catch (e) {
      this.log.warn(JSON.stringify({ event: 'acquisition.lookup', via, outcome: 'limited' }));
      throw e;
    }
  }

  /** The public answer. Telemetry carries the outcome only — never the code, the token, a name, a number or an address. */
  private answer(resolved: Resolved | null, address: string | null | undefined, via: 'code' | 'link'): LookupAnswer {
    if (!resolved) {
      this.limiter.recordFailure(address);
      this.log.log(JSON.stringify({ event: 'acquisition.lookup', via, outcome: 'unusable' }));
      return UNUSABLE;
    }
    this.log.log(JSON.stringify({ event: 'acquisition.lookup', via, outcome: 'usable', source: resolved.source }));
    return resolved.source === 'promoter'
      ? { usable: true, source: 'promoter', promoterName: resolved.name, code: resolved.code }
      : { usable: true, source: 'user_invite' };
  }

  // ── Reporting (platform administrator) ─────────────────────────────────────

  /**
   * Self-registered businesses and where they came from — none, a promoter or an invitation — newest first. Only facts:
   * the business, when it registered, its source and the snapshot taken then, and how it stands now.
   */
  async report(filter: {
    source?: 'none' | AcquisitionSource;
    from?: Date;
    to?: Date;
    promoterId?: Buffer;
    inviterCompanyId?: Buffer;
    page?: number;
  }) {
    const take = 50;
    const page = Math.max(0, filter.page ?? 0);
    const where = this.reportWhere(filter);
    const [total, rows] = await Promise.all([
      this.prisma.registrationAttempt.count({ where }),
      this.prisma.registrationAttempt.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: page * take,
        take,
        select: {
          createdAt: true,
          companyId: true,
          acquisition: {
            select: {
              source: true,
              mechanism: true,
              promoterId: true,
              codeVersion: true,
              promoterName: true,
              attributedAt: true,
              inviterCompany: { select: { id: true, name: true } },
            },
          },
        },
      }),
    ]);
    const companyIds = rows.map((r) => r.companyId).filter((id): id is Buffer => id !== null);
    const facts = await this.businessFacts(companyIds);
    return {
      total,
      page,
      pageSize: take,
      rows: rows
        .filter((r) => r.companyId)
        .map((r) => {
          const company = facts.get(binToUuid(r.companyId!));
          const a = r.acquisition;
          return {
            companyId: binToUuid(r.companyId!),
            businessName: company?.name ?? null,
            isTest: company?.isTest ?? false,
            registeredAt: r.createdAt.toISOString(),
            status: company?.status ?? null,
            closed: company?.closed ?? false,
            completed: company?.completed ?? false,
            source: (a?.source ?? 'none') as 'none' | AcquisitionSource,
            mechanism: (a?.mechanism ?? null) as AcquisitionMechanism | null,
            promoter: a?.promoterId ? { id: binToUuid(a.promoterId), nameSnapshot: a.promoterName, codeVersion: a.codeVersion } : null,
            inviter: a?.inviterCompany ? { companyId: binToUuid(a.inviterCompany.id), businessName: a.inviterCompany.name } : null,
          };
        }),
    };
  }

  /** How many self-registered businesses came from each source in the period: counts, nothing else. */
  async summary(filter: { from?: Date; to?: Date }) {
    const base = this.reportWhere(filter);
    const [none, promoter, userInvite] = await Promise.all([
      this.prisma.registrationAttempt.count({ where: { ...base, acquisition: { is: null } } }),
      this.prisma.registrationAttempt.count({ where: { ...base, acquisition: { is: { source: 'promoter' } } } }),
      this.prisma.registrationAttempt.count({ where: { ...base, acquisition: { is: { source: 'user_invite' } } } }),
    ]);
    return { none, promoter, userInvite, total: none + promoter + userInvite };
  }

  /** Per promoter: attributed registrations, and how many of those businesses finished registering (contact proved). */
  async promoterCounts(promoterIds: Buffer[]): Promise<Map<string, { registrations: number; completed: number }>> {
    const out = new Map<string, { registrations: number; completed: number }>();
    if (promoterIds.length === 0) return out;
    const rows = await this.prisma.$queryRaw<{ promoter_id: Buffer; registrations: bigint; completed: bigint | null }[]>(Prisma.sql`
      SELECT a.promoter_id, COUNT(*) AS registrations,
             SUM(EXISTS (SELECT 1 FROM users u WHERE u.company_id = a.company_id AND (u.phone_verified_at IS NOT NULL OR u.email_verified_at IS NOT NULL))) AS completed
        FROM business_acquisitions a
       WHERE a.promoter_id IN (${Prisma.join(promoterIds)})
       GROUP BY a.promoter_id`);
    for (const r of rows) out.set(binToUuid(r.promoter_id), { registrations: Number(r.registrations), completed: Number(r.completed ?? 0) });
    return out;
  }

  private reportWhere(filter: { source?: 'none' | AcquisitionSource; from?: Date; to?: Date; promoterId?: Buffer; inviterCompanyId?: Buffer }): Prisma.RegistrationAttemptWhereInput {
    const where: Prisma.RegistrationAttemptWhereInput = {
      companyId: { not: null },
      // Self-registrations only: a business the console created never has a source.
      NOT: { idempotencyKey: { startsWith: ADMIN_KEY_PREFIX } },
    };
    if (filter.from || filter.to) where.createdAt = { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lt: filter.to } : {}) };
    if (filter.source === 'none') where.acquisition = { is: null };
    else if (filter.source) where.acquisition = { is: { source: filter.source } };
    if (filter.promoterId) where.acquisition = { is: { ...((where.acquisition as { is?: object })?.is ?? {}), promoterId: filter.promoterId } };
    if (filter.inviterCompanyId) where.acquisition = { is: { ...((where.acquisition as { is?: object })?.is ?? {}), inviterCompanyId: filter.inviterCompanyId } };
    return where;
  }

  private async businessFacts(ids: Buffer[]) {
    const out = new Map<string, { name: string; isTest: boolean; status: string | null; closed: boolean; completed: boolean }>();
    if (ids.length === 0) return out;
    const companies = await this.prisma.company.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        isTest: true,
        closedAt: true,
        subscription: { select: { status: true } },
        users: { where: { OR: [{ phoneVerifiedAt: { not: null } }, { emailVerifiedAt: { not: null } }] }, select: { id: true }, take: 1 },
      },
    });
    for (const c of companies) {
      out.set(binToUuid(c.id), { name: c.name, isTest: c.isTest, status: c.subscription?.status ?? null, closed: c.closedAt !== null, completed: c.users.length > 0 });
    }
    return out;
  }

  /** Whether links can be made at all: the signing key is configured. */
  requireReferralKey(): string {
    const key = this.config.referralKey;
    if (!key) {
      throw new ServiceUnavailableException({
        code: 'referral_links_unavailable',
        message: 'Registration links cannot be made on this server: REFERRAL_KEY is not configured.',
      });
    }
    return key;
  }
}

/** The console's idempotency keys (`platform.controller.ts`): a business it created is not a self-registration. */
const ADMIN_KEY_PREFIX = 'admin:';
