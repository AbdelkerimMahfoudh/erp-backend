import { detectDelimiter, parseCsv } from './csv';

/**
 * The CSV reader (Milestone G).
 *
 * These are the cases that actually break a shopkeeper's file, not the ones
 * that are pleasant to test. Every one of them came from asking "what does a
 * real export from a real Excel look like".
 */

describe('the things a naive split(",") gets wrong', () => {
  it('keeps a comma that is inside a product name', () => {
    const { rows } = parseCsv('imei,model\n123,"Samsung A15, black"');
    expect(rows[1]).toEqual(['123', 'Samsung A15, black']);
  });

  it('keeps a newline that is inside a quoted field', () => {
    /**
     * A note field with a line break in it. Splitting on newlines first would
     * turn one phone into two rows, the second of them nonsense.
     */
    const { rows } = parseCsv('imei,note\n123,"line one\nline two"');
    expect(rows).toHaveLength(2);
    expect(rows[1][1]).toBe('line one\nline two');
  });

  it('unescapes a doubled quote', () => {
    const { rows } = parseCsv('model\n"He said ""hi"""');
    expect(rows[1][0]).toBe('He said "hi"');
  });

  it('strips the byte-order mark Excel writes', () => {
    /**
     * Left in place the BOM becomes part of the first header, so `imei` never
     * matches and the whole file looks like it has no IMEI column — a failure
     * that is completely invisible in a text editor.
     */
    const { rows } = parseCsv('﻿imei,model\n123,A15');
    expect(rows[0][0]).toBe('imei');
  });
});

describe('line endings', () => {
  it.each([
    ['CRLF (Windows)', 'a,b\r\n1,2'],
    ['LF (everything else)', 'a,b\n1,2'],
    ['CR (old Mac exports)', 'a,b\r1,2'],
  ])('handles %s', (_name, text) => {
    expect(parseCsv(text).rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('reads a final row with no trailing newline', () => {
    expect(parseCsv('a\n1').rows).toHaveLength(2);
  });
});

describe('the delimiter is detected, never asked about', () => {
  it('finds a semicolon, which Excel writes in comma-decimal locales', () => {
    /**
     * Asking a shop "is your file comma or semicolon separated" is not a
     * question anybody can answer, and getting it wrong yields one giant column
     * that looks like the app is broken.
     */
    expect(detectDelimiter('imei;model;price')).toBe(';');
    expect(parseCsv('imei;model\n123;A15').rows[1]).toEqual(['123', 'A15']);
  });

  it('finds a tab', () => {
    expect(detectDelimiter('imei\tmodel\tprice')).toBe('\t');
  });

  it('ignores delimiters that are inside quotes when guessing', () => {
    /**
     * The case that makes counting naively wrong: a quoted header containing a
     * comma would otherwise outvote the real semicolons.
     */
    expect(detectDelimiter('"model, colour";imei;price')).toBe(';');
  });

  it('defaults to a comma when nothing stands out', () => {
    expect(detectDelimiter('imei')).toBe(',');
  });

  it('reports which delimiter it used, so a preview can say so', () => {
    expect(parseCsv('a;b').delimiter).toBe(';');
  });
});

describe('the noise in a real spreadsheet', () => {
  it('drops blank lines', () => {
    /**
     * A trailing return, or a visual gap between sections. None of them is a
     * phone, and each would otherwise become an error row the shopkeeper has to
     * read and dismiss.
     */
    const { rows } = parseCsv('a,b\n1,2\n\n\n3,4\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('drops a line that is only delimiters', () => {
    expect(parseCsv('a,b\n,,\n1,2').rows).toHaveLength(2);
  });

  it('keeps an empty cell inside a real row', () => {
    // Missing is data: it means the column was not filled in for this phone.
    expect(parseCsv('a,b,c\n1,,3').rows[1]).toEqual(['1', '', '3']);
  });

  it('reads an empty file as no rows rather than throwing', () => {
    expect(parseCsv('').rows).toEqual([]);
  });
});

describe('Arabic content survives', () => {
  it('reads Arabic product names unchanged', () => {
    /**
     * The reason .xlsx is the recommended path — but when a shop does send CSV
     * as UTF-8, the parser must not mangle it.
     */
    const { rows } = parseCsv('imei,model\n123,"سامسونج ايه ١٥"');
    expect(rows[1][1]).toBe('سامسونج ايه ١٥');
  });
});
