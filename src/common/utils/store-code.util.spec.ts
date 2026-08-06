import { generateStoreCode, normalizeStoreCode, formatStoreCode } from './store-code.util';

describe('Store Account ID code', () => {
  describe('generateStoreCode', () => {
    it('produces 10 uppercase hex characters', () => {
      for (let i = 0; i < 200; i++) {
        expect(generateStoreCode()).toMatch(/^[0-9A-F]{10}$/);
      }
    });

    it('is non-sequential / high-entropy (200 codes are distinct)', () => {
      const codes = new Set(Array.from({ length: 200 }, () => generateStoreCode()));
      expect(codes.size).toBe(200);
    });
  });

  describe('normalizeStoreCode', () => {
    it('accepts a canonical code unchanged', () => {
      expect(normalizeStoreCode('ABCDE12345')).toBe('ABCDE12345');
    });

    it('is case-insensitive and strips spaces and dashes', () => {
      expect(normalizeStoreCode(' abcde-12345 ')).toBe('ABCDE12345');
      expect(normalizeStoreCode('abcd e123 45')).toBe('ABCDE12345');
    });

    it('tolerates the classic misreadings O->0 and I/L->1', () => {
      // A code never contains O, I or L (not hex), so mapping them is always safe.
      // O->0, I->1, L->1: 'OIL0000000' -> '0110000000'.
      expect(normalizeStoreCode('OIL0000000')).toBe('0110000000');
      expect(normalizeStoreCode('B00BIE5EED')).toBe('B00B1E5EED');
    });

    it('rejects anything that is not a 10-char hex code', () => {
      for (const bad of ['', 'ABC', 'GHIJKLMNOP', 'ABCDE1234', 'ABCDE123456', 'ZZZZZZZZZZ', 12345 as never]) {
        expect(normalizeStoreCode(bad)).toBeNull();
      }
    });

    it('round-trips a generated code', () => {
      for (let i = 0; i < 50; i++) {
        const code = generateStoreCode();
        expect(normalizeStoreCode(formatStoreCode(code).toLowerCase())).toBe(code);
      }
    });
  });

  describe('formatStoreCode', () => {
    it('groups as XXXXX-XXXXX', () => {
      expect(formatStoreCode('ABCDE12345')).toBe('ABCDE-12345');
    });
  });
});
