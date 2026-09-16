import JSZip from 'jszip';
import { BadRequestException } from '@nestjs/common';

/**
 * A workbook read as text, tolerantly.
 *
 * `exceljs` (used by the opening-inventory import) refuses the very files shops
 * actually send: the demo workbook writes its XML with an `x:` namespace prefix
 * — valid OOXML, produced by several generators — and exceljs throws on it. So
 * this reader parses the sheet XML itself, and it deliberately does LESS than a
 * spreadsheet engine:
 *
 * - **Nothing is evaluated.** A formula cell is read from its cached `<v>` only,
 *   and reported as a formula so the review can flag it. Macros, external links
 *   and defined names are never touched.
 * - **Everything is text.** An IMEI is a string of fifteen digits, and a reader
 *   that turns it into a number loses the last digits and any leading zero.
 *   Values are emitted exactly as the file stored them.
 * - **A value the file could not keep is flagged, never guessed.** A cell
 *   holding `9.9E+14` is reported as rounded rather than silently expanded.
 */

export interface SheetCell {
  /** The text as stored. Empty string for a blank cell. */
  text: string;
  /** The cell carried a formula; only its cached result was read. */
  formula?: boolean;
  /** Stored in scientific notation — digits are genuinely lost. */
  rounded?: boolean;
}

export interface WorkbookSheet {
  name: string;
  /** Rows in file order; header detection happens later. */
  rows: SheetCell[][];
  /** 1-based row numbers as the spreadsheet shows them, parallel to `rows`. */
  rowNumbers: number[];
}

export const MAX_SHEET_ROWS = 20_000;
export const MAX_SHEETS = 50;

/** XML text content, unescaped. */
function text(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** `AB12` → 27. Column letters are what put a cell in the right field. */
export function columnIndex(ref: string): number {
  const letters = ref.replace(/[^A-Z]/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Elements by local name, whatever namespace prefix they carry.
 *
 * `<x:sheet/>` and `<sheet/>` are the same element; a reader that only knows
 * the unprefixed spelling rejects perfectly valid workbooks — which is exactly
 * how the previous reader failed.
 */
function all(xml: string, name: string): string[] {
  const out: string[] = [];
  const open = new RegExp('<(?:[A-Za-z0-9_.-]+:)?' + name + '(?=[\\s/>])([^>]*?)(/?)>', 'g');
  const close = new RegExp('</(?:[A-Za-z0-9_.-]+:)?' + name + '>', 'g');
  let m: RegExpExecArray | null;
  while ((m = open.exec(xml))) {
    if (m[2] === '/') {
      out.push(m[0]);
      continue;
    }
    close.lastIndex = open.lastIndex;
    const end = close.exec(xml);
    if (!end) break;
    out.push(xml.slice(m.index, end.index + end[0].length));
    open.lastIndex = end.index + end[0].length;
  }
  return out;
}

function attr(s: string, name: string): string | null {
  const m = new RegExp('\\b' + name.replace(':', '\\:') + '="([^"]*)"').exec(s);
  return m ? m[1] : null;
}

function inner(s: string, name: string): string | null {
  const m = new RegExp(
    '<(?:[A-Za-z0-9_.-]+:)?' + name + '(?:[\\s][^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?' + name + '>',
  ).exec(s);
  return m ? m[1] : null;
}

function hasTag(s: string, name: string): boolean {
  return new RegExp('<(?:[A-Za-z0-9_.-]+:)?' + name + '(?=[\\s/>])').test(s);
}

/** Shared strings, in file order — `t="s"` cells index into this. */
function sharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  return all(xml, 'si').map((si) =>
    all(si, 't')
      .map((t) => text(inner(t, 't') ?? ''))
      .join(''),
  );
}

function cellValue(c: string, shared: string[]): SheetCell {
  const type = attr(c, 't');
  const formula = hasTag(c, 'f');
  if (type === 'inlineStr') {
    const value = all(c, 't')
      .map((t) => text(inner(t, 't') ?? ''))
      .join('')
      .trim();
    return { text: value, ...(formula ? { formula: true } : {}) };
  }
  const raw = inner(c, 'v');
  if (raw == null) return { text: '', ...(formula ? { formula: true } : {}) };
  const value = text(raw).trim();
  if (type === 's') {
    return { text: shared[Number(value)] ?? '', ...(formula ? { formula: true } : {}) };
  }
  // A number the file kept in scientific notation has already lost digits.
  const rounded = /^[-+]?\d(?:\.\d+)?[eE][-+]?\d+$/.test(value);
  return { text: value, ...(formula ? { formula: true } : {}), ...(rounded ? { rounded: true } : {}) };
}

export async function readWorkbook(buffer: Buffer): Promise<WorkbookSheet[]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new BadRequestException({ code: 'file_unreadable', message: 'That file is not a readable .xlsx workbook' });
  }
  const workbookXml = await zip.file('xl/workbook.xml')?.async('string');
  if (!workbookXml) {
    throw new BadRequestException({ code: 'file_unreadable', message: 'That file is not a readable .xlsx workbook' });
  }
  const relsXml = (await zip.file('xl/_rels/workbook.xml.rels')?.async('string')) ?? '';
  const shared = sharedStrings((await zip.file('xl/sharedStrings.xml')?.async('string')) ?? null);

  const rels = new Map<string, string>();
  for (const r of all(relsXml, 'Relationship')) {
    const id = attr(r, 'Id');
    const target = attr(r, 'Target');
    if (id && target) rels.set(id, target.replace(/^\/?xl\//, '').replace(/^\.\//, ''));
  }

  const sheets: WorkbookSheet[] = [];
  const declared = all(workbookXml, 'sheet').slice(0, MAX_SHEETS);
  for (const [order, decl] of declared.entries()) {
    const name = text(attr(decl, 'name') ?? 'Sheet ' + String(order + 1));
    const rid = attr(decl, 'r:id') ?? attr(decl, 'id');
    const path = (rid && rels.get(rid)) ?? 'worksheets/sheet' + String(order + 1) + '.xml';
    const xml = await zip.file('xl/' + path)?.async('string');
    if (!xml) continue;

    const rows: SheetCell[][] = [];
    const rowNumbers: number[] = [];
    for (const row of all(xml, 'row')) {
      if (rows.length >= MAX_SHEET_ROWS) {
        throw new BadRequestException({
          code: 'file_too_large',
          message: 'A sheet has more than ' + String(MAX_SHEET_ROWS) + ' rows',
        });
      }
      const cells: SheetCell[] = [];
      for (const c of all(row, 'c')) {
        const ref = attr(c, 'r');
        const at = ref ? columnIndex(ref) : cells.length;
        while (cells.length < at) cells.push({ text: '' });
        cells[at] = cellValue(c, shared);
      }
      rows.push(cells);
      rowNumbers.push(Number(attr(row, 'r') ?? rows.length));
    }
    sheets.push({ name, rows, rowNumbers });
  }
  if (sheets.length === 0) {
    throw new BadRequestException({ code: 'file_empty', message: 'That workbook has no sheets' });
  }
  return sheets;
}
