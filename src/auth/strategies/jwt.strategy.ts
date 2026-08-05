import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ClsService } from 'nestjs-cls';
import { AppConfigService } from '../../common/config/app-config.service';
import { AppClsStore } from '../../common/context/request-context';
import { AccessTokenPayload, AuthUser } from '../../common/types/auth-user';
import { uuidToBin } from '../../common/utils/uuid.util';
import { SessionsService } from '../sessions.service';

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
  constructor(
    config: AppConfigService,
    private readonly cls: ClsService<AppClsStore>,
    private readonly sessions: SessionsService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.jwtAccessSecret,
    });
  }

  async validate(payload: AccessTokenPayload): Promise<AuthUser> {
    if (payload.type !== 'access' || typeof payload.sid !== 'string') {
      throw new UnauthorizedException();
    }

    let sessionId: Buffer;
    try {
      sessionId = uuidToBin(payload.sid);
    } catch {
      throw new UnauthorizedException();
    }

    if (!(await this.sessions.isAccessValid(sessionId, payload.sub))) {
      throw new UnauthorizedException();
    }

    this.cls.set('userId', payload.sub);
    this.cls.set('companyId', uuidToBin(payload.companyId));
    return { userId: payload.sub, companyId: payload.companyId };
  }
}
