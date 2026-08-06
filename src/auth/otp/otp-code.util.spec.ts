import {
  codeMatches,
  generateIntentToken,
  generateOtpCode,
  hashIntentToken,
  hashOtpCode,
  isWellFormedCode,
  maskPhone,
  OTP_DIGITS,
} from './otp-code.util';

/**
 * OTP secret primitives (F1 Stage 4A).
 *
 * The property that matters most is not "the hash is different" — it is that a
 * stolen `otp_challenges` table is useless without the pepper. A six-digit code
 * has a million candidates; an unkeyed digest of it is a lookup table, not a
 * one-way function. These tests pin the keying, the constant-time comparison
 * and the leading-zero case that a naive integer implementation silently drops.
 */

const PEPPER = 'test-pepper-at-least-32-characters-long!!';
const CHALLENGE = '018f0000-0000-7000-8000-00000000c001';

describe('code generation', () => {
  it('always produces exactly six digits', () => {
    for (let i = 0; i < 300; i++) {
      const code = generateOtpCode();
      expect(code).toHaveLength(OTP_DIGITS);
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it('produces codes with leading zeros, which a number would have eaten', () => {
    // ~10% of codes start with 0. Over 400 draws, seeing none would mean the
    // generator is formatting through a number somewhere.
    const codes = Array.from({ length: 400 }, () => generateOtpCode());
    expect(codes.some((c) => c.startsWith('0'))).toBe(true);
    // And the string must survive intact, not be re-parsed.
    for (const c of codes) expect(String(Number(c)).padStart(6, '0')).toBe(c);
  });

  it('does not repeat trivially', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateOtpCode()));
    // A stuck generator would collapse to a handful of values.
    expect(codes.size).toBeGreaterThan(150);
  });

  it('accepts only six ASCII digits as well-formed', () => {
    expect(isWellFormedCode('000123')).toBe(true);
    for (const bad of ['12345', '1234567', '12345a', '', '  1234', '१२३४५६']) {
      expect(isWellFormedCode(bad)).toBe(false);
    }
  });
});

describe('code hashing is keyed, not merely digested', () => {
  it('produces a different hash under a different pepper', () => {
    const a = hashOtpCode('123456', CHALLENGE, PEPPER);
    const b = hashOtpCode('123456', CHALLENGE, 'a-completely-different-pepper-value-32!!');
    expect(a).not.toEqual(b);
  });

  it('produces a different hash for the same code in a different challenge', () => {
    // Otherwise identical hashes would reveal that two live challenges share a
    // code, and a hash lifted from one row could be matched against another.
    const a = hashOtpCode('123456', CHALLENGE, PEPPER);
    const b = hashOtpCode('123456', '018f0000-0000-7000-8000-00000000c002', PEPPER);
    expect(a).not.toEqual(b);
  });

  it('never contains the code itself', () => {
    const hash = hashOtpCode('123456', CHALLENGE, PEPPER);
    expect(hash).not.toContain('123456');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses to hash without a pepper rather than using an empty key', () => {
    expect(() => hashOtpCode('123456', CHALLENGE, '')).toThrow(/pepper is not configured/i);
  });
});

describe('verification', () => {
  const hash = hashOtpCode('000123', CHALLENGE, PEPPER);

  it('accepts the right code', () => {
    expect(codeMatches('000123', hash, CHALLENGE, PEPPER)).toBe(true);
  });

  it('rejects the wrong code', () => {
    expect(codeMatches('000124', hash, CHALLENGE, PEPPER)).toBe(false);
  });

  it('rejects the right code under the wrong pepper', () => {
    expect(codeMatches('000123', hash, CHALLENGE, 'another-pepper-value-of-length-32-ok!!')).toBe(false);
  });

  it('rejects the right code against another challenge', () => {
    expect(codeMatches('000123', hash, '018f0000-0000-7000-8000-00000000c002', PEPPER)).toBe(false);
  });

  it('rejects a malformed submission without throwing', () => {
    for (const bad of ['', '12345', 'abcdef', '1234567']) {
      expect(codeMatches(bad, hash, CHALLENGE, PEPPER)).toBe(false);
    }
  });

  it('compares fixed-width digests, so length can never leak', () => {
    // timingSafeEqual throws on unequal lengths; digesting both sides first is
    // what stops a truncated stored hash from crashing verification.
    expect(codeMatches('000123', 'short', CHALLENGE, PEPPER)).toBe(false);
  });
});

describe('verification-intent tokens', () => {
  it('are high-entropy and unique', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateIntentToken()));
    expect(tokens.size).toBe(200);
    // 32 bytes base64url ≈ 43 chars.
    expect(generateIntentToken().length).toBeGreaterThanOrEqual(40);
  });

  it('hash to a plain digest — no pepper needed at 256 bits', () => {
    const token = generateIntentToken();
    const hash = hashIntentToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashIntentToken(token)).toBe(hash);
  });
});

describe('phone masking', () => {
  it('keeps the country prefix and the last two digits only', () => {
    const masked = maskPhone('+22231234567');
    expect(masked.startsWith('+222')).toBe(true);
    expect(masked).toContain('***');
    expect(masked).not.toContain('3123456');
  });

  it('reveals nothing for a short value', () => {
    expect(maskPhone('+22')).toBe('***');
  });
});
