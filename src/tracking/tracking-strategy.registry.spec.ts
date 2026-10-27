import { CodeType, TrackingType } from '@prisma/client';
import { TrackingStrategyRegistry } from './tracking-strategy.registry';

describe('TrackingStrategyRegistry', () => {
  const registry = new TrackingStrategyRegistry();

  it('registers all three tracking types', () => {
    expect(registry.all().map((s) => s.type).sort()).toEqual(
      [TrackingType.imei, TrackingType.quantity, TrackingType.serial].sort(),
    );
  });

  it('maps each tracking type to the right unit identifier column', () => {
    expect(registry.get(TrackingType.imei).identifierField).toBe('imeiPrimary');
    expect(registry.get(TrackingType.serial).identifierField).toBe('serialNo');
    expect(registry.get(TrackingType.quantity).identifierField).toBeNull();
  });

  describe('imei strategy', () => {
    const s = registry.get(TrackingType.imei);
    const valid = '123456789012347'; // Luhn check digit 7

    it('is per-unit with an IMEI label', () => {
      expect(s.perUnit).toBe(true);
      expect(s.identifierLabel).toBe('IMEI');
    });

    it('normalizes away non-digits and validates Luhn', () => {
      expect(s.normalize('12-34 56789012347')).toBe(valid);
      expect(s.validateIdentifier(valid).ok).toBe(true);
      expect(s.validateIdentifier('123').ok).toBe(false);
    });

    it('derives the TAC recognition key', () => {
      expect(s.recognitionKey(valid)).toEqual({ codeType: CodeType.tac, code: '12345678' });
      expect(s.recognitionKey('123')).toBeNull();
    });
  });

  describe('serial strategy', () => {
    const s = registry.get(TrackingType.serial);

    it('is per-unit, uppercases, and has no learning key yet', () => {
      expect(s.perUnit).toBe(true);
      expect(s.normalize(' sn-abc ')).toBe('SN-ABC');
      expect(s.validateIdentifier('SN-ABC').ok).toBe(true);
      expect(s.validateIdentifier('').ok).toBe(false);
      expect(s.recognitionKey('SN-ABC')).toBeNull(); // serial_prefix reserved for 2C.5c
    });

    /**
     * Sale refuses fifteen digits with a failing checksum before any lookup, so a
     * serial like that could be received but never sold. Intake refuses it too
     * (D223). Fictional values: the first passes Luhn, the second does not.
     */
    it('refuses a mistyped IMEI as a serial, and keeps a fifteen-digit serial that passes the checksum', () => {
      expect(s.validateIdentifier('490154203237518').ok).toBe(true);
      expect(s.validateIdentifier('490154203237519')).toMatchObject({ ok: false, reason: expect.stringMatching(/mistyped IMEI/) });
      expect(s.validateIdentifier('12345678901234').ok).toBe(true); // fourteen digits: not IMEI-shaped
    });
  });

  describe('quantity strategy', () => {
    const s = registry.get(TrackingType.quantity);

    it('is not per-unit and uses the barcode as the recognition key', () => {
      expect(s.perUnit).toBe(false);
      expect(s.identifierLabel).toBeNull();
      expect(s.validateIdentifier('anything').ok).toBe(true);
      expect(s.recognitionKey('6001234567890')).toEqual({ codeType: CodeType.barcode, code: '6001234567890' });
      expect(s.recognitionKey('')).toBeNull();
    });
  });

  it('throws for an unknown tracking type', () => {
    expect(() => registry.get('nope' as never)).toThrow();
  });
});
