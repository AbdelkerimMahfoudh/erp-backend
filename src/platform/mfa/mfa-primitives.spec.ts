import { base32Decode, base32Encode, generateTotpSecret, otpauthUri, stepAt, totpForStep, verifyTotp } from './totp';
import { keyedDigest, open, parseMfaKey, seal } from './secret-box';
import { generateRecoveryCodes, looksLikeRecoveryCode, normaliseRecoveryCode, RECOVERY_CODE_COUNT } from './recovery-codes';

/** The RFC 6238 Appendix B secret for SHA-1: the ASCII "12345678901234567890". */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC’s SHA-1 test vectors, as six digits', () => {
    // Appendix B gives eight digits; an authenticator shows the last six.
    const vectors: [number, string][] = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
      [20000000000, '353130'],
    ];
    for (const [seconds, code] of vectors) expect(totpForStep(RFC_SECRET, stepAt(seconds * 1000))).toBe(code);
  });

  it('base32 round-trips, and a new secret is 160 bits', () => {
    expect(base32Decode(RFC_SECRET).toString()).toBe('12345678901234567890');
    expect(base32Decode(generateTotpSecret())).toHaveLength(20);
    expect(() => base32Decode('not base32!')).toThrow();
  });

  it('accepts one step either side of now, never two; never a step at or before the last one used (replay)', () => {
    const now = 1111111111 * 1000;
    const step = stepAt(now);
    expect(verifyTotp(RFC_SECRET, totpForStep(RFC_SECRET, step), now, null)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpForStep(RFC_SECRET, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpForStep(RFC_SECRET, step + 1), now, null)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpForStep(RFC_SECRET, step - 2), now, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpForStep(RFC_SECRET, step + 2), now, null)).toBeNull();
    // The same code twice: the second time its step is not after the last one used.
    expect(verifyTotp(RFC_SECRET, totpForStep(RFC_SECRET, step), now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpForStep(RFC_SECRET, step - 1), now, step - 1)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpForStep(RFC_SECRET, step + 1), now, step)).toBe(step + 1);
  });

  it('refuses anything that is not six digits, and ignores spaces', () => {
    const now = 59_000;
    for (const bad of ['', '28708', '2870822', 'abcdef', '287 08x']) expect(verifyTotp(RFC_SECRET, bad, now, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, '287 082', now, null)).toBe(stepAt(now));
  });

  it('the otpauth link names the issuer and the account, and carries the key and its parameters', () => {
    const uri = otpauthUri({ issuer: 'Dukan ERP', account: 'ops@tsx.mr', secret: 'JBSWY3DPEHPK3PXP' });
    expect(uri.startsWith('otpauth://totp/Dukan%20ERP%3Aops%40tsx.mr?')).toBe(true);
    const params = new URL(uri.replace('otpauth://', 'https://x/')).searchParams;
    expect(Object.fromEntries(params)).toEqual({ secret: 'JBSWY3DPEHPK3PXP', issuer: 'Dukan ERP', algorithm: 'SHA1', digits: '6', period: '30' });
  });
});

describe('the secret box', () => {
  const key = Buffer.alloc(32, 7);

  it('opens what it sealed, never twice the same sealed form, and nothing under another key or tampered', () => {
    const a = seal('JBSWY3DPEHPK3PXP', key);
    expect(open(a, key)).toBe('JBSWY3DPEHPK3PXP');
    expect(seal('JBSWY3DPEHPK3PXP', key)).not.toBe(a);
    expect(a).not.toContain('JBSWY3DPEHPK3PXP');
    expect(open(a, Buffer.alloc(32, 8))).toBeNull();
    const parts = a.split(':');
    const flipped = parts[3][0] === 'A' ? `B${parts[3].slice(1)}` : `A${parts[3].slice(1)}`;
    expect(open([parts[0], parts[1], parts[2], flipped].join(':'), key)).toBeNull();
    expect(open('v2:x:y:z', key)).toBeNull();
    expect(open(null, key)).toBeNull();
  });

  it('a key is exactly 32 bytes, as base64 or hex; anything else is no key', () => {
    expect(parseMfaKey(Buffer.alloc(32, 1).toString('base64'))).toHaveLength(32);
    expect(parseMfaKey('ab'.repeat(32))).toHaveLength(32);
    for (const bad of [undefined, '', 'short', Buffer.alloc(16).toString('base64'), 'zz'.repeat(32)]) expect(parseMfaKey(bad)).toBeNull();
  });

  it('a keyed digest depends on the key', () => {
    expect(keyedDigest('x', key)).toMatch(/^[0-9a-f]{64}$/);
    expect(keyedDigest('x', key)).not.toBe(keyedDigest('x', Buffer.alloc(32, 8)));
  });
});

describe('recovery codes', () => {
  it('ten, distinct, XXXXX-XXXXX, typed in any case with or without the dash', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const c of codes) {
      expect(c).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
      expect(looksLikeRecoveryCode(c.toLowerCase().replace('-', ' '))).toBe(true);
      expect(normaliseRecoveryCode(` ${c.toLowerCase()} `)).toBe(c.replace('-', ''));
    }
    expect(looksLikeRecoveryCode('123456')).toBe(false);
  });
});
