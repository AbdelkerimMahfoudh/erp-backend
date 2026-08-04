import { binToUuid, isUuid, newUuidV7, newUuidV7Bin, uuidToBin } from './uuid.util';

describe('uuid.util', () => {
  it('round-trips string <-> binary', () => {
    const uuid = newUuidV7();
    const bin = uuidToBin(uuid);
    expect(bin).toHaveLength(16);
    expect(binToUuid(bin)).toBe(uuid);
  });

  it('generates version-7, variant-10 UUIDs', () => {
    const bin = newUuidV7Bin();
    expect((bin[6] & 0xf0) >> 4).toBe(0x7); // version nibble
    expect((bin[8] & 0xc0) >> 6).toBe(0b10); // variant bits
  });

  it('is time-ordered by the 48-bit timestamp prefix', () => {
    const a = newUuidV7Bin();
    const b = newUuidV7Bin();
    // The random tail may order either way within the same ms; the timestamp
    // prefix (bytes 0..5) is monotonically non-decreasing.
    expect(Buffer.compare(a.subarray(0, 6), b.subarray(0, 6))).toBeLessThanOrEqual(0);
  });

  it('validates and rejects malformed input', () => {
    expect(isUuid(newUuidV7())).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(() => uuidToBin('nope')).toThrow();
    expect(() => binToUuid(Buffer.alloc(8))).toThrow();
  });
});
