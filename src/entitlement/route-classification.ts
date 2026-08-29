/**
 * Which routes stop when a subscription lapses (Milestone K).
 *
 * One list, in one file, rather than a check scattered across twenty-eight
 * controllers. Scattered checks are impossible to audit and trivially forgotten
 * on the next new endpoint — and the endpoint somebody forgets will be the one
 * that moves money.
 *
 * A mutation nobody has classified is a **drift-test failure**, not a silent
 * allow. That is the whole point: the failure mode of this file must be a red
 * build, never a shop writing business truth it has not paid for.
 */

export type WriteClass = 'blocked_when_expired' | 'always_allowed';

export interface RouteRule {
  /** Uppercase HTTP method. */
  method: string;
  /**
   * Path as Nest sees it, without the global prefix or version — e.g.
   * `sales`, `loans/:id/payment`. Matched exactly against the route path.
   */
  path: string;
  writeClass: WriteClass;
  why: string;
}

const allow = (method: string, path: string, why: string): RouteRule => ({
  method,
  path,
  writeClass: 'always_allowed',
  why,
});

/**
 * The short list of writes that survive expiry.
 *
 * Everything not named here is blocked. That default is deliberate: a new
 * endpoint added in a later milestone is refused for a lapsed shop until
 * somebody decides otherwise, which is the safe way round.
 */
export const ALWAYS_ALLOWED: readonly RouteRule[] = [
  allow('POST', 'auth/login', 'A shop must be able to sign in to reach its own history'),
  allow('POST', 'auth/refresh', 'Keeping an existing session alive is not new business truth'),
  allow('POST', 'auth/logout', 'Signing out must never be blocked; it is a security action'),
  allow(
    'POST',
    'auth/logout-all',
    'Revoking every session is how somebody responds to a lost phone, and a lapsed subscription is no reason to leave a stolen device signed in',
  ),
  allow(
    'POST',
    'platform/portal-handoff',
    'Every newly registered shop is pending by definition, and this is the route to the page where they find out what to pay. Blocking it would mean a shop could never reach the portal that ends the pending state — the one thing a lapsed or unstarted subscription most needs to allow. It mints a 90-second single-use ticket for a surface the caller already has authority over, creates no business record, and moves no money',
  ),
  allow(
    'POST',
    'notifications/:id/read',
    'Sets a flag on the reader own notification. Audited in J as changing no business truth, which is why it is also the one queueable operation needing no client uuid',
  ),
] as const;

const key = (method: string, path: string): string =>
  `${method.toUpperCase()} ${path.replace(/^\/+|\/+$/g, '')}`;

const ALLOWED_KEYS = new Set(ALWAYS_ALLOWED.map((r) => key(r.method, r.path)));

/** Methods that can change something. GET and HEAD never can. */
export const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

export function isMutation(method: string): boolean {
  return MUTATING_METHODS.includes(method.toUpperCase());
}

/**
 * Whether this route may run for a company whose subscription has expired.
 *
 * Reads always may. Mutations may only if explicitly named above.
 */
export function isAllowedWhenExpired(method: string, path: string): boolean {
  if (!isMutation(method)) return true;
  return ALLOWED_KEYS.has(key(method, path));
}

/**
 * Routes that consume a staff seat when they succeed.
 *
 * Kept beside the entitlement list because both answer "may this company do
 * this now", and separating them would let one drift from the other. A seat is
 * a headcount the shop pays for, NOT a permission — conflating the two would
 * make an ordinary role change a billing event.
 */
export const SEAT_CONSUMING: readonly { method: string; path: string }[] = [
  { method: 'POST', path: 'users' },
  { method: 'PATCH', path: 'users/:id' },
] as const;

const SEAT_KEYS = new Set(SEAT_CONSUMING.map((r) => key(r.method, r.path)));

export function isSeatConsumingRoute(method: string, path: string): boolean {
  return SEAT_KEYS.has(key(method, path));
}

/**
 * Reads that stay available however the subscription stands.
 *
 * The customer's own account surface: what state am I in, who am I, and how do
 * I sign out. A business that is pending or suspended keeps all of it, because
 * these are the routes that let the app *explain* the situation. Nothing here
 * returns operational business data — no sales, no stock, no money.
 */
export const ALWAYS_READABLE: readonly string[] = [
  'entitlement',
  'auth/me',
  'auth/logout',
  'auth/refresh',
  'health',
  // The customer's own account page. Reachable in EVERY state — it is where
  // somebody goes to find out why they cannot get in.
  'platform/my-subscription',
] as const;

export function isAlwaysReadable(path: string): boolean {
  return ALWAYS_READABLE.includes(path);
}
