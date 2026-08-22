import {
  classifyIdentifier,
  generatePersonalId,
  ID_ALPHABET,
  ID_LENGTH,
  isPersonalId,
  normalisePersonalId,
  normalisePhone,
} from './identifier';

/**
 * The one sign-in field (CP3).
 *
 * Everything here protects one promise: a shopkeeper types **one** thing —
 * their phone number or their personal ID — and never has to know their
 * business's Store ID to reach their own till.
 */

describe('a personal ID is readable and unmistakable', () => {
  it('avoids the glyphs people misread off paper', () => {
    for (const ambiguous of ['I', 'L', 'O', 'U', '0', '1']) {
      expect(ID_ALPHABET).not.toContain(ambiguous);
    }
  });

  it('is generated in the expected shape', () => {
    const id = generatePersonalId();
    expect(id).toHaveLength(ID_LENGTH);
    expect(id.startsWith('U-')).toBe(true);
    expect(isPersonalId(id)).toBe(true);
  });

  it('does not repeat itself', () => {
    // Not a uniqueness proof — the database owns that — but a generator that
    // returned the same code twice in a hundred tries would be broken.
    const seen = new Set(Array.from({ length: 100 }, () => generatePersonalId()));
    expect(seen.size).toBe(100);
  });

  it('is recognised whatever case it is typed in', () => {
    const id = generatePersonalId();
    expect(isPersonalId(id.toLowerCase())).toBe(true);
    expect(normalisePersonalId(id.toLowerCase())).toBe(id);
    expect(normalisePersonalId('  u-abcdefgh  ')).toBe('U-ABCDEFGH');
  });

  it('refuses anything that is not one', () => {
    expect(isPersonalId('U-ABCDEFG')).toBe(false); // too short
    expect(isPersonalId('U-ABCDEFGHI')).toBe(false); // too long
    expect(isPersonalId('X-ABCDEFGH')).toBe(false); // wrong prefix
    expect(isPersonalId('U-ABCDEFG0')).toBe(false); // excluded glyph
    expect(isPersonalId('U-ABCDEFGI')).toBe(false); // excluded glyph
    expect(isPersonalId('owner')).toBe(false);
    expect(isPersonalId('')).toBe(false);
  });

  it('is never the raw database id', () => {
    // A BINARY(16) UUIDv7 is unreadable, undictatable and leaks creation time.
    const id = generatePersonalId();
    expect(id).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}/i);
    expect(id.length).toBeLessThan(36);
  });
});

describe('phone numbers are normalised, not rejected for formatting', () => {
  it('accepts the local eight-digit form', () => {
    expect(normalisePhone('43210987')).toBe('+22243210987');
  });

  it('accepts the same number written the way it is printed', () => {
    // A shop typing their number off a business card must not be told it is
    // wrong because of a space.
    for (const written of ['4321 0987', '4321-0987', '43 21 09 87', ' 43210987 ']) {
      expect(normalisePhone(written)).toBe('+22243210987');
    }
  });

  it('accepts it with the country code, with or without the plus', () => {
    expect(normalisePhone('+222 43210987')).toBe('+22243210987');
    expect(normalisePhone('22243210987')).toBe('+22243210987');
    expect(normalisePhone('+222 4321-0987')).toBe('+22243210987');
  });

  it('keeps a foreign number rather than guessing a country for it', () => {
    // An owner or supplier abroad is not an error, and inventing +222 for them
    // would be worse than storing what they typed.
    expect(normalisePhone('+33612345678')).toBe('+33612345678');
  });

  it('refuses what was never a phone number at all', () => {
    expect(normalisePhone('owner')).toBeNull();
    expect(normalisePhone('U-ABCDEFGH')).toBeNull();
    expect(normalisePhone('')).toBeNull();
    expect(normalisePhone('12')).toBeNull();
    expect(normalisePhone('++4321098')).toBeNull();
  });
});

describe('the field decides for itself which one it got', () => {
  it('reads a personal ID as a personal ID', () => {
    const c = classifyIdentifier('U-R6H5NWRY');
    expect(c.kind).toBe('personal_id');
    expect(c.value).toBe('U-R6H5NWRY');
  });

  it('reads a phone as a phone', () => {
    const c = classifyIdentifier('4321 0987');
    expect(c.kind).toBe('phone');
    expect(c.value).toBe('+22243210987');
  });

  it('never mangles a personal ID through the phone rules', () => {
    /*
      The failure the brief warns about: transforming an arbitrary identifier
      as though it were a number. A personal ID starts with a letter, and it is
      tested first, so no phone normalisation can ever touch it.
    */
    for (let i = 0; i < 50; i++) {
      const id = generatePersonalId();
      const c = classifyIdentifier(id);
      expect(c.kind).toBe('personal_id');
      expect(c.value).toBe(id);
    }
  });

  it('and no phone number can ever look like a personal ID', () => {
    for (const phone of ['43210987', '+22243210987', '+33612345678']) {
      expect(isPersonalId(phone)).toBe(false);
      expect(classifyIdentifier(phone).kind).toBe('phone');
    }
  });

  it('reports nonsense as unrecognised rather than guessing', () => {
    for (const junk of ['', '   ', 'owner', 'F62B8D1EEB', 'not a thing']) {
      const c = classifyIdentifier(junk);
      expect(c.kind).toBe('unrecognised');
      expect(c.value).toBeNull();
    }
  });

  it('does not accept a Store ID', () => {
    // A Store ID is ten hex characters. It must not resolve to anything here:
    // the whole point is that nobody types one to sign in.
    const c = classifyIdentifier('F62B8D1EEB');
    expect(c.kind).toBe('unrecognised');
  });
});
