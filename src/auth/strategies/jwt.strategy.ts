import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ClsService } from 'nestjs-cls';
import { AppConfigService } from '../../common/config/app-config.service';
import { AppClsStore } from '../../common/context/request-context';
import { AccessTokenPayload, AuthUser } from '../../common/types/auth-user';
import { uuidToBin } from '../../common/utils/uuid.util';
import { SessionsService } from '../sessions.service';
import { readCookie, PORTAL_SESSION_COOKIE } from '../../common/http/cookies';
import { CSRF_HEADER, isUnsafeMethod, portalCookieRouteAllowed, portalCsrfMatches } from '../../common/http/portal-csrf';

/** The parts of a request the strategy reads. */
interface StrategyRequest {
  method?: string;
  originalUrl?: string;
  url?: string;
  headers?: { cookie?: string; authorization?: string; [name: string]: string | string[] | undefined };
}

const bearerOf = ExtractJwt.fromAuthHeaderAsBearerToken();

/**
 * Validates the access token and establishes request context: it puts `userId`
 * and `companyId` (as BINARY(16)) into CLS, so the tenant Prisma extension is
 * automatically scoped for the rest of the request. Branch + permissions are
 * added by the isolation/permission guards.
 *
 * The token is bound to its `auth_sessions` row (`sid`), which is revalidated on
 * every request together with the user's active/deleted state. This is what makes
 * deactivation take effect immediately (revoking the session cuts off the access
 * token) and keeps a reactivated user from reusing old tokens — the revoked
 * session never returns, so they must authenticate again.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly csrfSecret: string;

  constructor(
    config: AppConfigService,
    private readonly cls: ClsService<AppClsStore>,
    private readonly sessions: SessionsService,
  ) {
    super({
      /*
       * The Authorization header first, and the PORTAL COOKIE second.
       *
       * The app sends a bearer token. The Dukan ERP portal has no bearer to
       * send — its sign-in leaves it holding an HttpOnly cookie, which no
       * script on the page can read. Both carry the SAME kind of access token,
       * so nothing about validation below changes and no guard is loosened: an
       * invalid token is still invalid, and a revoked session still cuts the
       * request off.
       *
       * A cookie authenticates the portal's routes only, and an unsafe request
       * it authenticates must carry the session's CSRF token (0099;
       * `portal-csrf.ts`): checked in `validate`, below.
       */
      jwtFromRequest: ExtractJwt.fromExtractors([
        bearerOf,
        (req: StrategyRequest) => readCookie(req?.headers?.cookie, PORTAL_SESSION_COOKIE) ?? null,
      ]),
      ignoreExpiration: false,
      secretOrKey: config.jwtAccessSecret,
      passReqToCallback: true,
    });
    this.csrfSecret = config.jwtAccessSecret;
  }

  async validate(req: StrategyRequest, payload: AccessTokenPayload): Promise<AuthUser> {
    if (payload.type !== 'access' || typeof payload.sid !== 'string') {
      throw new UnauthorizedException();
    }

    let sessionId: Buffer;
    try {
      sessionId = uuidToBin(payload.sid);
    } catch {
      throw new UnauthorizedException();
    }

    // Authenticated by the portal cookie, not a bearer: the portal's routes only, and the session's CSRF token on
    // every unsafe request.
    if (!bearerOf(req as never)) {
      if (!portalCookieRouteAllowed(req.originalUrl ?? req.url)) throw new UnauthorizedException();
      if (isUnsafeMethod(req.method) && !portalCsrfMatches(this.csrfSecret, payload.sid, req.headers?.[CSRF_HEADER])) {
        throw new ForbiddenException({ code: 'csrf_failed', message: 'This request could not be verified. Reload the page and try again.' });
      }
    }

    if (!(await this.sessions.isAccessValid(sessionId, payload.sub))) {
      throw new UnauthorizedException();
    }

    this.cls.set('userId', payload.sub);
    this.cls.set('companyId', uuidToBin(payload.companyId));
    return { userId: payload.sub, companyId: payload.companyId, sessionId: payload.sid };
  }
}
