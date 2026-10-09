import type { ActivityNeed } from './activity';
import { isMutation } from './route-classification';

/**
 * Which routes a branch's activity gates (D156; docs/73 §2; narrowed after
 * review on 2026-10-09).
 *
 * One list, in one file, beside the entitlement classification and for the
 * same reason: a check scattered across controllers cannot be audited and is
 * forgotten on the next endpoint. The rule is narrow on purpose:
 *
 *  - **reads are never gated** — a branch may look at anything the shop owns,
 *    including the exchanges and stock it kept from an activity it no longer
 *    has, and expiry's "you can still read everything" promise holds too;
 *  - **writes under `agent/`** need the money services agent counter;
 *  - **acquiring and selling electronics** — a new sale, receiving stock
 *    (purchases, delivery files, spreadsheet imports) and placing a new
 *    consignment — need the electronics store;
 *  - **everything else stays open whatever the activity**, because money owed
 *    on existing records and stock already held must always be recordable at a
 *    branch that changed activity: a later payment on a sale, a payer-number
 *    correction, the return and refund workflow, a unit's correction or fault,
 *    transfers (a downgraded branch empties itself; a transfer INTO a branch
 *    that does not sell is refused by the transfer itself), consignment
 *    follow-ups, prices, the closing, expenses, staff, settings.
 *
 * `both` satisfies either. The company-level entitlement runs first and is
 * untouched: an expired shop is read-only for both activities exactly as it was.
 */

/** Everything under here is the agent ledger; its writes need `money_agent` or `both`. */
export const AGENT_PREFIX = 'agent';

export interface GatedRoute {
  /** The route path as Nest sees it without the prefix and version. */
  path: string;
  /** `exact`: this route only. `prefix`: it and everything beneath it. */
  match: 'exact' | 'prefix';
  why: string;
}

/** The electronics writes: acquiring and selling, nothing that settles or corrects what already exists. */
export const ELECTRONICS_WRITE_ROUTES: readonly GatedRoute[] = [
  { path: 'sales', match: 'exact', why: 'A new sale at the electronics counter' },
  { path: 'purchases', match: 'prefix', why: 'Receiving stock from a supplier, by hand or from a delivery file' },
  { path: 'imports', match: 'prefix', why: 'Importing stock from a spreadsheet' },
  { path: 'consignments', match: 'exact', why: 'Placing new stock with a partner store' },
] as const;

const clean = (path: string): string => path.replace(/^\/+|\/+$/g, '');

const under = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`);

/**
 * What a branch must be subscribed to for this route, or null when its
 * activity does not come into it.
 *
 * Takes the route path as Nest reports it (`sales/:id/payments`), with or
 * without the global prefix and version stripped — the interceptor normalises
 * before asking.
 */
export function requiredActivityFor(method: string, routePath: string): ActivityNeed | null {
  if (!isMutation(method)) return null;
  const path = clean(routePath);
  if (under(path, AGENT_PREFIX)) return 'money_agent';
  if (ELECTRONICS_WRITE_ROUTES.some((r) => (r.match === 'exact' ? path === r.path : under(path, r.path)))) return 'electronics';
  return null;
}
