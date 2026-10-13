import {
  LINK_REFUSAL,
  bindingDigest,
  bindingKey,
  linkBindingOf,
  linkOutcomeOf,
  revokeUsableLinks,
  type LinkBinding,
  type SetupLinkFacts,
} from './trial-link';

/**
 * What a setup link is worth to the signed-in Owner who presents it (0095; docs/76 §5.3) — pure.
 *
 * The link is a convenience, never a key: these rules only ever decide whether a claim may go WITH it, and the order
 * they are asked in is part of the contract — another person's link is answered before anything about it is told.
 */

const KEY = 'test-pepper-at-least-32-characters-long!!';
const COMPANY = Buffer.alloc(16, 1);
const OWNER = Buffer.alloc(16, 2);
const NOW = new Date('2026-10-13T10:00:00.000Z');
const OWNER_AS_SENT: LinkBinding = {
  passwordHash: '$argon2id$v=19$owner',
  email: 'owner@shop.test',
  phone: '+22236001234',
  emailVerifiedAt: new Date('2026-10-12T08:00:00.000Z'),
  phoneVerifiedAt: null,
};

function link(over: Partial<SetupLinkFacts> = {}): SetupLinkFacts {
  return {
    companyId: COMPANY,
    userId: OWNER,
    bindingDigest: bindingDigest(KEY, OWNER_AS_SENT),
    expiresAt: new Date(NOW.getTime() + 3600_000),
    consumedAt: null,
    revokedAt: null,
    ...over,
  };
}
const me = { companyId: COMPANY, userId: OWNER };
const current = bindingDigest(KEY, OWNER_AS_SENT);

describe('the key a link is bound under', () => {
  it('is the OTP pepper whenever there is one', () => {
    expect(bindingKey(KEY, { NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(KEY);
  });

  it('falls back to a fixed development key only on a development machine', () => {
    expect(bindingKey(null, { NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toMatch(/development/);
    expect(bindingKey(null, { NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toMatch(/development/);
  });

  it('is null in production and staging without a pepper — then nothing can be bound or trusted', () => {
    expect(bindingKey(null, { NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBeNull();
    expect(bindingKey(null, { NODE_ENV: 'development', APP_ENV: 'production' } as NodeJS.ProcessEnv)).toBeNull();
    expect(bindingKey(null, { NODE_ENV: 'production', APP_ENV: 'staging' } as NodeJS.ProcessEnv)).toBeNull();
    expect(bindingKey(null, { NODE_ENV: 'development', APP_ENV: 'Staging' } as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('the binding a link is issued with and checked against', () => {
  it('is the digest under the key — one function for issuing and checking — or null when there is no key', () => {
    expect(linkBindingOf(KEY, OWNER_AS_SENT, { NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(current);
    expect(linkBindingOf(null, OWNER_AS_SENT, { NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBeNull();
    expect(linkBindingOf(null, OWNER_AS_SENT, { NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(
      bindingDigest(bindingKey(null, { NODE_ENV: 'development' } as NodeJS.ProcessEnv)!, OWNER_AS_SENT),
    );
  });
});

describe('the binding digest', () => {
  it('is a keyed SHA-256: 64 hex characters, the same for the same Owner, different under another key', () => {
    expect(current).toMatch(/^[0-9a-f]{64}$/);
    expect(bindingDigest(KEY, { ...OWNER_AS_SENT })).toBe(current);
    expect(bindingDigest('another-key-that-is-at-least-32-chars', OWNER_AS_SENT)).not.toBe(current);
  });

  it.each([
    ['the password', { passwordHash: '$argon2id$v=19$changed' }],
    ['the email', { email: 'new@shop.test' }],
    ['the number', { phone: '+22236009999' }],
    ['the email verification', { emailVerifiedAt: new Date('2026-10-13T08:00:00.000Z') }],
    ['a number verified since', { phoneVerifiedAt: new Date('2026-10-13T08:00:00.000Z') }],
    ['a contact removed', { email: null }],
  ])('changes when %s changes — the link sent before no longer matches', (_what, change) => {
    expect(bindingDigest(KEY, { ...OWNER_AS_SENT, ...change })).not.toBe(current);
  });

  it('holds the password’s hash only as keyed material — never readable back from the digest', () => {
    expect(current).not.toContain('argon2');
    expect(current).not.toContain('owner@shop.test');
  });
});

describe('a link’s outcome, in its order', () => {
  it('valid: the caller’s own, unused, unrevoked, unexpired, still bound to them', () => {
    expect(linkOutcomeOf(link(), me, NOW, current)).toBe('valid');
  });

  it('invalid: no row for the token — forged, mistyped or never sent', () => {
    expect(linkOutcomeOf(null, me, NOW, current)).toBe('invalid');
  });

  it('other_account before anything else is told — another business’s, or another person’s, whatever its state', () => {
    const elsewhere = { companyId: Buffer.alloc(16, 9), userId: OWNER };
    const someoneElse = { companyId: COMPANY, userId: Buffer.alloc(16, 8) };
    for (const caller of [elsewhere, someoneElse]) {
      expect(linkOutcomeOf(link(), caller, NOW, current)).toBe('other_account');
      expect(linkOutcomeOf(link({ consumedAt: NOW, revokedAt: NOW, expiresAt: NOW }), caller, NOW, current)).toBe('other_account');
    }
  });

  it('used, then revoked, then expired, then a stale binding — the first that applies answers', () => {
    expect(linkOutcomeOf(link({ consumedAt: NOW, revokedAt: NOW }), me, NOW, current)).toBe('used');
    expect(linkOutcomeOf(link({ revokedAt: NOW, expiresAt: new Date(NOW.getTime() - 1) }), me, NOW, current)).toBe('revoked');
    expect(linkOutcomeOf(link({ expiresAt: NOW }), me, NOW, 'f'.repeat(64))).toBe('expired');
    expect(linkOutcomeOf(link(), me, NOW, bindingDigest(KEY, { ...OWNER_AS_SENT, passwordHash: 'changed' }))).toBe('revoked');
  });

  it('expires exactly at its end: valid the millisecond before', () => {
    const end = new Date(NOW.getTime() + 24 * 3600_000);
    expect(linkOutcomeOf(link({ expiresAt: end }), me, new Date(end.getTime() - 1), current)).toBe('valid');
    expect(linkOutcomeOf(link({ expiresAt: end }), me, end, current)).toBe('expired');
  });

  it('with no key to compute the Owner’s digest, a link is never valid', () => {
    expect(linkOutcomeOf(link(), me, NOW, null)).toBe('revoked');
  });

  it('a claim carrying a link that is not valid is refused with the link’s own code', () => {
    expect(LINK_REFUSAL).toEqual({
      invalid: 'link_invalid',
      expired: 'link_expired',
      used: 'link_used',
      revoked: 'link_revoked',
      other_account: 'link_other_account',
    });
  });
});

describe('retiring links', () => {
  it('touches only links that could still be used, and says why they stop working', () => {
    expect(revokeUsableLinks({ userId: OWNER }, 'contact_changed', NOW)).toEqual({
      where: { userId: OWNER, consumedAt: null, revokedAt: null },
      data: { revokedAt: NOW, revokedReason: 'contact_changed' },
    });
    expect(revokeUsableLinks({ companyId: COMPANY, userId: OWNER }, 'deleted', NOW).where).toEqual({
      companyId: COMPANY,
      userId: OWNER,
      consumedAt: null,
      revokedAt: null,
    });
  });
});
