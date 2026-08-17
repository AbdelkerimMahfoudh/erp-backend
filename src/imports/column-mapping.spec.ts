import { guessMapping, kindOf, missingRequirements, normalizeHeader } from './column-mapping';

/**
 * Understanding a shopkeeper's columns (Milestone G).
 *
 * This is the step where people give up. If the app cannot recognise `IMEI No`
 * or `الماركة` on its own, the shop has to map twelve columns by hand before
 * importing anything, and going back to the notebook is genuinely faster.
 */

const fieldsOf = (headers: string[]) =>
  Object.fromEntries(guessMapping(headers).filter((m) => m.field).map((m) => [m.header, m.field]));

describe('recognising headers people actually type', () => {
  it.each([
    ['imei', 'imei'],
    ['IMEI', 'imei'],
    ['IMEI Number', 'imei'],
    ['imei_no', 'imei'],
    ['IMEI-No.', 'imei'],
  ])('reads %s as the IMEI column', (header, field) => {
    expect(guessMapping([header])[0].field).toBe(field);
  });

  it.each([
    ['Serial Number', 'serialNo'],
    ['SN', 'serialNo'],
    ['Cost Price', 'cost'],
    ['Selling Price', 'price'],
    ['Qty', 'quantity'],
    ['Brand', 'brand'],
    ['Storage', 'variant'],
  ])('reads %s as %s', (header, field) => {
    expect(guessMapping([header])[0].field).toBe(field);
  });

  it('leaves a column it does not recognise unmapped rather than guessing', () => {
    /**
     * A wrong guess is worse than no guess. Silently mapping `Warranty` onto
     * `note` would put warranty text where somebody later looks for a comment.
     */
    expect(guessMapping(['Warranty Months'])[0].field).toBeNull();
  });
});

describe('Arabic headers', () => {
  it.each([
    ['الماركة', 'brand'],
    ['الموديل', 'model'],
    ['سعر الشراء', 'cost'],
    ['سعر البيع', 'price'],
    ['الكمية', 'quantity'],
    ['الرقم التسلسلي', 'serialNo'],
  ])('reads %s correctly', (header, field) => {
    expect(guessMapping([header])[0].field).toBe(field);
  });

  it('treats ه and ة as the same letter', () => {
    /**
     * `الماركه` and `الماركة` are the same word to everybody except a string
     * comparison, and which one appears depends on the keyboard.
     */
    expect(normalizeHeader('الماركه')).toBe(normalizeHeader('الماركة'));
    expect(guessMapping(['الماركه'])[0].field).toBe('brand');
  });

  it('treats أ إ آ and ا as the same letter', () => {
    expect(normalizeHeader('إيمي')).toBe(normalizeHeader('ايمي'));
  });

  it('normalises Arabic-Indic digits', () => {
    expect(normalizeHeader('imei١')).toBe('imei1');
  });

  it('ignores diacritics somebody typed by habit', () => {
    expect(normalizeHeader('الكَمية')).toBe(normalizeHeader('الكمية'));
  });
});

describe('one column per field', () => {
  it('does not map two columns onto the same field', () => {
    /**
     * A sheet with both `Price` and `Sale Price` must not have both claim the
     * selling price and silently disagree about which one won.
     */
    const mapped = guessMapping(['Price', 'Sale Price']);
    expect(mapped[0].field).toBe('price');
    expect(mapped[1].field).toBeNull();
  });

  it('keeps cost and price apart', () => {
    expect(fieldsOf(['Cost', 'Price'])).toEqual({ Cost: 'cost', Price: 'price' });
  });
});

describe('what kind of stock the sheet describes', () => {
  it('is decided by the identifier, never asked', () => {
    /**
     * The shop already answered by what they typed. A column of IMEIs is
     * phones; asking again is asking somebody to restate their own file.
     */
    expect(kindOf(guessMapping(['IMEI', 'Model']))).toBe('imei');
    expect(kindOf(guessMapping(['Serial', 'Model']))).toBe('serial');
    expect(kindOf(guessMapping(['Barcode', 'Qty']))).toBe('quantity');
  });

  it('prefers IMEI when a sheet carries both', () => {
    // A phone list with a serial column is still a phone list.
    expect(kindOf(guessMapping(['IMEI', 'Serial']))).toBe('imei');
  });

  it('is null when nothing identifies the stock', () => {
    expect(kindOf(guessMapping(['Model', 'Cost']))).toBeNull();
  });
});

describe('what must be present before anything can be imported', () => {
  it('reports every missing requirement at once, not one at a time', () => {
    /**
     * Fix a header, re-upload, discover the next one missing, repeat — the
     * slowest possible way to learn what a file needs.
     */
    const problems = missingRequirements(guessMapping(['Colour']));
    expect(problems.map((p) => p.field).sort()).toEqual(['cost', 'identifier', 'model']);
  });

  it('requires a cost column', () => {
    /**
     * A product decision, not a technical one. Stock imported without a cost
     * reports infinite margin on every sale, and the shop finds out only once
     * the profit figures are already wrong.
     */
    const problems = missingRequirements(guessMapping(['IMEI', 'Model', 'Price']));
    expect(problems.map((p) => p.field)).toEqual(['cost']);
  });

  it('accepts a complete phone sheet', () => {
    expect(missingRequirements(guessMapping(['IMEI', 'Model', 'Cost']))).toEqual([]);
  });

  it('accepts a complete accessory sheet', () => {
    expect(missingRequirements(guessMapping(['Barcode', 'Product', 'Cost', 'Qty']))).toEqual([]);
  });

  it('does not require a selling price', () => {
    /**
     * Deliberately optional. Pricing is its own workflow with its own history
     * and permission, and forcing a price into an import would either invent
     * one or block a shop that prices at the counter.
     */
    expect(missingRequirements(guessMapping(['IMEI', 'Model', 'Cost']))).toEqual([]);
  });
});
