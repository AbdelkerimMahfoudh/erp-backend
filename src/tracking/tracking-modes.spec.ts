import { BadRequestException, ConflictException } from '@nestjs/common';
import { TrackingType } from '@prisma/client';
import {
  SELECTABLE_TRACKING_TYPES,
  assertSelectableTrackingType,
  assertTrackingChangeSafe,
  isSerialized,
  resolveTrackingType,
} from './tracking-modes';

describe('which modes may be chosen', () => {
  it('offers exactly IMEI and quantity', () => {
    expect([...SELECTABLE_TRACKING_TYPES].sort()).toEqual(['imei', 'quantity']);
  });

  it('accepts the two modes the product actually uses', () => {
    expect(() => assertSelectableTrackingType(TrackingType.imei)).not.toThrow();
    expect(() => assertSelectableTrackingType(TrackingType.quantity)).not.toThrow();
  });

  it('refuses serial as a new choice', () => {
    expect(() => assertSelectableTrackingType(TrackingType.serial)).toThrow(BadRequestException);
  });

  /**
   * The whole reason `serial` is refused rather than deleted. A row that was
   * already serial has units hanging off it; an edit that changes the name must
   * not fail because the mode predates the rule.
   */
  it('lets a record that is already serial be saved again unchanged', () => {
    expect(() => assertSelectableTrackingType(TrackingType.serial, TrackingType.serial)).not.toThrow();
  });

  it('still refuses moving TO serial from something else', () => {
    expect(() => assertSelectableTrackingType(TrackingType.serial, TrackingType.quantity)).toThrow(
      BadRequestException,
    );
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

describe('the category decides, not the client', () => {
  it('returns the category mode when the client says nothing', () => {
    expect(resolveTrackingType(TrackingType.imei)).toBe('imei');
    expect(resolveTrackingType(TrackingType.quantity, undefined)).toBe('quantity');
    expect(resolveTrackingType(TrackingType.quantity, null)).toBe('quantity');
  });

  it('allows a client that agrees', () => {
    expect(resolveTrackingType(TrackingType.imei, TrackingType.imei)).toBe('imei');
  });

  /**
   * The two attacks this exists to stop. Before this, the client's value won
   * and the category was only a fallback.
   */
  it('refuses a phone category asked to skip IMEI tracking', () => {
    expect(() => resolveTrackingType(TrackingType.imei, TrackingType.quantity)).toThrow(BadRequestException);
  });

  it('refuses a counted category asked to demand IMEIs', () => {
    expect(() => resolveTrackingType(TrackingType.quantity, TrackingType.imei)).toThrow(BadRequestException);
  });

  it('names both modes in the refusal, so the client can tell which it got wrong', () => {
    expect(() => resolveTrackingType(TrackingType.imei, TrackingType.quantity)).toThrow(/imei[\s\S]*quantity/);
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
