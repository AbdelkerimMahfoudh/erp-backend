import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { PORTAL_SESSION_COOKIE, readCookie } from '../../common/http/cookies';

/** The refusal, the same for every route the guard holds. */
export const PORTAL_SESSION_REQUIRED = {
  code: 'portal_session_required',
  message: 'This is done on the Dukan ERP portal, after signing in there.',
} as const;

/**
 * The portal's own session, and no other (0099; docs/101 §4–5; the owner's brief of 2026-10-18: the free trial is
 * claimed on the portal alone).
 *
 * The trial's claim starts something that cannot be paused or restarted, and the instructions' resend sends a
 * message: both require the session the portal's sign-in opened — the password typed there, held in an HttpOnly
 * cookie no script can read, with its CSRF token checked by the JWT strategy on every unsafe request. A request
 * authenticated by a bearer token is the app's — a session kept for months on a phone, with no trial action — and is
 * refused, whatever else it carries.
 *
 * This reads which credential the server itself issued authenticated the request (the JWT strategy takes a bearer
 * first, the portal cookie only when there is none). It never reads where a request says it comes from: no `Origin`,
 * no `Referer`, no header a client sets about itself (the owner's correction of 2026-10-13).
 */
@Injectable()
export class PortalSessionOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const authorization = req.headers?.authorization;
    const bearer = typeof authorization === 'string' && authorization.trim() !== '';
    if (bearer || !readCookie(req.headers?.cookie, PORTAL_SESSION_COOKIE)) throw new ForbiddenException(PORTAL_SESSION_REQUIRED);
    return true;
  }
}
