import { BadRequestException, ConflictException } from '@nestjs/common';
import { TrackingType } from '@prisma/client';
import {
  SELECTABLE_TRACKING_TYPES,
  assertSelectableTrackingType,
  assertTrackingChangeSafe,
  isSerialized,
  resolveTrackingType,
  trackingAfterRecategorise,
  allowedTrackingTypes,
} from './tracking-modes';

describe('which modes may be chosen', () => {
  it('offers all three modes the product actually uses', () => {
    expect([...SELECTABLE_TRACKING_TYPES].sort()).toEqual(['imei', 'quantity', 'serial']);
  });

  it('accepts every offered mode', () => {
    expect(() => assertSelectableTrackingType(TrackingType.imei)).not.toThrow();
    expect(() => assertSelectableTrackingType(TrackingType.quantity)).not.toThrow();
  });

  /**
   * Serial was withdrawn once, to stop a box of cables being registered one at
   * a time. It cost more than it saved: televisions, laptops and power stations
   * carry a serial and no IMEI, the scanner classifies those serials correctly,
   * and Receive already handles them — but no new serial product could be
   * created, so the form proposed IMEI and asked for a number the device does
   * not have. The protection that matters is the category rule below.
   */
  it('accepts serial as a new choice', () => {
    expect(() => assertSelectableTrackingType(TrackingType.serial)).not.toThrow();
  });

  it('lets a record that is already serial be saved again unchanged', () => {
    expect(() => assertSelectableTrackingType(TrackingType.serial, TrackingType.serial)).not.toThrow();
  });

  it('allows moving TO serial, which is a selectable mode again', () => {
    expect(() => assertSelectableTrackingType(TrackingType.serial, TrackingType.quantity)).not.toThrow();
  });

  /**
   * Selectable is not the same as free. `assertTrackingChangeSafe` still
   * refuses any change once stock or history exists, because five `Unit` rows
   * are not a `StockItem` of five — that guard is unchanged and tested below.
   */
  it('refuses a mode that is not offered at all', () => {
    expect(() => assertSelectableTrackingType('weighed' as TrackingType)).toThrow(BadRequestException);
  });

  it('lets a historical serial record be migrated to a selectable mode', () => {
    expect(() => assertSelectableTrackingType(TrackingType.quantity, TrackingType.serial)).not.toThrow();
  });
});

describe('serialized means "one row per physical thing"', () => {
  it('is true for imei and serial, false for quantity', () => {
    expect(isSerialized(TrackingType.imei)).toBe(true);
    expect(isSerialized(TrackingType.serial)).toBe(true);
    expect(isSerialized(TrackingType.quantity)).toBe(false);
  });
});

describe('the category recommends, the Owner chooses what it allows (D223)', () => {
  const phones = { defaultTrackingType: TrackingType.imei, key: 'phones' };
  const cables = { defaultTrackingType: TrackingType.quantity, key: 'cables' };
  const tablets = { defaultTrackingType: TrackingType.serial, key: 'tablets' };
  const ownCategory = { defaultTrackingType: TrackingType.quantity, key: null };

  it('returns the recommended mode when the client says nothing', () => {
    expect(resolveTrackingType(phones)).toBe('imei');
    expect(resolveTrackingType(cables, undefined)).toBe('quantity');
    expect(resolveTrackingType(ownCategory, null)).toBe('quantity');
  });

  it('accepts another mode the category allows: a cellular tablet, a serial-tracked own product', () => {
    expect(resolveTrackingType(tablets, TrackingType.imei)).toBe('imei');
    expect(resolveTrackingType(tablets, TrackingType.quantity)).toBe('quantity');
    expect(resolveTrackingType(ownCategory, TrackingType.serial)).toBe('serial');
  });

  /** The two attacks the old rule stopped are still stopped, by the allowed list. */
  it('refuses a phone asked to skip IMEI tracking', () => {
    expect(() => resolveTrackingType(phones, TrackingType.quantity)).toThrow(BadRequestException);
  });

  it('refuses a cable asked to demand IMEIs', () => {
    expect(() => resolveTrackingType(cables, TrackingType.imei)).toThrow(BadRequestException);
  });

  it('names the recommended mode and the one asked for in the refusal', () => {
    expect(() => resolveTrackingType(phones, TrackingType.quantity)).toThrow(/imei[\s\S]*quantity/);
  });

  it('a re-filed product keeps its mode when the new category allows it, else takes the recommendation', () => {
    expect(trackingAfterRecategorise(tablets, TrackingType.imei)).toBe('imei');
    expect(trackingAfterRecategorise(cables, TrackingType.serial)).toBe('quantity');
    expect(allowedTrackingTypes(ownCategory)).toEqual(['imei', 'serial', 'quantity']);
  });
});

describe('existing stock is never reinterpreted', () => {
  it('allows the change while the product has no history', () => {
    expect(() => assertTrackingChangeSafe(false, TrackingType.imei, TrackingType.quantity)).not.toThrow();
  });

  it('refuses once any history exists', () => {
    expect(() => assertTrackingChangeSafe(true, TrackingType.imei, TrackingType.quantity)).toThrow(
      ConflictException,
    );
  });

  it('refuses with a code the mobile client can branch on', () => {
    try {
      assertTrackingChangeSafe(true, TrackingType.quantity, TrackingType.imei);
      fail('expected a conflict');
    } catch (e) {
      expect((e as ConflictException).getResponse()).toMatchObject({ code: 'tracking_change_blocked' });
    }
  });

  it('does not offer to migrate the stock, because it cannot', () => {
    try {
      assertTrackingChangeSafe(true, TrackingType.imei, TrackingType.quantity);
      fail('expected a conflict');
    } catch (e) {
      const { message } = e as { message: string };
      const body = (e as ConflictException).getResponse() as { message: string };
      const text = `${message} ${body.message}`;
      expect(text).toMatch(/new product/i);
      expect(text).not.toMatch(/convert|migrat/i);
    }
  });
});
