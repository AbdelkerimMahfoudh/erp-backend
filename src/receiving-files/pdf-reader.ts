import { BadRequestException } from '@nestjs/common';

/**
 * A text PDF read into rows, by geometry rather than by guesswork.
 *
 * PDF has no tables: it has glyphs at coordinates. So every text item keeps its
 * position, items sharing a baseline become one row, and the row's cells stay in
 * left-to-right order. That is what keeps a price and a second IMEI attached to
 * the phone printed on their own line — the brief's rule that nothing may be
 * associated "by proximity" means association by BASELINE, never by "the next
 * number after an IMEI".
 *
 * What it does not do: it never rasterises, never OCRs, and never guesses at a
 * page it could not read. A page with no text layer is reported as such, so the
 * app can say which pages need another route rather than claiming the whole file
 * was processed.
 */

export interface PdfRow {
  /** 1-based page. */
  page: number;
  /** Cells left to right, as printed. */
  cells: string[];
}

export interface PdfContent {
  rows: PdfRow[];
  pages: number;
  /** Pages with no extractable text at all — image-only scans. */
  imageOnlyPages: number[];
}

export const MAX_PDF_PAGES = 200;

/** Items whose baselines differ by less than this are the same row. */
const ROW_TOLERANCE = 3;
/** A gap wider than this starts a new cell rather than a space. */
const COLUMN_GAP = 12;

interface Item {
  str: string;
  x: number;
  y: number;
  width: number;
}

/** Group one page's text items into rows of cells. Pure, so it is testable. */
export function rowsFromItems(items: Item[], page: number): PdfRow[] {
  const printable = items.filter((i) => i.str.trim().length > 0);
  if (printable.length === 0) return [];

  const lines: Item[][] = [];
  for (const item of [...printable].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines.find((l) => Math.abs(l[0].y - item.y) <= ROW_TOLERANCE);
    if (line) line.push(item);
    else lines.push([item]);
  }

  return lines.map((line) => {
    const ordered = [...line].sort((a, b) => a.x - b.x);
    const cells: string[] = [];
    let current = '';
    let cursor: number | null = null;
    for (const item of ordered) {
      if (cursor !== null && item.x - cursor > COLUMN_GAP) {
        cells.push(current.trim());
        current = '';
      }
      current += (current && !current.endsWith(' ') ? ' ' : '') + item.str.trim();
      cursor = item.x + item.width;
    }
    if (current.trim()) cells.push(current.trim());
    return { page, cells };
  });
}

export async function readPdf(buffer: Buffer): Promise<PdfContent> {
  // Imported lazily: pdfjs is an ES module and only file receiving needs it, so
  // nothing else pays for loading it.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      // No fonts to render and no scripts to run: this is a text extraction,
      // and a PDF's own JavaScript must never execute on the server.
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
    }).promise;
  } catch {
    throw new BadRequestException({ code: 'file_unreadable', message: 'That file is not a readable PDF' });
  }

  if (doc.numPages > MAX_PDF_PAGES) {
    await doc.destroy();
    throw new BadRequestException({
      code: 'file_too_large',
      message: 'That PDF has more than ' + String(MAX_PDF_PAGES) + ' pages',
    });
  }

  const rows: PdfRow[] = [];
  const imageOnlyPages: number[] = [];
  for (let page = 1; page <= doc.numPages; page++) {
    const p = await doc.getPage(page);
    const content = await p.getTextContent();
    // `getTextContent` mixes text items with marked-content markers; only the
    // former carry a string and a position.
    const items: Item[] = content.items
      .filter((i): i is typeof i & { str: string; transform: number[]; width: number } => 'str' in i)
      .map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], width: i.width }));
    const pageRows = rowsFromItems(items, page);
    if (pageRows.length === 0) imageOnlyPages.push(page);
    rows.push(...pageRows);
  }
  const pages = doc.numPages;
  await doc.destroy();

  if (rows.length === 0) {
    throw new BadRequestException({
      code: 'pdf_image_only',
      message: 'This PDF has no text to read — every page is an image',
    });
  }
  return { rows, pages, imageOnlyPages };
}
