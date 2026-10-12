import { CanActivate, ExecutionContext, Injectable, Optional, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import type { Request } from 'express';
import type { AppClsStore } from '../common/context/request-context';
import { PlatformAdminService, type PlatformAdminIdentity } from './platform-admin.service';

/**
 * The routes a session may reach BEFORE its second factor is verified (0094): completing it, enrolling, and
 * signing out. Every other administrative route refuses such a session — there is no API path around the code.
 */
export const ALLOW_PENDING_MFA = 'platformAllowPendingMfa';
export const AllowPendingMfa = (): MethodDecorator => SetMetadata(ALLOW_PENDING_MFA, true);

/** The cookie the session token lives in. HttpOnly — script can never read it. */
export { ADMIN_SESSION_COOKIE, readCookie } from '../common/http/cookies';
import { ADMIN_SESSION_COOKIE, readCookie } from '../common/http/cookies';

export interface AdminRequest extends Request {
  platformAdmin?: PlatformAdminIdentity;
  /**
   * The token that actually authenticated this request.
   *
   * Stashed so sign-out can revoke *this* session rather than re-deriving it
   * from the cookie. They are usually the same, but not always — and a sign-out
   * that silently revoked nothing because it looked in the wrong place is a
   * particularly bad bug to ship on an administration portal.
   */
  platformSessionToken?: string;
  /** The session's id, where a step-up is recorded (0094). */
  platformSessionId?: Buffer;
  /** False while the second factor is still to be verified — only the MFA routes see such a request. */
  platformMfaVerified?: boolean;
}

/**
 * Read one cookie off the raw header.
 *
 * Deliberately not `cookie-parser`. The whole need is "find one name in a
 * semicolon-separated header", and adding a dependency — plus its types, plus
 * its advisories, plus global middleware — to do that would be a worse trade
 * than eight lines. Nothing here parses attributes or signs anything, because
 * nothing here needs to: the value is an opaque random token whose only
 * meaning comes from matching a hash in the database.
 */

/**
 * The wall between the platform and every shop.
 *
 * A tenant JWT is not accepted here and cannot be: this guard reads a
 * completely different credential, from a different table, in a different
 * cookie. An Owner holding every permission their company can grant still
 * arrives with nothing this guard will look at, so the refusal is structural
 * rather than a check somebody could forget to add.
 *
 * The token is taken from an **HttpOnly cookie**, not an `Authorization`
 * header, because the administration portal is a browser application: a token
 * in `localStorage` is readable by any script that gets onto the page, and the
 * blast radius of that on this particular surface is every business on the
 * platform.
 *
 * A bearer header is accepted **only** outside production, so the live-check
 * harness and integration tests can drive the API without a cookie jar. In
 * production the header is ignored entirely.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    private readonly admins: PlatformAdminService,
    @Optional() private readonly reflector: Reflector = new Reflector(),
    @Optional() private readonly cls?: ClsService<AppClsStore>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AdminRequest>();

    let token = readCookie(req.headers.cookie, ADMIN_SESSION_COOKIE);
    if (!token && process.env.NODE_ENV !== 'production') {
      const header = req.headers.authorization;
      if (header?.startsWith('Bearer ')) token = header.slice('Bearer '.length);
    }

    const session = await this.admins.resolveSession(token);
    if (!session) {
      // Generic, and identical whether the session is absent, expired, revoked,
      // or belongs to an administrator who has since been disabled.
      throw new UnauthorizedException('Not signed in');
    }
    if (!session.mfaVerified && !this.reflector.get<boolean>(ALLOW_PENDING_MFA, context.getHandler())) {
      // A password alone reaches nothing here: the second factor first (0094).
      throw new UnauthorizedException({ code: 'mfa_required', message: 'Enter a code from your authenticator to continue.' });
    }

    req.platformAdmin = session.admin;
    req.platformSessionToken = token;
    req.platformSessionId = session.sessionId;
    req.platformMfaVerified = session.mfaVerified;
    this.cls?.set('platformSessionId', session.sessionId);
    return true;
  }
}
