/**
 * A CSV reader (Milestone G).
 *
 * Written rather than installed. The format is small enough that a correct
 * implementation is shorter than the argument for adding a dependency, and the
 * cases that actually break shopkeepers — a comma inside a product name, a
 * quoted field with a newline in it, the byte-order mark Excel writes — are
 * exactly the ones a hand-rolled `split(',')` gets wrong.
 *
 * Follows RFC 4180, with the two deviations real files require:
 *   - CRLF, LF and CR line endings all accepted.
 *   - A semicolon delimiter, because Excel uses one in locales where the comma
 *     is the decimal separator. Detected, never configured — asking a shop
 *     which delimiter their spreadsheet uses is not a question they can answer.
 */

export interface CsvParseResult {
  rows: string[][];
  /** The delimiter that was detected, reported so a preview can say so. */
  delimiter: ',' | ';' | '\t';
}

/** Excel writes a UTF-8 BOM. Left in place it becomes part of the first header. */
const BOM = '﻿';

/**
 * Guess the delimiter from the header line.
 *
 * Counts candidates OUTSIDE quotes only — a product name like
 * `"Samsung A15, black"` would otherwise make the comma look like the winner in
 * a semicolon-delimited file.
 */
export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? '';
  let inQuotes = false;
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === ',' || ch === ';' || ch === '\t')) counts[ch]++;
  }
  // Ties go to the comma: it is the format most exports produce, and a header
  // with one of each is more likely comma-delimited with a stray semicolon.
  if (counts[';'] > counts[','] && counts[';'] >= counts['\t']) return ';';
  if (counts['\t'] > counts[','] && counts['\t'] > counts[';']) return '\t';
  return ',';
}

export function parseCsv(input: string, forced?: ',' | ';' | '\t'): CsvParseResult {
  const text = input.startsWith(BOM) ? input.slice(1) : input;
  const delimiter = forced ?? detectDelimiter(text);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        // A doubled quote inside a quoted field is one literal quote — the rule
        // that makes `"He said ""hi"""` work.
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"' && field === '') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      endField();
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      endRow();
      // Consume CRLF as one break, not two.
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    i++;
  }

  // A file not ending in a newline still has a last row.
  if (field !== '' || row.length > 0) endRow();

  return {
    /**
     * Blank lines are dropped. Spreadsheets are full of them — a trailing
     * return, a visual gap between sections — and none of them is a phone.
     */
    rows: rows.filter((r) => r.some((c) => c.trim() !== '')),
    delimiter,
  };
}
