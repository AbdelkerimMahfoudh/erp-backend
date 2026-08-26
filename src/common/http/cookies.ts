/**
 * Cookie names and a reader, with no dependencies of their own.
 *
 * Deliberately its own module. The JWT strategy needs the portal cookie's name,
 * and the portal handoff service needs the auth services — so putting the name
 * beside the handoff service would make `jwt.strategy → portal-handoff →
 * sessions → …` a cycle, and a constant read during module initialisation of a
 * cycle is `undefined` rather than an error. That failure looks like "the
 * cookie is simply never found".
 */

/** The platform administrator's session. Reaches every business; never a script's to read. */
export const ADMIN_SESSION_COOKIE = 'erp_platform_session';

/**
 * The Owner's customer-portal session, established by the one-time handoff from
 * the mobile app. `HttpOnly`, so no script on the page can read it, and
 * `SameSite=Lax`, so a cross-site POST does not carry it.
 */
export const PORTAL_SESSION_COOKIE = 'erp_portal_session';

/**
 * Pull one cookie out of a raw `Cookie` header.
 *
 * Hand-rolled because nothing else here needs a cookie parser, and a dependency
 * that exists to split a string on `;` is a dependency to keep patched forever.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}
