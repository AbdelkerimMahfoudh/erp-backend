import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TrackingType } from '@prisma/client';
import { DEFAULT_CATEGORIES, defaultCategory } from './default-categories';
import { SELECTABLE_TRACKING_TYPES } from '../tracking/tracking-modes';
import { buildMigrationSql } from '../../scripts/generate-default-categories-migration';

/**
 * The built-in taxonomy (D223) and its migration snapshot.
 *
 * The keys are what the app translates and what products may point at for
 * years, so they are held to the rules a stable identifier needs; and the
 * migration is a snapshot of this file, so the two must never drift.
 */
describe('default categories', () => {
  const keys = DEFAULT_CATEGORIES.map((c) => c.key);

  it('migration 0104 is exactly the snapshot the generator writes from this file', () => {
    const committed = readFileSync(
      join(__dirname, '..', '..', 'prisma', 'migrations', '0104_general_electronics_categories', 'migration.sql'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(committed).toBe(buildMigrationSql());
  });

  it('every key is unique, lower-case and dotted only under its parent', () => {
    expect(new Set(keys).size).toBe(keys.length);
    for (const c of DEFAULT_CATEGORIES) {
      expect(c.key).toMatch(/^[a-z0-9]+(\.[a-z0-9]+)?$/);
      expect(c.key.length).toBeLessThanOrEqual(48);
      if (c.parentKey) expect(c.key.startsWith(`${c.parentKey}.`)).toBe(true);
      else expect(c.key).not.toContain('.');
    }
  });

  it('one level of depth: every parent exists and is itself top-level', () => {
    for (const c of DEFAULT_CATEGORIES.filter((d) => d.parentKey)) {
      const parent = defaultCategory(c.parentKey);
      expect(parent).toBeDefined();
      expect(parent!.parentKey).toBeUndefined();
    }
  });

  it('the recommended mode is always one the category allows, and every allowed mode is selectable', () => {
    for (const c of DEFAULT_CATEGORIES) {
      expect(c.allowed).toContain(c.trackingType);
      for (const mode of c.allowed) expect(SELECTABLE_TRACKING_TYPES).toContain(mode);
    }
  });

  it('phones demand an IMEI; cables, chargers and cases are never individually tracked', () => {
    expect(defaultCategory('phones')!.allowed).toEqual([TrackingType.imei]);
    for (const key of ['cables', 'chargers', 'cases', 'protection']) {
      expect(defaultCategory(key)!.allowed).toEqual([TrackingType.quantity]);
    }
  });

  it('a cellular-capable family may be IMEI-tracked, its Wi-Fi sibling may not', () => {
    expect(defaultCategory('tablets.cellular')!.allowed).toContain(TrackingType.imei);
    expect(defaultCategory('tablets.wifi')!.allowed).not.toContain(TrackingType.imei);
    expect(defaultCategory('networking.mifi')!.trackingType).toBe(TrackingType.imei);
  });

  it('covers the brief: every required top-level category is present', () => {
    for (const key of [
      'phones', 'tablets', 'computers', 'wearables', 'audio', 'chargers', 'cables', 'powerbanks', 'cases',
      'protection', 'pcaccessories', 'storage', 'networking', 'gaming', 'parts', 'other',
    ]) {
      expect(defaultCategory(key)).toBeDefined();
    }
  });

  it('no category requires any descriptive field: the intake minimum is not widened', () => {
    for (const c of DEFAULT_CATEGORIES) for (const a of c.attributes) expect(a.required).toBeFalsy();
  });
});
