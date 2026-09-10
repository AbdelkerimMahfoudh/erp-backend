import { parseCsv, detectDelimiter } from '../imports/csv';
import { armour, BOM, DELIMITER, writeCsv } from './csv-writer';
import { count, isoDate, money, text } from './report-values';

/**
 * The writer, checked against the reader that already exists.
 *
 * Round-tripping is the strongest assertion available here: if a file this
 * project writes cannot be read by the parser this project ships, the claim
 * that the export is a CSV is decoration. Most of these cases are the reader's
 * own test corpus, run in the other direction.
 */

describe('writing a CSV', () => {
  it('puts the byte-order mark at the very front, once', () => {
    // Without it Excel reads UTF-8 as the system codepage and Arabic becomes
    // mojibake — the single most likely way this feature "works" and is useless.
    const csv = writeCsv(['a'], [['b']]);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.split(BOM).length - 1).toBe(1);
  });

  it('quotes a delimiter, a quote and a newline, and nothing else', () => {
    const csv = writeCsv(['plain', 'comma', 'quote', 'newline'], [
      ['ordinary', 'Samsung A15, black', 'He said "hi"', 'line one\nline two'],
    ]);
    expect(csv).toContain('ordinary');
    expect(csv).toContain('"Samsung A15, black"');
    expect(csv).toContain('"He said ""hi"""');
    expect(csv).toContain('"line one\nline two"');
  });

  it('reads back through the project\'s own parser, unchanged', () => {
    const rows = [
      ['Samsung A15, black', '1 200,00', 'note with "quotes"'],
      ['multi\nline', '0.00', ''],
      ['tab\there', '-45.50', 'plain'],
    ];
    const parsed = parseCsv(writeCsv(['a', 'b', 'c'], rows));
    // Trailing newline produces no extra row.
    expect(parsed.rows).toEqual([['a', 'b', 'c'], ...rows]);
  });

  it('is comma-delimited, and the detector agrees', () => {
    expect(DELIMITER).toBe(',');
    const csv = writeCsv(['one', 'two'], [['a', 'b']]);
    expect(detectDelimiter(csv.slice(BOM.length))).toBe(',');
  });

  it('survives a semicolon inside a cell without changing delimiter', () => {
    // The reader supports `;` as a delimiter, so a cell containing one has to
    // be quoted or a round trip silently re-splits the row.
    const parsed = parseCsv(writeCsv(['a', 'b'], [['x;y', 'z']]));
    expect(parsed.delimiter).toBe(',');
    expect(parsed.rows[1]).toEqual(['x;y', 'z']);
  });

  it('writes Arabic through unchanged', () => {
    const parsed = parseCsv(writeCsv(['المنتج'], [['هاتف ذكي']]));
    expect(parsed.rows).toEqual([['المنتج'], ['هاتف ذكي']]);
  });

  it('produces a valid header-only file for an empty report', () => {
    const csv = writeCsv(['Product', 'Revenue (MRU)'], []);
    const parsed = parseCsv(csv);
    expect(parsed.rows).toEqual([['Product', 'Revenue (MRU)']]);
  });

  it('ends rows with CRLF', () => {
    expect(writeCsv(['a'], [['b']])).toBe(`${BOM}a\r\nb\r\n`);
  });
});

describe('formula injection', () => {
  /*
   * The attack: a product named `=HYPERLINK("http://evil","click")` is a
   * perfectly valid CSV cell and a live formula the moment Excel opens it.
   * Correct quoting does not help — quoting is about parsing, and evaluation
   * happens afterwards.
   */
  it.each(['=1+1', '+1', '-1+1', '@SUM(A1)', '\tx', '\rx'])('armours %p', (dangerous) => {
    expect(armour(dangerous)).toBe(`'${dangerous}`);
  });

  it('leaves ordinary text alone', () => {
    for (const safe of ['Samsung A15', 'iPhone 15 Pro', '256GB', 'محمد', '']) {
      expect(armour(safe)).toBe(safe);
    }
  });

  it('applies to typed text but NEVER to money', () => {
    // The distinction that matters: a negative balance must stay a number the
    // spreadsheet can add up. Armouring it would turn -4000 into text.
    expect(text('=cmd')).toBe("'=cmd");
    expect(money(-4000)).toBe('-4000.00');
    expect(money(-4000).startsWith("'")).toBe(false);
  });

  it('survives the round trip with the apostrophe intact', () => {
    const parsed = parseCsv(writeCsv(['name'], [[text('=1+1')]]));
    expect(parsed.rows[1]).toEqual(["'=1+1"]);
  });
});

describe('values', () => {
  it('writes zero as zero and missing as empty', () => {
    expect(money(0)).toBe('0.00');
    expect(money(null)).toBe('');
    expect(money(undefined)).toBe('');
    expect(count(0)).toBe('0');
    expect(count(null)).toBe('');
  });

  it('keeps negatives, and normalises negative zero', () => {
    expect(money(-1234.5)).toBe('-1234.50');
    expect(money(-0)).toBe('0.00');
    expect(money(-0.001)).toBe('0.00');
  });

  it('writes money with two decimals, no grouping and no symbol', () => {
    expect(money(1234567.891)).toBe('1234567.89');
    expect(money(1200)).toBe('1200.00');
    expect(money(1200)).not.toContain(',');
    expect(money(1200)).not.toContain('MRU');
  });

  it('writes dates as UTC calendar days', () => {
    expect(isoDate(new Date('2026-03-07T23:30:00.000Z'))).toBe('2026-03-07');
    expect(isoDate(null)).toBe('');
    expect(isoDate('not a date')).toBe('');
  });
});
