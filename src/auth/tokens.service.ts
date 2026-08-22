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

  signAccessToken(
    userId: string,
    companyId: string,
    sessionId: string,
  ): { token: string; expiresIn: number } {
    const payload: AccessTokenPayload = { sub: userId, companyId, type: 'access', sid: sessionId };
    return { token: this.jwt.sign(payload), expiresIn: this.accessTtlSeconds() };
  }

/**
   * A short-lived token that authorises ONE thing: naming which of several
   * already-verified accounts to continue as (CP3).
   *
   * Purpose-bound by `type`, which the access-token guard does not accept, so
   * this can never be presented as an access token. It carries only the user
   * ids whose password already matched — it grants no reach beyond what the
   * credential check had already established.
   */
  signContinuation(userIds: string[], ttlSeconds: number): string {
    return this.jwt.sign(
      { type: 'account_choice', accounts: userIds },
      { expiresIn: ttlSeconds },
    );
  }

  /** The ids inside a continuation token, or null if it is not one. */
  verifyContinuation(token: string): string[] | null {
    try {
      const payload = this.jwt.verify<{ type?: string; accounts?: unknown }>(token);
      if (payload?.type !== 'account_choice') return null;
      if (!Array.isArray(payload.accounts)) return null;
      return payload.accounts.filter((a): a is string => typeof a === 'string');
    } catch {
      // Expired or tampered with. Either way the shopkeeper starts again.
      return null;
    }
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
