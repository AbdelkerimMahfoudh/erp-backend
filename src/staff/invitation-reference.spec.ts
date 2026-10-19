import { formatReference, joinLink, newReference, normaliseReference, referenceHash, STAFF_INVITATION_TTL_MS } from './invitation-reference';

/** The employee invitation's reference (0101, D214): random, readable, typed forgivingly, stored only as a keyed hash. */

const KEY = 'a-staff-invitation-key-for-tests-32+chars';

describe('a new reference', () => {
  it('twelve characters of Crockford base32 — no I, L, O or U — shown in three groups of four', () => {
    for (let i = 0; i < 200; i++) {
      const r = newReference();
      expect(r).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
      expect(formatReference(r)).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    }
  });

  it('never repeats in practice (60 random bits)', () => {
    const seen = new Set(Array.from({ length: 5000 }, newReference));
    expect(seen.size).toBe(5000);
  });

  it('its link opens the join form with the reference, and carries nothing else', () => {
    expect(joinLink('K7QM9XRT2CHD')).toBe('dukanerp://join?ref=K7QM-9XRT-2CHD');
  });

  it('lives 72 hours', () => {
    expect(STAFF_INVITATION_TTL_MS).toBe(72 * 60 * 60 * 1000);
  });
});

describe('what a person types', () => {
  it('separators, spaces and case do not matter; O reads as 0, I and L as 1', () => {
    expect(normaliseReference('k7qm-9xrt-2chd')).toBe('K7QM9XRT2CHD');
    expect(normaliseReference(' K7QM 9XRT 2CHD ')).toBe('K7QM9XRT2CHD');
    expect(normaliseReference('O1IL-0000-0000')).toBe('011100000000');
  });

  it('anything that cannot be a reference is refused before any lookup', () => {
    for (const typed of ['', 'K7QM-9XRT', 'K7QM-9XRT-2CHDX', 'K7QM-9XRT-2CHU', 'K7QM-9XRT-2CH!', 'x'.repeat(100), 42, null, undefined]) {
      expect(normaliseReference(typed)).toBeNull();
    }
  });
});

describe('the stored hash', () => {
  it('an HMAC under the invitation key: 64 hex characters, the same for the same reference, never the reference', () => {
    const h = referenceHash(KEY, 'K7QM9XRT2CHD');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(referenceHash(KEY, 'K7QM9XRT2CHD')).toBe(h);
    expect(h).not.toContain('K7QM9XRT2CHD');
    expect(referenceHash(KEY, 'K7QM9XRT2CHE')).not.toBe(h);
  });

  it('another key — any other secret — gives another hash', () => {
    expect(referenceHash(`${KEY}-other`, 'K7QM9XRT2CHD')).not.toBe(referenceHash(KEY, 'K7QM9XRT2CHD'));
  });
});
