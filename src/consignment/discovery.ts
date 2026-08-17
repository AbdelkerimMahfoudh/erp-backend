/**
 * Finding another shop, without letting anybody enumerate the platform
 * (Milestone H, H-CP2).
 *
 * Discovery is the one place this application deliberately shows one tenant
 * something about another, so the rules are written here as data rather than
 * scattered through a query builder. Everything that is not listed is not
 * exposed.
 *
 * The property that matters most is the one that is easiest to lose: **a
 * search that finds nothing must be indistinguishable from a search that found
 * something it is not allowed to show you.** If "no such store" and "that store
 * blocked you" are different answers, the difference is an oracle — somebody can
 * learn who exists, and who has blocked them, by watching which error comes
 * back.
 */

/** How somebody is looking for a shop. */
export type SearchMode = 'storeId' | 'phone' | 'name';

/**
 * What a stranger may see before any connection exists.
 *
 * Deliberately tiny. A shop that turns discovery on is agreeing to be findable,
 * not to publish its business.
 */
export interface PublicStorePreview {
  publicStoreId: string;
  name: string;
  city: string | null;
  logoRef: string | null;
  /**
   * A literal placeholder, not a claim. Nothing verifies these shops today, and
   * a badge that appears to mean something it does not is worse than no badge —
   * somebody would extend credit on the strength of it.
   */
  verification: 'Verified badge coming soon';
}

/**
 * Fields that must NEVER appear in a discovery result.
 *
 * Listed explicitly so the test can assert on the list rather than on whatever
 * the shaper happens to return today. The binary `id` is first because it is
 * the key the tenant extension scopes every other query on: publishing it hands
 * one tenant the identifier used to isolate another.
 */
export const NEVER_PUBLIC = [
  'id',
  'branches',
  'users',
  'units',
  'products',
  'sales',
  'suppliers',
  'purchases',
  'settingsJson',
  'currency',
  'publicPhone',
] as const;

/** Bounds, so a search cannot become a directory dump. */
export const SEARCH_LIMITS = {
  /** Enough to pick from, far too few to harvest. */
  maxResults: 10,
  /**
   * A name search needs a real prefix. Two characters would return a large
   * slice of the platform, which is enumeration wearing a search box.
   */
  minNameLength: 3,
  /** A Store Account ID is 10 hex characters and matched whole. */
  storeIdLength: 10,
} as const;

export class SearchRejected extends Error {}

export interface ParsedQuery {
  mode: SearchMode;
  /** Normalised for comparison: trimmed, and upper-cased for a store id. */
  value: string;
  /** Exact-match modes cannot be used to sweep; a name prefix is capped. */
  exact: boolean;
}

const DIGITS = /^[0-9+\s-]{6,20}$/;
const STORE_ID = /^[0-9A-F]{10}$/;

/**
 * Decide what kind of search this is, and refuse anything too broad to be one.
 *
 * The mode is inferred rather than asked, because a shopkeeper typing a code
 * they were given should not first have to classify it.
 */
export function parseQuery(raw: string): ParsedQuery {
  const q = (raw ?? '').trim();
  if (!q) throw new SearchRejected('Type a store ID, a phone number, or a store name');

  const upper = q.toUpperCase();
  if (STORE_ID.test(upper)) return { mode: 'storeId', value: upper, exact: true };

  // Checked before the name branch: a phone number is mostly digits and would
  // otherwise be treated as a very odd shop name.
  if (DIGITS.test(q)) {
    return { mode: 'phone', value: q.replace(/[\s-]/g, ''), exact: true };
  }

  if (q.length < SEARCH_LIMITS.minNameLength) {
    throw new SearchRejected(
      `Type at least ${SEARCH_LIMITS.minNameLength} letters of the store's name`,
    );
  }
  return { mode: 'name', value: q, exact: false };
}

/**
 * Shape a company into the only view a stranger is allowed.
 *
 * Takes the whole row and returns the four fields, rather than being handed
 * pre-selected columns — so that adding a column to `companies` cannot
 * accidentally widen what discovery publishes.
 */
export function toPublicPreview(company: {
  publicStoreId: string;
  name: string;
  city: string | null;
  logoRef: string | null;
}): PublicStorePreview {
  return {
    publicStoreId: company.publicStoreId,
    name: company.name,
    city: company.city,
    logoRef: company.logoRef,
    verification: 'Verified badge coming soon',
  };
}

/**
 * Whether a shop may appear in another shop's results.
 *
 * All three reasons collapse to the same answer — absent — on purpose:
 *
 *   - it is not discoverable;
 *   - it is inactive;
 *   - either side has blocked the other.
 *
 * A blocked searcher gets exactly the result they would get for a shop that
 * never existed. That is the whole anti-oracle property, and it is why blocking
 * filters here rather than producing a distinct error further down.
 */
export function isVisibleInSearch(input: {
  isDiscoverable: boolean;
  isActive: boolean;
  blockedEitherWay: boolean;
  isSelf: boolean;
}): boolean {
  if (input.isSelf) return false;
  if (!input.isDiscoverable || !input.isActive) return false;
  return !input.blockedEitherWay;
}

/**
 * What the searcher may additionally see once a connection is accepted.
 *
 * Contact details and nothing else. Acceptance is permission to do business,
 * not permission to inspect a business.
 */
export interface ConnectedStoreDetail extends PublicStorePreview {
  phone: string | null;
}

export function toConnectedDetail(
  company: { publicStoreId: string; name: string; city: string | null; logoRef: string | null; publicPhone: string | null },
  accepted: boolean,
): ConnectedStoreDetail {
  return {
    ...toPublicPreview(company),
    // Withheld until acceptance, so a connection request cannot be used as a
    // way to harvest phone numbers.
    phone: accepted ? company.publicPhone : null,
  };
}
