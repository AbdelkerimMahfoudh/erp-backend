import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BRANDS,
  MODELS,
  CATALOGUE_REVIEWED_ON,
  byDisplayRank,
  modelsForBrand,
  normaliseSearch,
  searchTermsFor,
} from './device-catalogue';

/**
 * The device catalogue, and the promises it makes.
 *
 * The catalogue is reference data with two representations — a TypeScript
 * constant and a migration snapshot — and the failure mode of that arrangement
 * is drift: somebody adds a model to one and not the other, and staging quietly
 * offers a different list from development. `0059` learned this lesson with
 * permissions; the last test here is the same guard for phones.
 */
describe('the device catalogue', () => {
  it('has the brands the market actually sees, in order', () => {
    expect(BRANDS.map((b) => b.name)).toEqual([
      'Apple',
      'Samsung',
      'Xiaomi',
      'Redmi',
      'POCO',
      'Tecno',
      'Infinix',
      'itel',
      'OPPO',
      'realme',
      'Huawei',
      'Honor',
      'Other brand',
    ]);
  });

  it('sorts `Other brand` last without special-casing it in the UI', () => {
    const last = [...BRANDS].sort((a, b) => a.order - b.order).at(-1);
    expect(last?.key).toBe('other');
    // It is a row like any other, so a selector needs no branch for it.
    expect(BRANDS.filter((b) => b.key === 'other')).toHaveLength(1);
  });

  it('keeps Redmi and POCO searchable in their own right', () => {
    /*
     * They are Xiaomi's, and that is recorded — but a shop sells a Redmi, and
     * somebody typing the name printed on the box must find it. Nesting them
     * under Xiaomi would hide them from exactly that search.
     */
    for (const key of ['redmi', 'poco']) {
      const brand = BRANDS.find((b) => b.key === key)!;
      expect(brand.parentKey).toBe('xiaomi');
      expect(brand.order).toBeLessThan(999);
      expect(modelsForBrand(key).length).toBeGreaterThan(10);
    }
  });

  it('gives every brand a unique key and every model a unique name within it', () => {
    expect(new Set(BRANDS.map((b) => b.key)).size).toBe(BRANDS.length);
    const pairs = MODELS.map((m) => `${m.brandKey}|${m.name}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('has no model belonging to a brand that does not exist', () => {
    const keys = new Set(BRANDS.map((b) => b.key));
    for (const m of MODELS) expect([m.name, keys.has(m.brandKey)]).toEqual([m.name, true]);
  });

  describe('ordering', () => {
    /*
     * Release year used to decide this and could not. Two defects, both fixed
     * here and both pinned so they cannot come back:
     *
     *   * models sharing a year fell back to ALPHABETICAL order, which put
     *     `iPhone 16e` above `iPhone 17`;
     *   * a family spans years, so `iPhone 17e` (2026) sat alone at the top,
     *     split from the `iPhone 17` family it belongs to.
     */
    const names = (key: string) => modelsForBrand(key).map((m) => m.name);

    it('leads Apple exactly as a shopkeeper reads it', () => {
      expect(names('apple').slice(0, 10)).toEqual([
        'iPhone 17 Pro Max',
        'iPhone 17 Pro',
        'iPhone Air',
        'iPhone 17',
        'iPhone 17e',
        'iPhone 16 Pro Max',
        'iPhone 16 Pro',
        'iPhone 16 Plus',
        'iPhone 16',
        'iPhone 16e',
      ]);
    });

    it('puts the value variant last in its family, not first', () => {
      const apple = names('apple');
      expect(apple.indexOf('iPhone 13')).toBeLessThan(apple.indexOf('iPhone 13 mini'));
      expect(apple.indexOf('iPhone 12')).toBeLessThan(apple.indexOf('iPhone 12 mini'));
      expect(apple.indexOf('iPhone 17')).toBeLessThan(apple.indexOf('iPhone 17e'));
    });

    it('orders a Samsung family Ultra, Plus, standard, FE', () => {
      const s25 = names('samsung').filter((n) => n.startsWith('Galaxy S25'));
      expect(s25).toEqual(['Galaxy S25 Ultra', 'Galaxy S25+', 'Galaxy S25', 'Galaxy S25 FE']);
    });

    it('keeps a family together even when it spans two years', () => {
      const apple = modelsForBrand('apple');
      const i17e = apple.findIndex((m) => m.name === 'iPhone 17e');
      const i17pm = apple.findIndex((m) => m.name === 'iPhone 17 Pro Max');
      const i16pm = apple.findIndex((m) => m.name === 'iPhone 16 Pro Max');
      // 17e shipped LATER than 17 Pro Max and still belongs below it…
      expect(apple[i17e].releaseRank).toBeGreaterThan(apple[i17pm].releaseRank);
      expect(i17pm).toBeLessThan(i17e);
      // …and above the previous family.
      expect(i17e).toBeLessThan(i16pm);
    });

    it('never falls back to alphabetical for two models of one year', () => {
      const apple = modelsForBrand('apple');
      const a = apple.find((m) => m.name === 'iPhone 16e')!;
      const b = apple.find((m) => m.name === 'iPhone 17')!;
      expect(a.releaseRank).toBe(b.releaseRank); // same year
      // Alphabetically '16e' precedes '17'. The catalogue must not agree.
      expect('iPhone 16e'.localeCompare('iPhone 17')).toBeLessThan(0);
      expect(apple.indexOf(b)).toBeLessThan(apple.indexOf(a));
    });

    it('gives every model of a brand a distinct rank, so there is no tie-break', () => {
      /*
       * The reason this matters: a comparator that fell back to a NAME would
       * sort differently under a different locale, and the catalogue must read
       * identically in English, Arabic and French.
       */
      for (const b of BRANDS) {
        const ranks = modelsForBrand(b.key).map((m) => m.displayRank);
        expect([b.key, new Set(ranks).size]).toEqual([b.key, ranks.length]);
      }
    });

    it('sorts the same whatever the language is', () => {
      // Ordering is a pure numeric comparison, so it cannot depend on a locale.
      const en = modelsForBrand('apple').map((m) => m.name);
      for (const locale of ['en-US', 'ar-EG', 'fr-FR']) {
        const shuffled = [...MODELS.filter((m) => m.brandKey === 'apple')]
          .sort((x, y) => x.name.localeCompare(y.name, locale))
          .sort(byDisplayRank)
          .map((m) => m.name);
        expect([locale, shuffled]).toEqual([locale, en]);
      }
    });

    it('leaves room to slip a model in without renumbering a brand', () => {
      const apple = modelsForBrand('apple');
      for (let i = 1; i < apple.length; i++) {
        expect(apple[i - 1].displayRank - apple[i].displayRank).toBeGreaterThanOrEqual(2);
      }
    });

    it('keeps the release year as a separate, still-true fact', () => {
      // The whole reason for a second column: the year is real data and is not
      // recoverable from a position.
      const air = MODELS.find((m) => m.name === 'iPhone Air')!;
      expect(air.releaseRank).toBe(2025);
      expect(air.displayRank).not.toBe(2025);
    });
  });

  it('never folds storage, colour or condition into a model name', () => {
    /*
     * `products.variant` carries storage and colour already. A catalogue that
     * listed "iPhone 13 128 GB Black" separately from "iPhone 13 256 GB Blue"
     * would multiply by every SKU and make both search and reporting useless.
     */
    /*
     * Trailing `\b` matters as much as the leading one: without it `red`
     * matches the start of "Redmi", and the test fails on perfectly good data
     * rather than on a real mistake.
     */
    const forbidden =
      /\b(\d+\s?(GB|TB)|black|white|blue|red|gold|silver|green|purple|used|refurbished)\b/i;
    for (const m of MODELS) {
      expect([m.name, forbidden.test(m.name)]).toEqual([m.name, false]);
    }
  });

  it('carries every named family the market trades', () => {
    const familiesOf = (key: string) => new Set(modelsForBrand(key).map((m) => m.family));
    expect([...familiesOf('tecno')]).toEqual(
      expect.arrayContaining(['Phantom', 'Camon', 'Pova', 'Spark', 'Pop']),
    );
    expect([...familiesOf('infinix')]).toEqual(
      expect.arrayContaining(['Zero', 'GT', 'Note', 'Hot', 'Smart']),
    );
    expect([...familiesOf('itel')]).toEqual(
      expect.arrayContaining(['City', 'Super', 'itel S', 'itel A', 'Power', 'RS']),
    );
    expect([...familiesOf('oppo')]).toEqual(
      expect.arrayContaining(['Find X', 'Find N', 'Reno', 'OPPO A']),
    );
    expect([...familiesOf('realme')]).toEqual(
      expect.arrayContaining(['realme GT', 'realme numbered', 'realme C', 'realme Note', 'realme P', 'Narzo']),
    );
    expect([...familiesOf('huawei')]).toEqual(
      expect.arrayContaining(['Pura', 'Huawei P', 'Mate', 'nova', 'Huawei Y']),
    );
    expect([...familiesOf('honor')]).toEqual(
      expect.arrayContaining(['Magic', 'Magic V', 'Honor numbered', 'Honor X']),
    );
    expect([...familiesOf('samsung')]).toEqual(
      expect.arrayContaining(['Galaxy S', 'Galaxy Z Fold', 'Galaxy Z Flip', 'Galaxy A', 'Galaxy M', 'Galaxy Note']),
    );
  });

  describe('search', () => {
    const find = (q: string) =>
      MODELS.filter((m) => searchTermsFor(m).includes(normaliseSearch(q))).map((m) => m.name);

    it('does not care where the manufacturer put the space', () => {
      // `Reno13`, `Galaxy S25` and `Note 14` are all current spellings, and
      // nobody typing into a search box should have to remember which.
      expect(find('reno 13')).toContain('Reno13');
      expect(find('reno13')).toContain('Reno13');
      expect(find('s25')).toContain('Galaxy S25');
      expect(find('galaxy s 25')).toContain('Galaxy S25');
    });

    it('matches a family, so one word finds a whole line', () => {
      expect(find('pova').length).toBeGreaterThan(3);
      expect(find('narzo').length).toBeGreaterThan(1);
    });

    it('matches aliases', () => {
      expect(find('iphone se 2022')).toContain('iPhone SE (3rd generation)');
      expect(find('note 13 pro plus')).toContain('Redmi Note 13 Pro+');
    });

    it('folds case and accents', () => {
      expect(normaliseSearch('Français')).toBe('francais');
      expect(normaliseSearch('  POCO  X6  ')).toBe('poco x 6');
    });

    it('finds a brand by the name people say', () => {
      const apple = BRANDS.find((b) => b.key === 'apple')!;
      expect(apple.aliases).toContain('iphone');
    });
  });

  describe('the migration snapshot matches the source', () => {
    const sql = readFileSync(
      join(__dirname, '..', '..', 'prisma', 'migrations', '0062_device_catalogue', 'migration.sql'),
      'utf8',
    );

    it('inserts every brand and every model', () => {
      expect(sql.match(/INSERT INTO `device_brands`/g)).toHaveLength(BRANDS.length);
      expect(sql.match(/INSERT INTO `device_models`/g)).toHaveLength(MODELS.length);
      for (const b of BRANDS) expect(sql).toContain(`'${b.key}'`);
    });

    it('records the review date the source declares', () => {
      expect(sql).toContain(CATALOGUE_REVIEWED_ON);
    });

    it('is idempotent by construction, not by luck', () => {
      /*
       * `NOT EXISTS`, never `INSERT IGNORE` or `REPLACE`. IGNORE would also
       * swallow a real error and leave the catalogue quietly short; REPLACE
       * would delete and reinsert, discarding ids other rows point at.
       */
      expect(sql).not.toMatch(/INSERT IGNORE/i);
      expect(sql).not.toMatch(/\bREPLACE INTO\b/i);
      expect(sql.match(/WHERE NOT EXISTS/g)?.length).toBe(BRANDS.length + MODELS.length);
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS `device_brands`');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS `device_models`');
    });

    it('destroys nothing that was already there', () => {
      // No product is renamed and no mapping is dropped. The one UPDATE fills
      // in a review date that was previously null.
      expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
      expect(sql).not.toMatch(/\bDELETE FROM\b/i);
      expect(sql).not.toMatch(/UPDATE `products`/i);
      expect(sql.match(/^UPDATE /gm)).toHaveLength(1);
    });

    it('claims curated, never official', () => {
      /*
       * `official` is reserved for a licensed feed. Claiming it for a
       * hand-assembled list would be a claim nobody could check, and would
       * quietly raise the confidence every downstream screen shows.
       */
      expect(sql).not.toMatch(/,'official',/);
      expect(sql).toMatch(/,'curated',/);
    });
  });
});
