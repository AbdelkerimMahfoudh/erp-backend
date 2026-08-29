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

/**
 * Whether session cookies are marked `Secure`.
 *
 * `NODE_ENV === 'production'` alone was the rule, and it is wrong for exactly
 * one environment that matters: a staging host served over plain HTTP with
 * `NODE_ENV=production` — which is what `.env.staging` sets, so the build is
 * production-like. A `Secure` cookie is silently DISCARDED by the browser on a
 * plain-HTTP origin, and `localhost` hides it, because browsers treat localhost
 * as trustworthy and keep the cookie anyway.
 *
 * The CP8 acceptance walked the handoff twice. On `http://localhost:8088` the
 * Owner landed signed in. On `http://192.168.100.3:8088` — the LAN path
 * `docs/39` keeps open precisely so a phone can test the portal — the exchange
 * succeeded, the cookie was set, the browser threw it away, and the Owner was
 * shown a password form.
 *
 * So the flag follows an explicit setting when there is one, and `NODE_ENV`
 * only when there is not. **Production must leave this unset**, or set it to
 * `true`: turning it off means session cookies travel in clear text.
 */
export function cookieSecure(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env.COOKIE_SECURE?.trim().toLowerCase();
  if (explicit === 'true' || explicit === '1') return true;
  if (explicit === 'false' || explicit === '0') return false;
  return env.NODE_ENV === 'production';
}
