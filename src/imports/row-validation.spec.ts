import { luhnValid, parseNumber, summarise, validateRow, type RowVerdict } from './row-validation';

/**
 * Deciding what happens to each row (Milestone G).
 *
 * The rule underneath all of it: a bad row fails alone. A shop importing 200
 * phones with three mistyped IMEIs gets 197 phones and three things to fix.
 */

const check = (
  cells: Record<string, string>,
  over: Partial<{ kind: 'imei' | 'serial' | 'quantity'; seenInFile: Set<string>; existsInShop: Set<string> }> = {},
) =>
  validateRow({
    cells,
    kind: over.kind ?? 'imei',
    seenInFile: over.seenInFile ?? new Set(),
    existsInShop: over.existsInShop ?? new Set(),
  });

// A real, Luhn-valid IMEI.
const GOOD_IMEI = '490154203237518';

describe('reading numbers the way a spreadsheet writes them', () => {
  it.each([
    ['1200', 1200],
    ['1,200', 1200],
    ['1 200', 1200],
    ['1.200,50', 1200.5],
    ['1,200.50', 1200.5],
    ['1,50', 1.5],
    ['١٢٠٠', 1200],
    ['1200 MRU', 1200],
    ['0', 0],
  ])('reads %s as %s', (raw, expected) => {
    expect(parseNumber(raw)).toBe(expected);
  });

  it('tells a thousands comma from a decimal comma by what follows it', () => {
    /**
     * `1,200` is one thousand two hundred; `1,50` is one and a half. Three
     * digits after the comma is the only signal available, and it is the one a
     * person reading it would use.
     */
    expect(parseNumber('1,200')).toBe(1200);
    expect(parseNumber('1,50')).toBe(1.5);
  });

  it('reads nothing as null, which is not zero', () => {
    /**
     * A cost of nothing and a cost nobody typed are different facts, and only
     * one of them should pass validation.
     */
    expect(parseNumber('')).toBeNull();
    expect(parseNumber(null)).toBeNull();
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('0')).toBe(0);
  });
});

describe('the IMEI check digit', () => {
  it('accepts a real IMEI', () => {
    expect(luhnValid(GOOD_IMEI)).toBe(true);
  });

  it('rejects one digit changed', () => {
    expect(luhnValid('490154203237519')).toBe(false);
  });

  it('rejects anything that is not 15 digits', () => {
    expect(luhnValid('49015420323751')).toBe(false);
    expect(luhnValid('4901542032375180')).toBe(false);
  });

  it('is an ERROR on a row, never a warning', () => {
    /**
     * The single worst outcome of an import is a phone that looks imported and
     * can never be found by scanning the real one. A failed check digit is a
     * typo, and letting it through with a friendly colour guarantees that
     * outcome.
     */
    const v = check({ imei: '490154203237519', model: 'A15', cost: '100' });
    expect(v.status).toBe('error');
    expect(v.messages.join(' ')).toMatch(/check digit/);
  });
});

describe('a phone row', () => {
  it('passes when it is complete and correct', () => {
    const v = check({ imei: GOOD_IMEI, model: 'A15', brand: 'Samsung', cost: '1200', price: '1500' });
    expect(v.status).toBe('valid');
    expect(v.parsed).toMatchObject({ imei: GOOD_IMEI, model: 'A15', cost: 1200, price: 1500 });
  });

  it('tolerates spaces and dashes in the IMEI', () => {
    expect(check({ imei: '49-015420 3237518', model: 'A15', cost: '1' }).status).toBe('valid');
  });

  it('fails with no model', () => {
    expect(check({ imei: GOOD_IMEI, cost: '1' }).status).toBe('error');
  });

  it('fails with no cost', () => {
    /**
     * Not a warning. Stock with no cost reports infinite margin on every sale,
     * and the shop finds out only once the profit figures are already wrong.
     */
    const v = check({ imei: GOOD_IMEI, model: 'A15' });
    expect(v.status).toBe('error');
    expect(v.messages).toContain('No cost');
  });

  it('says the length when the IMEI is the wrong length', () => {
    // "An IMEI is 15 digits; this one has 14" is actionable. "Invalid" is not.
    expect(check({ imei: '12345678901234', model: 'A15', cost: '1' }).messages.join(' ')).toMatch(/has 14/);
  });

  it('collects every problem, not just the first', () => {
    const v = check({ imei: 'abc' });
    expect(v.messages.length).toBeGreaterThan(1);
  });
});

describe('duplicates', () => {
  it('catches one that appears twice in the same file', () => {
    /**
     * Without this the sheet imports the phone once and fails once, which reads
     * as a mysterious error rather than as "you typed it twice".
     */
    const v = check({ imei: GOOD_IMEI, model: 'A15', cost: '1' }, { seenInFile: new Set([GOOD_IMEI]) });
    expect(v.status).toBe('error');
    expect(v.messages).toContain('This appears earlier in the same file');
  });

  it('catches one that is already in stock', () => {
    const v = check({ imei: GOOD_IMEI, model: 'A15', cost: '1' }, { existsInShop: new Set([GOOD_IMEI]) });
    expect(v.messages).toContain('This is already in stock');
  });

  it('says which of the two it is', () => {
    // "Already in stock" and "listed twice in your file" need different fixes.
    const inFile = check({ imei: GOOD_IMEI, model: 'A15', cost: '1' }, { seenInFile: new Set([GOOD_IMEI]) });
    const inShop = check({ imei: GOOD_IMEI, model: 'A15', cost: '1' }, { existsInShop: new Set([GOOD_IMEI]) });
    expect(inFile.messages).not.toEqual(inShop.messages);
  });
});

describe('warnings import; errors do not', () => {
  it('warns on a zero cost rather than refusing it', () => {
    /**
     * Free stock is real — a supplier replacement, a promotional unit. But a
     * whole column of zeros is far more likely to be an empty column, and the
     * shop should look before every margin becomes 100%.
     */
    const v = check({ imei: GOOD_IMEI, model: 'A15', cost: '0' });
    expect(v.status).toBe('warning');
  });

  it('warns when the selling price is below cost', () => {
    // Clearance is a real decision; it is also what a swapped column looks like.
    const v = check({ imei: GOOD_IMEI, model: 'A15', cost: '1000', price: '800' });
    expect(v.status).toBe('warning');
  });

  it('refuses a negative cost outright', () => {
    expect(check({ imei: GOOD_IMEI, model: 'A15', cost: '-5' }).status).toBe('error');
  });

  it('lets an error outrank a warning on the same row', () => {
    const v = check({ imei: 'nope', model: 'A15', cost: '0' });
    expect(v.status).toBe('error');
  });
});

describe('stock counted by quantity', () => {
  it('passes with a barcode and a whole number', () => {
    const v = check({ barcode: '5901234123457', model: 'USB-C cable', cost: '20', quantity: '50' }, { kind: 'quantity' });
    expect(v.status).toBe('valid');
    expect(v.parsed.quantity).toBe(50);
  });

  it('refuses a fractional quantity', () => {
    // Half a charger is not a thing anybody can sell.
    expect(check({ model: 'Cable', cost: '1', quantity: '2.5' }, { kind: 'quantity' }).status).toBe('error');
  });

  it('refuses zero and negative quantities', () => {
    expect(check({ model: 'Cable', cost: '1', quantity: '0' }, { kind: 'quantity' }).status).toBe('error');
    expect(check({ model: 'Cable', cost: '1', quantity: '-3' }, { kind: 'quantity' }).status).toBe('error');
  });

  it('does not require a barcode', () => {
    // Plenty of bulk stock has no barcode worth scanning.
    expect(check({ model: 'Cable', cost: '1', quantity: '10' }, { kind: 'quantity' }).status).toBe('valid');
  });
});

describe('what the shop is told before anything is written', () => {
  const verdicts = (...s: ('valid' | 'warning' | 'error')[]): RowVerdict[] =>
    s.map((status) => ({ status, messages: [], parsed: {} }));

  it('counts each kind', () => {
    expect(summarise(verdicts('valid', 'valid', 'warning', 'error'))).toMatchObject({
      total: 4,
      valid: 2,
      warning: 1,
      error: 1,
    });
  });

  it('counts warnings as importing, because that is what a warning means', () => {
    /**
     * A warning that blocks an import is just an error with a friendlier
     * colour, and it teaches people to ignore both.
     */
    expect(summarise(verdicts('valid', 'warning', 'error')).willImport).toBe(2);
  });

  it('reports zero importable when every row is wrong', () => {
    expect(summarise(verdicts('error', 'error')).willImport).toBe(0);
  });
});
