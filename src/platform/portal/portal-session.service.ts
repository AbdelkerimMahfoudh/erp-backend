import { storesOfUser, type NamedStore } from '../../common/account-label';
import { ForbiddenException, Injectable, UnauthorizedException, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ClaimLinkService, type ClaimRefusal } from '../../notices/claim-links.service';
import { AppConfigService } from '../../common/config/app-config.service';
import { portalCsrfToken } from '../../common/http/portal-csrf';
import { binToUuid, uuidToBin } from '../../common/utils/uuid.util';
import { AuthService, type AuthTokenResponse } from '../../auth/auth.service';
import { SessionsService } from '../../auth/sessions.service';
import { TokensService } from '../../auth/tokens.service';
import type { LoginDto } from '../../auth/dto/login.dto';
import type { PortalChooseAccountDto, PortalSignInDto } from './portal.dto';

/**
 * The Dukan ERP portal's own sign-in (0099; docs/101 §4; the owner's brief of 2026-10-18).
 *
 * **One identity.** The Owner signs in with what they use in the app — the WhatsApp number or the email address, and
 * the password — through the same `AuthService` checks: non-enumerating, timing-even, the account chooser when one
 * contact and one password match more than one business. No second identity system exists.
 *
 * **Owners only.** The portal is the Owner's: their subscription, their free trial, their payments. A Manager or an
 * Employee whose password is right is told so — after the password, never before — and the session the check made is
 * revoked at once. Every later refresh checks again, so an Owner who loses the role loses the portal.
 *
 * **Cookies, not tokens in a page.** The access token and the refresh token travel only in `HttpOnly`, `SameSite=Strict`
 * cookies the controller sets (the refresh token only to the portal's session routes); the page holds nothing but the
 * session's CSRF token, which every unsafe request carries back (`common/http/portal-csrf.ts`).
 */

/** Who the portal is signed in as, as the page shows it — and the token its unsafe requests carry. */
/** A link whose Owner or business can no longer open the portal: the transaction is undone, the link not spent. */
class ClaimLinkUnusable extends Error {}

export interface PortalSessionView {
  owner: { name: string };
  business: { name: string | null; stores: NamedStore[] };
  /** Sent back in `x-csrf-token` on every POST: bound to this session, useless to anybody else. */
  csrfToken: string;
}

/** A session opened or refreshed: the cookies' values, and the view. */
export interface PortalOpened {
  accessToken: string;
  accessTtlSeconds: number;
  refreshToken: string;
  session: PortalSessionView;
}

export type PortalSignInAnswer =
  | ({ status: 'signed_in' } & PortalOpened)
  | { status: 'choose_account'; continuationToken: string; expiresIn: number; accounts: { accountRef: string; companyName: string; userName: string }[] };

const OWNER_ONLY = {
  code: 'owner_only',
  message: 'The Dukan ERP portal is for business owners. Sign in with the owner’s account.',
};

@Injectable()
export class PortalSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
    private readonly tokens: TokensService,
    private readonly config: AppConfigService,
    @Optional() private readonly claimLinks?: ClaimLinkService,
  ) {}

  async signIn(dto: PortalSignInDto, meta: { ip?: string; userAgent?: string }): Promise<PortalSignInAnswer> {
    const result = await this.auth.login({ identifier: dto.identifier, password: dto.password } as LoginDto, meta);
    if ('status' in result) return result;
    return { status: 'signed_in', ...(await this.opened(result)) };
  }

  async chooseAccount(dto: PortalChooseAccountDto, meta: { ip?: string; userAgent?: string }): Promise<PortalOpened> {
    return this.opened(await this.auth.chooseAccount(dto.continuationToken, dto.accountRef, {} as LoginDto, meta));
  }

  /**
   * The account-ready message's link (post-Build-4): spent once, for a normal portal session of the business's Owner —
   * re-checked now, not trusted from when it was sent: an active Owner of an active, undeleted business. The link is
   * spent only if the session opens. Nothing else is granted: the trial is the page's to claim, by that Owner.
   */
  async openWithClaimLink(token: string, meta: { ip?: string; userAgent?: string }): Promise<PortalOpened | { refused: ClaimRefusal }> {
    if (!this.claimLinks) return { refused: 'invalid' };
    const spent = await this.claimLinks.redeem(token, async (tx, link) => {
      const owner = await tx.user.findFirst({
        where: { id: link.userId, companyId: link.companyId, isActive: true, deletedAt: null, company: { isActive: true, deletedAt: null }, userBranches: { some: { role: { key: 'owner' } } } },
        select: { id: true, companyId: true },
      });
      if (!owner) throw new ClaimLinkUnusable();
      const secret = this.tokens.generateRefreshSecret();
      const sessionId = await this.sessions.create({ companyId: owner.companyId, userId: owner.id, secret, userAgent: meta.userAgent, ip: meta.ip });
      return { owner, sessionId, secret };
    }).catch((e) => {
      if (e instanceof ClaimLinkUnusable) return { ok: false as const, reason: 'invalid' as const };
      throw e;
    });
    if (!spent.ok) return { refused: spent.reason };
    const { owner, sessionId, secret } = spent.result;
    const access = this.tokens.signAccessToken(binToUuid(owner.id), binToUuid(owner.companyId), binToUuid(sessionId));
    const refreshToken = this.tokens.buildRefreshToken(binToUuid(sessionId), secret);
    const named = await this.ownerOf(owner.id, owner.companyId);
    if (!named) throw new ForbiddenException(OWNER_ONLY);
    return { accessToken: access.token, accessTtlSeconds: access.expiresIn, refreshToken, session: await this.viewOf(named, binToUuid(sessionId)) };
  }

  /** The refresh cookie, rotated: a new pair of cookies for the same session — and the Owner checked again. */
  async refresh(refreshToken: string | undefined): Promise<PortalOpened> {
    if (!refreshToken) throw new UnauthorizedException();
    return this.opened(await this.auth.refresh(refreshToken));
  }

  /** The session the cookie authenticated, as the page shows it — the Owner checked again. */
  async current(userId: string, companyId: string, sessionId: string): Promise<PortalSessionView> {
    const owner = await this.ownerOf(uuidToBin(userId), uuidToBin(companyId));
    if (!owner) throw new ForbiddenException(OWNER_ONLY);
    return await this.viewOf(owner, sessionId);
  }

  /**
   * End the session the refresh cookie holds. The cookie must still prove it — a rotation that succeeds — so a stale or
   * forged one revokes nothing; the controller clears both cookies either way.
   */
  async signOut(refreshToken: string | undefined): Promise<void> {
    const parsed = refreshToken ? this.tokens.parseRefreshToken(refreshToken) : null;
    if (!parsed) return;
    let sessionId: Buffer;
    try {
      sessionId = uuidToBin(parsed.sessionId);
    } catch {
      return;
    }
    const held = await this.sessions.rotate(sessionId, parsed.secret, this.tokens.generateRefreshSecret());
    if (held) await this.sessions.revoke(held.userId, sessionId);
  }

  /** A signed-in person the portal accepts — an active Owner — or their session revoked and 403. */
  private async opened(t: AuthTokenResponse): Promise<PortalOpened> {
    const userId = uuidToBin(t.user.id);
    const sessionId = this.tokens.parseRefreshToken(t.refreshToken)?.sessionId;
    if (!sessionId) throw new UnauthorizedException();
    const owner = await this.ownerOf(userId, uuidToBin(t.user.companyId));
    if (!owner) {
      await this.sessions.revoke(userId, uuidToBin(sessionId));
      throw new ForbiddenException(OWNER_ONLY);
    }
    return { accessToken: t.accessToken, accessTtlSeconds: t.expiresIn, refreshToken: t.refreshToken, session: await this.viewOf(owner, sessionId) };
  }

  /** An active, undeleted person of this company holding the Owner role — the role itself, as the trial reads it. */
  private ownerOf(userId: Buffer, companyId: Buffer) {
    return this.prisma.user.findFirst({
      where: { id: userId, companyId, isActive: true, deletedAt: null, userBranches: { some: { role: { key: 'owner' } } } },
      select: { id: true, name: true, company: { select: { name: true } } },
    });
  }

  private async viewOf(owner: { id: Buffer; name: string; company: { name: string | null } }, sessionId: string): Promise<PortalSessionView> {
    return {
      owner: { name: owner.name },
      // D227: the trading name, null without one, and the stores the page lists instead of inventing a parent.
      business: { name: owner.company.name, stores: await storesOfUser(this.prisma, owner.id) },
      csrfToken: portalCsrfToken(this.config.jwtAccessSecret, sessionId),
    };
  }
}
