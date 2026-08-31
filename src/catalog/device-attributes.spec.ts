import {
  COLOUR_OPTIONS,
  STORAGE_OPTIONS,
  composeVariant,
  parseVariant,
} from './device-attributes';

/**
 * The rule these tests exist to protect: **a shop never loses a value it
 * typed.** Everything else here is convenience; that one is a promise.
 */

describe('the option lists', () => {
  it('offers the storage capacities the brief names, smallest first', () => {
    expect(STORAGE_OPTIONS.map((o) => o.label)).toEqual([
      '4 GB', '8 GB', '16 GB', '32 GB', '64 GB',
      '128 GB', '256 GB', '512 GB', '1 TB', '2 TB', 'Other',
    ]);
  });

  it('offers the colours the brief names', () => {
    expect(COLOUR_OPTIONS.map((o) => o.label)).toEqual([
      'Black', 'White', 'Gray', 'Silver', 'Gold', 'Rose Gold', 'Blue', 'Green',
      'Red', 'Purple', 'Pink', 'Yellow', 'Orange', 'Brown', 'Beige', 'Other',
    ]);
  });

  it('always ends with Other, in both lists', () => {
    for (const list of [STORAGE_OPTIONS, COLOUR_OPTIONS]) {
      expect(list[list.length - 1].key).toBe('other');
      expect(list.filter((o) => o.key === 'other')).toHaveLength(1);
    }
  });

  it('has no duplicate keys', () => {
    for (const list of [STORAGE_OPTIONS, COLOUR_OPTIONS]) {
      expect(new Set(list.map((o) => o.key)).size).toBe(list.length);
    }
  });

  it('never repeats a model suffix — those come from the model name', () => {
    // `Pro`, `Plus`, `Ultra`, `Max` and `Mini` are part of the commercial name
    // and arrive from the model selector. Offering them here would file one
    // phone under two identities.
    const labels = [...STORAGE_OPTIONS, ...COLOUR_OPTIONS].map((o) => o.label.toLowerCase());
    for (const suffix of ['pro', 'plus', 'ultra', 'max', 'mini', 'fe']) {
      expect(labels).not.toContain(suffix);
    }
  });
});

describe('composing the stored string', () => {
  it('writes storage before colour, always in that order', () => {
    expect(
      composeVariant({
        storageKey: '256gb',
        storageCustom: '',
        colourKey: 'black',
        colourCustom: '',
      }),
    ).toBe('256 GB · Black');
  });

  it('produces the same string for the same phone, so one product row is reused', () => {
    const a = composeVariant({ storageKey: '128gb', storageCustom: '', colourKey: 'blue', colourCustom: '' });
    const b = composeVariant({ storageKey: '128gb', storageCustom: '', colourKey: 'blue', colourCustom: '' });
    expect(a).toBe(b);
  });

  it('leaves the column null when nothing was chosen', () => {
    expect(
      composeVariant({ storageKey: null, storageCustom: '', colourKey: null, colourCustom: '' }),
    ).toBeNull();
  });

  it('accepts one attribute without the other', () => {
    expect(
      composeVariant({ storageKey: '512gb', storageCustom: '', colourKey: null, colourCustom: '' }),
    ).toBe('512 GB');
  });

  it('uses the typed text when Other is chosen', () => {
    expect(
      composeVariant({
        storageKey: 'other',
        storageCustom: '384 GB',
        colourKey: 'other',
        colourCustom: 'Sierra Blue',
      }),
    ).toBe('384 GB · Sierra Blue');
  });

  it('treats Other with nothing typed as nothing chosen', () => {
    expect(
      composeVariant({ storageKey: 'other', storageCustom: '   ', colourKey: 'black', colourCustom: '' }),
    ).toBe('Black');
  });
});

describe('reading back what is already stored', () => {
  it('round-trips a value it wrote', () => {
    const parts = parseVariant('256 GB · Black');
    expect(parts.storageKey).toBe('256gb');
    expect(parts.colourKey).toBe('black');
    expect(composeVariant(parts)).toBe('256 GB · Black');
  });

  it('recognises the spellings the free-text years produced', () => {
    for (const written of ['128GB', '128 gb', '128 Go', '128g', '128']) {
      expect(parseVariant(written).storageKey).toBe('128gb');
    }
  });

  it('recognises grey as gray rather than filing it separately', () => {
    expect(parseVariant('Grey').colourKey).toBe('gray');
    expect(parseVariant('rose-gold').colourKey).toBe('rose_gold');
  });

  it('accepts the separators people actually used', () => {
    for (const written of ['256 GB · Black', '256GB, Black', '256GB / Black', '256GB - Black']) {
      const parts = parseVariant(written);
      expect([parts.storageKey, parts.colourKey]).toEqual(['256gb', 'black']);
    }
  });

  it('keeps a legacy value the lists do not know, verbatim and editable', () => {
    const parts = parseVariant('Dual SIM export unit');

    // Not dropped, not guessed at: `Other`, with the original text in the box.
    expect(parts.colourKey).toBe('other');
    expect(parts.colourCustom).toBe('Dual SIM export unit');
    expect(composeVariant(parts)).toBe('Dual SIM export unit');
  });

  it('keeps the unknown half of a half-recognised value', () => {
    const parts = parseVariant('256GB · Sierra Blue');

    expect(parts.storageKey).toBe('256gb');
    expect(parts.colourKey).toBe('other');
    expect(parts.colourCustom).toBe('Sierra Blue');
    expect(composeVariant(parts)).toBe('256 GB · Sierra Blue');
  });

  it('never drops a word it did not recognise', () => {
    /*
     * The promise, stated as a property rather than as examples — and stated
     * precisely, because the first version of this test was wrong.
     *
     * It asserted that every word survives verbatim, and `Grey` failed it by
     * coming back as `Gray`. That is not a loss, it is the entire point: one
     * spelling per colour is what stops a shelf holding `Grey` and `Gray` as
     * two products. Canonicalising a KNOWN synonym is the feature. Dropping an
     * UNKNOWN word is the bug, and that is what this pins.
     */
    for (const written of [
      '256 GB · Black',
      'Dual SIM export unit',
      '64GB Midnight Green',
      'refurb grade B',
      '1 TB',
    ]) {
      const back = composeVariant(parseVariant(written));
      expect(back).not.toBeNull();
      const words = written.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ');
      const rendered = (back as string).toLowerCase().replace(/[^a-z0-9]+/g, ' ');
      for (const word of words) expect(rendered).toContain(word);
    }
  });

  it('replaces a known synonym with its canonical spelling, deliberately', () => {
    // The other half of the rule above: `Grey` and `Gray` must not be able to
    // become two products.
    expect(composeVariant(parseVariant('Grey'))).toBe('Gray');
    expect(composeVariant(parseVariant('128GB'))).toBe('128 GB');
  });

  it('treats an empty or missing value as no selection', () => {
    for (const empty of [null, undefined, '', '   ']) {
      expect(parseVariant(empty)).toEqual({
        storageKey: null,
        storageCustom: '',
        colourKey: null,
        colourCustom: '',
      });
    }
  });
});
