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

  describe('monotonic within the process (RFC 9562 §6.2, method 1)', () => {
    const counterOf = (id: Buffer) => ((id[6] & 0x0f) << 8) | id[7];
    const wellFormed = (id: Buffer) => (id[6] & 0xf0) === 0x70 && (id[8] & 0xc0) === 0x80;
    afterEach(() => jest.restoreAllMocks());

    it('every id sorts after the one before it — ten thousand in a row, most of them sharing a millisecond', () => {
      let previous = newUuidV7Bin();
      for (let i = 0; i < 10_000; i += 1) {
        const next = newUuidV7Bin();
        expect(Buffer.compare(previous, next)).toBe(-1);
        previous = next;
      }
    });

    // Instants ahead of every id this file made before: an earlier one would read as a clock stepping back.
    it('the clock frozen on one millisecond: still increasing, well formed, never dated before it — past 4096, the next millisecond is borrowed', () => {
      const frozen = Date.now() + 3_600_000;
      jest.spyOn(Date, 'now').mockReturnValue(frozen);
      const ids = Array.from({ length: 6_000 }, () => newUuidV7Bin());
      for (let i = 1; i < ids.length; i += 1) expect(Buffer.compare(ids[i - 1], ids[i])).toBe(-1);
      expect(ids.every(wellFormed)).toBe(true);
      const stamps = ids.map((id) => id.readUIntBE(0, 6));
      expect(Math.min(...stamps)).toBe(frozen);
      // At least 2048 per millisecond: 6000 ids borrow at most two more.
      expect(Math.max(...stamps)).toBeLessThanOrEqual(frozen + 2);
    });

    it('a clock that steps back does not take the ids back with it', () => {
      const at = Date.now() + 7_200_000;
      const now = jest.spyOn(Date, 'now').mockReturnValue(at);
      const before = newUuidV7Bin();
      now.mockReturnValue(at - 10_000);
      const after = newUuidV7Bin();
      expect(Buffer.compare(before, after)).toBe(-1);
      expect(after.readUIntBE(0, 6)).toBe(before.readUIntBE(0, 6));
    });

    it('a new millisecond seeds the counter in its lower half: room for 2048 more', () => {
      const from = Date.now() + 10_800_000;
      const now = jest.spyOn(Date, 'now');
      for (let ms = 0; ms < 200; ms += 1) {
        now.mockReturnValue(from + ms);
        expect(counterOf(newUuidV7Bin())).toBeLessThanOrEqual(0x7ff);
      }
    });
  });

  it('validates and rejects malformed input', () => {
    expect(isUuid(newUuidV7())).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(() => uuidToBin('nope')).toThrow();
    expect(() => binToUuid(Buffer.alloc(8))).toThrow();
  });
});
