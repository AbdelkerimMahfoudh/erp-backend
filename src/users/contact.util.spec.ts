import { toE164, isValidEmail } from './contact.util';

/**
 * Phone is the future OTP and recovery channel, and the per-company unique index
 * only means something if two spellings of one number collapse to one string.
 * These tests pin the normalization and the rejection boundary.
 */
describe('toE164', () => {
  it('accepts a clean international number unchanged', () => {
    expect(toE164('+22231234567')).toBe('+22231234567');
  });

  it('strips spaces, dashes, dots and parentheses', () => {
    expect(toE164(' +222 31-23-45-67 ')).toBe('+22231234567');
    expect(toE164('+222 (31) 23.45.67')).toBe('+22231234567');
  });

  it('rewrites a leading 00 international prefix to +', () => {
    expect(toE164('0022231234567')).toBe('+22231234567');
  });

  it('rejects a number with no country/plus', () => {
    expect(toE164('31234567')).toBeNull();
  });

  it('rejects a leading zero after the plus (not a valid E.164 country digit)', () => {
    expect(toE164('+022231234567')).toBeNull();
  });

  it('rejects too-short and too-long numbers', () => {
    expect(toE164('+1234')).toBeNull(); // < 8 digits
    expect(toE164('+1234567890123456')).toBeNull(); // > 15 digits
  });

  it('rejects letters and empty input', () => {
    expect(toE164('not a phone')).toBeNull();
    expect(toE164('')).toBeNull();
    expect(toE164('   ')).toBeNull();
  });
});

describe('isValidEmail', () => {
  it('accepts a plain address', () => {
    expect(isValidEmail('owner@shop.mr')).toBe(true);
  });

  it('rejects malformed and empty addresses', () => {
    for (const bad of ['', 'nope', 'a@b', 'a@@b.co', 'a b@c.co', 'a@b.']) {
      expect(isValidEmail(bad)).toBe(false);
    }
  });

  it('rejects an over-long address', () => {
    expect(isValidEmail('a'.repeat(160) + '@x.co')).toBe(false);
  });
});
