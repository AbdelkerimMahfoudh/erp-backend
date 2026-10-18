import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The portal session's CSRF defence (0099; docs/101 §4).
 *
 * A cookie-authenticated request is one the browser attaches the session to on its own, so the cookie alone proves
 * nothing about who asked. Every unsafe request (POST, PUT, PATCH, DELETE) the portal cookie authenticates must also
 * carry, in the `x-csrf-token` header, a token bound to that session: an HMAC of the session id under a key derived from
 * the access-token secret. The portal receives it in the body of its sign-in, refresh and session answers — which only
 * the allowlisted portal origin can read (CORS) — keeps it in memory, and sends it back; a page on another origin can
 * neither read it nor guess it. Nothing reads `Origin` or `Referer`: a client sets those at will.
 *
 * A bearer-authenticated request (the app) carries no cookie and needs no token: nothing attaches a bearer on its own.
 *
 * The cookie authenticates the portal's routes only — the Owner's subscription, the portal session, the payment
 * instructions — never the rest of the tenant API, so a portal session cannot drive the shop's operations.
 */

export const CSRF_HEADER = 'x-csrf-token';

/** The routes a portal cookie may authenticate: `/api/v<n>/platform/{my-subscription,portal,payment-instructions}…`. */
const PORTAL_COOKIE_ROUTE = /^\/api\/v\d+\/platform\/(?:my-subscription|portal|payment-instructions)(?:[/?]|$)/;

/** Methods that can change something; GET, HEAD and OPTIONS never can. */
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function portalCookieRouteAllowed(url: string | undefined): boolean {
  return PORTAL_COOKIE_ROUTE.test(url ?? '');
}

export function isUnsafeMethod(method: string | undefined): boolean {
  return UNSAFE.has((method ?? '').toUpperCase());
}

/** The token bound to one portal session. */
export function portalCsrfToken(secret: string, sessionId: string): string {
  const key = createHmac('sha256', secret).update('portal-csrf-key:v1').digest();
  return createHmac('sha256', key).update(`portal-csrf:v1:${sessionId}`).digest('base64url');
}

/** Whether the presented header is that session's token — compared in constant time; anything else is false. */
export function portalCsrfMatches(secret: string, sessionId: string, presented: unknown): boolean {
  if (typeof presented !== 'string' || presented.length === 0 || presented.length > 128) return false;
  const expected = Buffer.from(portalCsrfToken(secret, sessionId));
  const given = Buffer.from(presented);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
