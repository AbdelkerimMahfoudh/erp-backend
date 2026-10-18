import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfigService } from '../../common/config/app-config.service';
import { portalCsrfToken } from '../../common/http/portal-csrf';
import { uuidToBin } from '../../common/utils/uuid.util';
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
export interface PortalSessionView {
  owner: { name: string };
  business: { name: string };
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
  ) {}

  async signIn(dto: PortalSignInDto, meta: { ip?: string; userAgent?: string }): Promise<PortalSignInAnswer> {
    const result = await this.auth.login({ identifier: dto.identifier, password: dto.password } as LoginDto, meta);
    if ('status' in result) return result;
    return { status: 'signed_in', ...(await this.opened(result)) };
  }

  async chooseAccount(dto: PortalChooseAccountDto, meta: { ip?: string; userAgent?: string }): Promise<PortalOpened> {
    return this.opened(await this.auth.chooseAccount(dto.continuationToken, dto.accountRef, {} as LoginDto, meta));
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
    return this.viewOf(owner, sessionId);
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
    return { accessToken: t.accessToken, accessTtlSeconds: t.expiresIn, refreshToken: t.refreshToken, session: this.viewOf(owner, sessionId) };
  }

  /** An active, undeleted person of this company holding the Owner role — the role itself, as the trial reads it. */
  private ownerOf(userId: Buffer, companyId: Buffer) {
    return this.prisma.user.findFirst({
      where: { id: userId, companyId, isActive: true, deletedAt: null, userBranches: { some: { role: { key: 'owner' } } } },
      select: { name: true, company: { select: { name: true } } },
    });
  }

  private viewOf(owner: { name: string; company: { name: string } }, sessionId: string): PortalSessionView {
    return {
      owner: { name: owner.name },
      business: { name: owner.company.name },
      csrfToken: portalCsrfToken(this.config.jwtAccessSecret, sessionId),
    };
  }
}
