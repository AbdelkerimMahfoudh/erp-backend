import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ClsService } from 'nestjs-cls';
import { AppConfigService } from '../../common/config/app-config.service';
import { AppClsStore } from '../../common/context/request-context';
import { AccessTokenPayload, AuthUser } from '../../common/types/auth-user';
import { uuidToBin } from '../../common/utils/uuid.util';

/**
 * Validates the access token and establishes request context: it puts `userId`
 * and `companyId` (as BINARY(16)) into CLS, so the tenant Prisma extension is
 * automatically scoped for the rest of the request. Branch + permissions are
 * added by the isolation/permission guards (Phase 3).
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: AppConfigService,
    private readonly cls: ClsService<AppClsStore>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.jwtAccessSecret,
    });
  }

  async validate(payload: AccessTokenPayload): Promise<AuthUser> {
    if (payload.type !== 'access') {
      throw new UnauthorizedException();
    }
    this.cls.set('userId', payload.sub);
    this.cls.set('companyId', uuidToBin(payload.companyId));
    return { userId: payload.sub, companyId: payload.companyId };
  }
}
