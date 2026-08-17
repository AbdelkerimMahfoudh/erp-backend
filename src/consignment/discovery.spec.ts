import {
  isVisibleInSearch,
  NEVER_PUBLIC,
  parseQuery,
  SEARCH_LIMITS,
  SearchRejected,
  toConnectedDetail,
  toPublicPreview,
} from './discovery';

/**
 * Store discovery (H-CP2).
 *
 * This is the one place the application deliberately shows one tenant something
 * about another, so these tests are less about features and more about what
 * must never leak.
 */

const company = {
  id: Buffer.from('ff'.repeat(16), 'hex'),
  publicStoreId: 'F62B8D1EEB',
  name: 'Nouakchott Phones',
  city: 'Nouakchott',
  logoRef: '/logos/abc.png',
  publicPhone: '+22200000000',
  currency: 'MRU',
  settingsJson: {},
};

describe('what a stranger may see', () => {
  it('is exactly four things', () => {
    expect(toPublicPreview(company)).toEqual({
      publicStoreId: 'F62B8D1EEB',
      name: 'Nouakchott Phones',
      city: 'Nouakchott',
      logoRef: '/logos/abc.png',
      verification: 'Verified badge coming soon',
    });
  });

  it('never includes the binary company id', () => {
    /**
     * First on the forbidden list because it is the key the tenant extension
     * scopes every other query on. Publishing it hands one tenant the
     * identifier used to isolate another.
     */
    const preview = toPublicPreview(company) as unknown as Record<string, unknown>;
    expect(preview.id).toBeUndefined();
    expect(Object.values(preview)).not.toContain(company.id);
  });

  it('never includes anything on the forbidden list', () => {
    const preview = toPublicPreview(company) as unknown as Record<string, unknown>;
    for (const field of NEVER_PUBLIC) {
      expect(preview[field]).toBeUndefined();
    }
  });

  it('takes the whole row rather than pre-selected columns', () => {
    /**
     * So that adding a column to `companies` cannot accidentally widen what
     * discovery publishes. A shaper handed only four fields would silently pass
     * through a fifth the day somebody selected it.
     */
    const preview = toPublicPreview(company);
    expect(Object.keys(preview).sort()).toEqual(
      ['city', 'logoRef', 'name', 'publicStoreId', 'verification'].sort(),
    );
  });

  it('says the badge is coming, and claims nothing', () => {
    /**
     * Nothing verifies these shops today. A badge that appears to mean
     * something it does not is worse than no badge — somebody would extend
     * credit on the strength of it.
     */
    expect(toPublicPreview(company).verification).toBe('Verified badge coming soon');
  });
});

describe('the phone number is withheld until acceptance', () => {
  it('is null before a connection is accepted', () => {
    /**
     * Otherwise a connection request becomes a way to harvest phone numbers:
     * send one to every shop, read the detail, never accept.
     */
    expect(toConnectedDetail(company, false).phone).toBeNull();
  });

  it('appears once it is', () => {
    expect(toConnectedDetail(company, true).phone).toBe('+22200000000');
  });

  it('adds nothing else on acceptance', () => {
    /**
     * Acceptance is permission to do business, not permission to inspect a
     * business.
     */
    expect(Object.keys(toConnectedDetail(company, true)).sort()).toEqual(
      ['city', 'logoRef', 'name', 'phone', 'publicStoreId', 'verification'].sort(),
    );
  });
});

describe('how a search is interpreted', () => {
  it('recognises a Store Account ID and matches it whole', () => {
    expect(parseQuery('f62b8d1eeb')).toEqual({ mode: 'storeId', value: 'F62B8D1EEB', exact: true });
  });

  it('recognises a phone number and strips its punctuation', () => {
    expect(parseQuery('+222 00-00 0000')).toMatchObject({ mode: 'phone', value: '+22200000000', exact: true });
  });

  it('checks the phone shape BEFORE the name shape', () => {
    // A phone number is mostly digits and would otherwise be treated as a very
    // odd shop name, then matched as a prefix against nothing.
    expect(parseQuery('22200000').mode).toBe('phone');
  });

  it('treats anything else as a name prefix', () => {
    expect(parseQuery('Nouak')).toEqual({ mode: 'name', value: 'Nouak', exact: false });
  });

  it('refuses a name too short to be a search', () => {
    /**
     * Two characters would return a large slice of the platform, which is
     * enumeration wearing a search box.
     */
    expect(() => parseQuery('No')).toThrow(SearchRejected);
    expect(() => parseQuery('No')).toThrow(/at least 3/);
  });

  it('refuses an empty query rather than listing everybody', () => {
    expect(() => parseQuery('   ')).toThrow(SearchRejected);
  });

  it('caps how many results a search can ever return', () => {
    expect(SEARCH_LIMITS.maxResults).toBeLessThanOrEqual(10);
  });
});

describe('a blocked searcher gets the same answer as a stranger', () => {
  const base = { isDiscoverable: true, isActive: true, blockedEitherWay: false, isSelf: false };

  it('shows a discoverable, active, unblocked store', () => {
    expect(isVisibleInSearch(base)).toBe(true);
  });

  it.each([
    ['not discoverable', { isDiscoverable: false }],
    ['inactive', { isActive: false }],
    ['blocked either way', { blockedEitherWay: true }],
    ['yourself', { isSelf: true }],
  ])('hides a store that is %s', (_why, over) => {
    expect(isVisibleInSearch({ ...base, ...over })).toBe(false);
  });

  it('collapses every reason to the SAME answer', () => {
    /**
     * The anti-oracle property, asserted directly. If "no such store", "not
     * discoverable" and "they blocked you" were distinguishable, somebody could
     * learn who exists and who has blocked them by watching which answer came
     * back. All three are simply absent.
     */
    const reasons = [
      { ...base, isDiscoverable: false },
      { ...base, isActive: false },
      { ...base, blockedEitherWay: true },
    ];
    const answers = new Set(reasons.map((r) => isVisibleInSearch(r)));
    expect(answers.size).toBe(1);
    expect([...answers]).toEqual([false]);
  });

  it('hides a block in EITHER direction', () => {
    /**
     * One flag covers both, deliberately. If only "they blocked me" hid the
     * result, a shop that blocked somebody would keep seeing them in search —
     * and blocking would half work in the direction that matters least.
     */
    expect(isVisibleInSearch({ ...base, blockedEitherWay: true })).toBe(false);
  });
});
