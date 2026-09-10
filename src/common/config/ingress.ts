/**
 * How the API port is kept private, declared rather than guessed.
 *
 * `docs/39` §3 states the invariant this project actually holds:
 *
 * > "the API binds loopback only (`API_BIND=127.0.0.1`) and is reachable solely
 * > through the edge; **under Docker the same is achieved with `expose` rather
 * > than `ports`**."
 *
 * The invariant is **"the API port is reachable only through the edge"**. There
 * are two correct implementations of it and they need opposite bind addresses:
 *
 * - **`loopback`** — the API runs directly on a host it shares with the edge.
 *   Isolation comes from binding `127.0.0.1`, so nothing on the LAN can reach
 *   the port.
 * - **`network`** — the API runs in a container or on a private network.
 *   Isolation comes from the network: `deploy/docker-compose.staging.yml` uses
 *   `expose` rather than `ports`, and says in as many words *"Do NOT set
 *   `API_BIND=127.0.0.1` here … Inside a container it would bind the
 *   container's own loopback and the edge could never reach it."*
 *
 * A previous version of the startup guard rejected `0.0.0.0` outright. That
 * encoded the first implementation as if it were the invariant, and it would
 * have **refused to start this project's own staging stack**.
 *
 * ## Why this is declared and not detected
 *
 * The application cannot tell the difference from inside. `/.dockerenv` is a
 * convention, not a guarantee; a container can be run with `--network host`;
 * a bare-metal process can sit behind a firewall that isolates it just as well.
 * Guessing wrong is silent in both directions — a wrong "network" trusts
 * forwarded headers that nobody is rewriting, and a wrong "loopback" refuses to
 * start something that was correctly configured.
 *
 * So the operator states it, and this file checks the settings that follow are
 * consistent with what they stated. **It does not choose an architecture**, and
 * both values are equally supported.
 */

export const INGRESS_MODES = ['loopback', 'network'] as const;
export type IngressMode = (typeof INGRESS_MODES)[number];

export function isIngressMode(value: string | undefined): value is IngressMode {
  return (INGRESS_MODES as readonly string[]).includes(value ?? '');
}

/**
 * Addresses that mean "only this machine".
 *
 * `::1` and the IPv4-mapped form are included because a Node process given
 * `::` binds both stacks, and an operator writing `::1` means the same thing as
 * `127.0.0.1`.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);

export function isLoopbackAddress(bind: string | undefined): boolean {
  return LOOPBACK.has((bind ?? '').trim());
}

/**
 * How many proxy hops to trust, given the declared ingress.
 *
 * This is what makes `req.ip` the CLIENT rather than the edge — and `req.ip` is
 * what the rate limiter keys on and what the login audit row records. Behind a
 * proxy with no trust configured, every request appears to come from the same
 * address, so `AUTH_THROTTLE_LIMIT` becomes a global budget shared by every
 * user on the platform instead of a per-client one: one noisy client locks
 * everybody out, and a distributed brute force is invisible.
 *
 * Trusting is not free, which is why it is tied to the declaration. If the API
 * is directly reachable, anyone can send `X-Forwarded-For` and choose their own
 * rate-limit bucket and their own audit trail. So:
 *
 * - **`network`** — exactly **one** hop. The edge in front is the only thing
 *   that can reach the port, and it rewrites the header. Trusting one hop takes
 *   the address the edge appended and ignores anything the client claimed
 *   beyond it.
 * - **`loopback`** — trust the loopback address only. The edge is on this
 *   machine; nothing else can connect at all.
 * - **unset (development)** — trust nothing. `req.ip` is the peer, which on a
 *   developer's machine is the truth.
 */
export function trustProxySetting(mode: IngressMode | undefined): number | string | boolean {
  if (mode === 'network') return 1;
  if (mode === 'loopback') return 'loopback';
  return false;
}
