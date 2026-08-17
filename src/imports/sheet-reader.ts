import { BadRequestException } from '@nestjs/common';
import { parseCsv } from './csv';

/**
 * Turning an uploaded file into rows of text (Milestone G).
 *
 * The only place in this milestone that knows about file formats. Everything
 * downstream — mapping, validation, commit — works on `string[][]` and neither
 * knows nor cares whether it came from a spreadsheet or a text file.
 *
 * `.xlsx` is the recommended path and the reason `exceljs` was added: Excel in
 * an Arabic locale exports CSV as windows-1256, which silently mangles Arabic
 * product names into characters a shopkeeper cannot recognise and cannot fix.
 * A spreadsheet carries UTF-8 natively and sidesteps the whole problem.
 */

export interface SheetContent {
  /** Row 0 is the header. */
  rows: string[][];
  /** How it was read, so a preview can say so plainly. */
  source: 'xlsx' | 'csv';
  /** Reported for CSV, so "we read this as semicolon-separated" is visible. */
  delimiter?: string;
  /** The sheet a workbook was read from, when there was a choice. */
  sheetName?: string;
}

/**
 * A cap, deliberately generous but present.
 *
 * A shop's stock list is hundreds of rows, not hundreds of thousands. The limit
 * exists so a mis-selected file cannot take the server down, not to restrain
 * anybody's real inventory.
 */
export const MAX_ROWS = 20_000;

/** How a spreadsheet cell's value becomes text. */
function cellText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);

  const obj = value as Record<string, unknown>;
  // exceljs wraps formulas, hyperlinks and rich text rather than giving a
  // scalar. A cell showing 1200 must read as 1200 whichever wrapper it is in.
  if (typeof obj.result !== 'undefined') return cellText(obj.result);
  if (typeof obj.text === 'string') return obj.text.trim();
  if (Array.isArray(obj.richText)) {
    return (obj.richText as { text?: string }[]).map((r) => r.text ?? '').join('').trim();
  }
  if (typeof obj.hyperlink === 'string' && typeof obj.text === 'undefined') return obj.hyperlink;
  return String(value).trim();
}

export async function readSheet(buffer: Buffer, filename: string): Promise<SheetContent> {
  const lower = filename.toLowerCase();

  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    const parsed = parseCsv(buffer.toString('utf8'));
    if (parsed.rows.length > MAX_ROWS) {
      throw new BadRequestException(`That file has more than ${MAX_ROWS} rows`);
    }
    return { rows: parsed.rows, source: 'csv', delimiter: parsed.delimiter };
  }

  if (!lower.endsWith('.xlsx') && !lower.endsWith('.xlsm')) {
    // Named rather than vague: "unsupported file" leaves somebody guessing what
    // to do next, and the answer is usually "save it as .xlsx".
    throw new BadRequestException('Send a .xlsx spreadsheet or a .csv file');
  }

  // Required lazily so a CSV import never pays for the spreadsheet library.
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new BadRequestException('That file could not be opened as a spreadsheet');
  }

  /**
   * The first sheet with anything in it. A workbook whose first tab is an empty
   * "Sheet1" left over from a template is common, and refusing it would be
   * refusing a file that plainly has the data on tab two.
   */
  const sheet = workbook.worksheets.find((w) => w.actualRowCount > 0) ?? workbook.worksheets[0];
  if (!sheet) throw new BadRequestException('That spreadsheet has no sheets');
  if (sheet.actualRowCount > MAX_ROWS) {
    throw new BadRequestException(`That sheet has more than ${MAX_ROWS} rows`);
  }

  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = [];
    // `values` is 1-based in exceljs, with a hole at index 0.
    const raw = row.values as unknown[];
    for (let c = 1; c < raw.length; c++) values.push(cellText(raw[c]));
    // A row of nothing is a visual gap, not a phone.
    if (values.some((v) => v !== '')) rows.push(values);
  });

  return { rows, source: 'xlsx', sheetName: sheet.name };
}
