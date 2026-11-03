/**
 * Which browser origins may use the platform administrator's session (ADMIN_ORIGINS; https://admin.tsxmr.com).
 *
 * The administrator's cookie is `SameSite=Lax` and CORS_ORIGINS is one list for the whole API, while the subdomains of
 * tsxmr.com are one site: without this, a script on the customers' portal or a test site could send that cookie to the
 * console's routes and read the answer. A browser sets `Origin` itself and no page can change it; a client that can
 * forge it does not hold an administrator's cookie.
 *
 * Unset means not enforced, so a release can carry this before its configuration does. Once set: a named origin only;
 * no `Origin` at all only on a safe method, which is a page opened directly, whose answer no other page can read.
 */
import { isUnsafeMethod } from './portal-csrf';

export const ADMIN_ORIGIN_REFUSED = { code: 'admin_origin_refused', message: 'This origin cannot use the administrator console.' };

export function adminOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.ADMIN_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

export function adminOriginAllowed(method: string | undefined, origin: string | undefined, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  if (origin === undefined) return !isUnsafeMethod(method);
  return allowed.includes(origin);
}
