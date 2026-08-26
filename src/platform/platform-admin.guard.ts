import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { PlatformAdminService, type PlatformAdminIdentity } from './platform-admin.service';

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
  constructor(private readonly admins: PlatformAdminService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AdminRequest>();

    let token = readCookie(req.headers.cookie, ADMIN_SESSION_COOKIE);
    if (!token && process.env.NODE_ENV !== 'production') {
      const header = req.headers.authorization;
      if (header?.startsWith('Bearer ')) token = header.slice('Bearer '.length);
    }

    const admin = await this.admins.resolve(token);
    if (!admin) {
      // Generic, and identical whether the session is absent, expired, revoked,
      // or belongs to an administrator who has since been disabled.
      throw new UnauthorizedException('Not signed in');
    }

    req.platformAdmin = admin;
    req.platformSessionToken = token;
    return true;
  }
}
