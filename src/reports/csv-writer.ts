/**
 * A CSV writer — the mirror of the reader in `imports/csv.ts`.
 *
 * Written rather than installed for the same reason the reader was: the format
 * is small, and the cases that break shopkeepers are the ones a `join(',')`
 * gets wrong. Every decision here is the reader's decision, read backwards, so
 * a file this app writes is a file this app can read.
 *
 * ## Delimiter
 *
 * **Comma, always.** The reader *detects* `,`, `;` or tab because it is handed
 * files written by other people's Excel. The writer has no such excuse: it
 * chooses, and a single choice is one fewer thing to be wrong. The BOM below is
 * what makes a comma-delimited file open correctly in a semicolon locale, and
 * `detectDelimiter` resolves ties to the comma, so the round trip holds.
 *
 * ## The BOM
 *
 * Excel reads a UTF-8 file as the system codepage unless it sees a byte-order
 * mark — which turns Arabic into mojibake and `Téléphone` into `TÃ©lÃ©phone`.
 * The mark is three bytes at the front. The reader strips it; LibreOffice and
 * Google Sheets ignore it.
 *
 * ## Formula injection
 *
 * A cell beginning `=`, `+`, `-`, `@`, tab or carriage return can be executed
 * by a spreadsheet when the file is opened. Quoting does not prevent it —
 * quoting is about CSV parsing, and the formula is evaluated after the parse.
 * See the note on `armour` for what is done and what it does not cover.
 */

/** Excel needs this to read UTF-8. `parseCsv` strips it back off. */
export const BOM = '﻿';

/** The one delimiter this writer emits. See the note above. */
export const DELIMITER = ',';

const NEEDS_QUOTING = /["\r\n,;\t]/;

/**
 * Neutralise a cell a spreadsheet might execute.
 *
 * A leading apostrophe is prepended to text that opens with a formula trigger.
 * Excel and LibreOffice treat that as "this is text"; the apostrophe is not
 * shown in the cell, though it *is* in the file, so a parser sees it. That is
 * the trade, and it is the right way round: a visible stray character beats a
 * cell that dials out to a URL when the accountant opens the file.
 *
 * **This only applies to free text** — names, notes, references, anything a
 * user typed. Numbers are written by `money()` and `plain()` from values the
 * server computed, and are never armoured: prefixing a negative balance would
 * turn `-4000` into text and break the arithmetic the export exists for. That
 * is why the guard below is applied per column type, not to every cell.
 *
 * **What it does not cover.** A cell that is legitimately text and legitimately
 * starts with `-` (a note reading "-- draft --") gains an apostrophe. And a
 * spreadsheet configured to import CSV with its own settings can still be told
 * to treat the column as a formula. The protection is at the file level; it
 * cannot reach past a user who overrides it.
 */
export function armour(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** RFC 4180 quoting: wrap when needed, and double any embedded quote. */
function quote(cell: string): string {
  if (!NEEDS_QUOTING.test(cell)) return cell;
  return `"${cell.replace(/"/g, '""')}"`;
}

/**
 * Serialise rows of already-stringified cells.
 *
 * Takes strings, not values: every conversion — money precision, dates, null
 * versus zero — is a reporting decision, and making it here would hide it
 * inside a formatting utility. `report-values.ts` owns those.
 *
 * ## The file is a rectangle, and nothing else
 *
 * A provenance block above the table was tried and removed. It read well for a
 * human and broke every machine: `parseCsv` skips blank lines *and* all-empty
 * rows, so the separator vanished and the metadata arrived as data — and an
 * "empty report" stopped being a header-only file, which is the one shape a
 * spreadsheet handles without argument.
 *
 * So which report, which period and which branch live in the FILENAME, where
 * every export tool puts them and where nothing can misread them as figures.
 *
 * CRLF line endings, because that is what RFC 4180 says and what Excel expects.
 * A trailing newline is emitted so the last row ends like the others.
 */
export function writeCsv(header: string[], rows: string[][]): string {
  const lines = [header, ...rows].map((row) => row.map(quote).join(DELIMITER));
  return BOM + lines.join('\r\n') + '\r\n';
}
