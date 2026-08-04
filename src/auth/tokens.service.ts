import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import { AppConfigService } from '../common/config/app-config.service';
import { AccessTokenPayload } from '../common/types/auth-user';
import { parseDurationSeconds } from '../common/utils/duration.util';

/**
 * Token utilities.
 *  - Access token: signed JWT (short-lived).
 *  - Refresh token: opaque, delivered as `<sessionId>.<secret>` so the server can
 *    look the session up by id and Argon2-verify the secret. Only the secret's
 *    hash is ever stored (see SessionsService).
 */
@Injectable()
export class TokensService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  signAccessToken(userId: string, companyId: string): { token: string; expiresIn: number } {
    const payload: AccessTokenPayload = { sub: userId, companyId, type: 'access' };
    return { token: this.jwt.sign(payload), expiresIn: this.accessTtlSeconds() };
  }

  generateRefreshSecret(): string {
    return randomBytes(32).toString('base64url');
  }

  buildRefreshToken(sessionId: string, secret: string): string {
    return `${sessionId}.${secret}`;
  }

  parseRefreshToken(token: string): { sessionId: string; secret: string } | null {
    const idx = token.indexOf('.');
    if (idx <= 0) {
      return null;
    }
    const sessionId = token.slice(0, idx);
    const secret = token.slice(idx + 1);
    return sessionId && secret ? { sessionId, secret } : null;
  }

  accessTtlSeconds(): number {
    return parseDurationSeconds(this.config.jwtAccessTtl);
  }
}
