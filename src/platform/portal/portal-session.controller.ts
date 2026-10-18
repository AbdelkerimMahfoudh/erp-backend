import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/types/auth-user';
import {
  PORTAL_REFRESH_COOKIE,
  PORTAL_REFRESH_PATH,
  PORTAL_SESSION_COOKIE,
  cookieSecure,
  readCookie,
} from '../../common/http/cookies';
import { PORTAL_SESSION_TTL_HOURS } from '../portal-handoff.service';
import { PortalChooseAccountDto, PortalSignInDto } from './portal.dto';
import { PortalSessionService, type PortalOpened } from './portal-session.service';

/*
 * The sign-in limit, read the way `auth.controller.ts` reads it: a decorator is evaluated before anything is injected,
 * the Joi schema validates the variable, and the fallback is the schema's own default.
 */
const SIGN_IN_THROTTLE = { default: { limit: Number(process.env.AUTH_THROTTLE_LIMIT) || 10, ttl: 60_000 } };

const COOKIE = { httpOnly: true, sameSite: 'strict' as const };

/** Both cookies: the access token for the portal's routes, the refresh token for the session routes alone. */
function setCookies(res: Response, opened: PortalOpened): void {
  const secure = cookieSecure();
  res.cookie(PORTAL_SESSION_COOKIE, opened.accessToken, { ...COOKIE, secure, path: '/', maxAge: opened.accessTtlSeconds * 1000 });
  res.cookie(PORTAL_REFRESH_COOKIE, opened.refreshToken, { ...COOKIE, secure, path: PORTAL_REFRESH_PATH, maxAge: PORTAL_SESSION_TTL_HOURS * 3_600_000 });
}

function clearCookies(res: Response): void {
  const secure = cookieSecure();
  res.clearCookie(PORTAL_SESSION_COOKIE, { ...COOKIE, secure, path: '/' });
  res.clearCookie(PORTAL_REFRESH_COOKIE, { ...COOKIE, secure, path: PORTAL_REFRESH_PATH });
}

/**
 * The Dukan ERP portal's session (0099; docs/101 §4): sign in with the app's identity, choose the business when one
 * contact matches several, refresh, read who is signed in, sign out.
 *
 * No token is ever in a body or a URL the page could keep: the access and refresh tokens are set as cookies here and
 * only here, and every answer is `no-store`. The page receives the session's CSRF token, and nothing else it could
 * replay elsewhere. Nothing reads `Origin` or `Referer`.
 */
@ApiExcludeController()
@Controller({ path: 'platform/portal', version: '1' })
export class PortalSessionController {
  constructor(private readonly portal: PortalSessionService) {}

  @Public()
  @Throttle(SIGN_IN_THROTTLE)
  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  async signIn(@Body() dto: PortalSignInDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const answer = await this.portal.signIn(dto, { ip: req.ip, userAgent: req.headers['user-agent'] });
    if (answer.status === 'choose_account') return answer;
    setCookies(res, answer);
    return { status: 'signed_in', session: answer.session };
  }

  @Public()
  @Throttle(SIGN_IN_THROTTLE)
  @Post('choose-account')
  @HttpCode(HttpStatus.OK)
  async chooseAccount(@Body() dto: PortalChooseAccountDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const opened = await this.portal.chooseAccount(dto, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setCookies(res, opened);
    return { status: 'signed_in', session: opened.session };
  }

  /**
   * A new pair of cookies for the same session, from the refresh cookie alone. No CSRF token: a page that lost its
   * memory (a reload) gets its token back here, and a request another site starts carries no `SameSite=Strict` cookie.
   * A failure clears both cookies.
   */
  @Public()
  @Throttle(SIGN_IN_THROTTLE)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const opened = await this.portal.refresh(readCookie(req.headers.cookie, PORTAL_REFRESH_COOKIE));
      setCookies(res, opened);
      return { status: 'signed_in', session: opened.session };
    } catch (e) {
      clearCookies(res);
      throw e;
    }
  }

  /** Who is signed in, and the session's CSRF token — authenticated by the portal cookie. */
  @Get('session')
  session(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.portal.current(user.userId, user.companyId, user.sessionId);
  }

  /** End the session the refresh cookie proves, and clear both cookies whatever it proves. */
  @Public()
  @Post('sign-out')
  @HttpCode(HttpStatus.NO_CONTENT)
  async signOut(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    try {
      await this.portal.signOut(readCookie(req.headers.cookie, PORTAL_REFRESH_COOKIE));
    } finally {
      clearCookies(res);
    }
  }
}
