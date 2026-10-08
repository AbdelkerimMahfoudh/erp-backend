import type { ActivityNeed } from './activity';
import { isMutation } from './route-classification';

/**
 * Which routes a branch's activity gates (D156; docs/73 §2).
 *
 * One list, in one file, beside the entitlement classification and for the
 * same reason: a check scattered across controllers cannot be audited and is
 * forgotten on the next endpoint. The rule is narrow on purpose:
 *
 *  - **reads are never gated** — an agent branch may look at anything the
 *    shop owns, and expiry's "you can still read everything" promise holds for
 *    activities too;
 *  - **writes under `agent/`** need the money services agent counter;
 *  - **the electronics writes named below** — the counter, intake, returns,
 *    moving stock and setting prices — need the electronics store;
 *  - `both` satisfies either, and everything else (expenses, the closing,
 *    staff, settings, the catalogue, …) belongs to every branch whatever it
 *    does, because a shop of either kind has those.
 *
 * The company-level entitlement runs first and is untouched: an expired shop
 * is read-only for both activities exactly as it was.
 */

/** Everything under here is the agent ledger; its writes need `money_agent` or `both`. */
export const AGENT_PREFIX = 'agent';

export interface GatedPrefix {
  /** The route path's first segment, as Nest sees it without the prefix and version. */
  prefix: string;
  why: string;
}

/** The electronics writes. Each prefix covers the whole controller beneath it. */
export const ELECTRONICS_WRITE_PREFIXES: readonly GatedPrefix[] = [
  { prefix: 'sales', why: 'Selling, taking a later payment and starting a return are the electronics counter' },
  { prefix: 'purchases', why: 'Receiving stock from a supplier, by hand or from a delivery file' },
  { prefix: 'units', why: 'Changing a stocked unit — marking it faulty, editing it' },
  { prefix: 'imports', why: 'Importing stock from a spreadsheet' },
  { prefix: 'returns', why: 'The return, investigation and refund workflow' },
  { prefix: 'transfers', why: 'Moving stock between stores, and the transfer numbering' },
  { prefix: 'consignments', why: 'Stock placed with a partner store' },
  { prefix: 'pricing', why: 'Setting a selling price on a product or a unit' },
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
  if (ELECTRONICS_WRITE_PREFIXES.some((rule) => under(path, rule.prefix))) return 'electronics';
  return null;
}
