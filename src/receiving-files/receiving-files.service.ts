import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { binToUuid } from '../common/utils/uuid.util';
import { currencyInHeading, guessColumns, missingRequired, sheetScore, type ColumnGuess, type FileField } from './file-columns';
import {
  buildEntry,
  identifiersOf,
  markDuplicatesInFile,
  summarise,
  type FileEntry,
  type SourceRef,
} from './file-entries';
import { matchProduct, type CatalogueProduct } from './product-match';
import { mergeByGap, readPdf, type PdfCell } from './pdf-reader';
import { readWorkbook, type SheetCell } from './xlsx-reader';

/**
 * Reading a delivery out of a file — and writing nothing.
 *
 * This service PARSES. It creates no purchase, no unit and no payment: the
 * review screen sends the phones the person confirmed to `POST /purchases`,
 * which already receives stock paid in full, atomically and idempotently. That
 * is deliberate — opening-inventory import has different cash semantics (it
 * moves no money), so file receiving must never go through it.
 *
 * Everything it reports is either read from the file or looked up in this
 * tenant's own catalogue and stock. It never invents a value, and every entry
 * carries the sheet and row (or PDF page) it came from.
 */

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_PHONES_PER_FILE = 2_000;

export interface SheetSummary {
  name: string;
  rows: number;
  /** Which column is which, as guessed — the app may correct it. */
  columns: ColumnGuess[];
  missing: FileField[];
  /** True for the sheet this parse actually read. */
  selected: boolean;
  /** Reads as instructions rather than stock. */
  looksExplanatory: boolean;
}

export interface ParseResult {
  source: 'xlsx' | 'pdf';
  filename: string;
  sheets: SheetSummary[];
  entries: FileEntry[];
  /** Product decisions, keyed by entry. */
  matches: Record<string, { productId: string | null; candidates: CatalogueProduct[]; exact: boolean }>;
  counts: ReturnType<typeof summarise>;
  /** Pages of a PDF with no text layer at all. */
  imageOnlyPages: number[];
  pages: number | null;
}

@Injectable()
export class ReceivingFilesService {
  constructor(@Inject(TENANT_PRISMA) private readonly db: TenantPrisma) {}

  async parse(
    file: { buffer: Buffer; originalname: string; mimetype?: string },
    options: { sheet?: string; mapping?: Record<string, number> } = {},
  ): Promise<ParseResult> {
    const name = (file.originalname ?? '').toLowerCase();
    if (file.buffer.length > MAX_FILE_BYTES) {
      throw new BadRequestException({ code: 'file_too_large', message: 'That file is larger than 8 MB' });
    }
    if (name.endsWith('.xlsx')) return this.parseWorkbook(file, options);
    if (name.endsWith('.pdf')) return this.parsePdf(file, options);
    throw new BadRequestException({
      code: 'file_type_unsupported',
      message: 'Only .xlsx workbooks and text PDFs can be read',
    });
  }

  // ── Excel ─────────────────────────────────────────────────────────────────

  private async parseWorkbook(
    file: { buffer: Buffer; originalname: string },
    options: { sheet?: string; mapping?: Record<string, number> },
  ): Promise<ParseResult> {
    const sheets = await readWorkbook(file.buffer);

    const scored = sheets.map((s) => {
      const headings = (s.rows[0] ?? []).map((c) => c.text);
      const body = s.rows.slice(1).filter((r) => r.some((c) => c.text.trim()));
      return { sheet: s, headings, bodyCount: body.length, score: sheetScore(headings, body.length) };
    });

    const chosen =
      (options.sheet ? scored.find((s) => s.sheet.name === options.sheet) : undefined) ??
      [...scored].sort((a, b) => b.score - a.score)[0];

    const columns = this.columnsFor(chosen.headings, options.mapping);
    const costHeading = chosen.headings[columns.find((c) => c.field === 'cost')?.index ?? -1] ?? '';
    const headingCurrency = currencyInHeading(costHeading);

    const entries: FileEntry[] = [];
    for (const [i, row] of chosen.sheet.rows.entries()) {
      if (i === 0) continue;
      if (!row.some((c) => c.text.trim())) continue;
      if (entries.length >= MAX_PHONES_PER_FILE) {
        throw new BadRequestException({
          code: 'file_too_large',
          message: `A file may hold at most ${MAX_PHONES_PER_FILE} phones`,
        });
      }
      const source: SourceRef = { sheet: chosen.sheet.name, row: chosen.sheet.rowNumbers[i], page: null };
      entries.push(buildEntry({ cells: row as SheetCell[], columns, source, headingCurrency }, `r${chosen.sheet.rowNumbers[i]}`));
    }

    const summaries: SheetSummary[] = scored.map((s) => ({
      name: s.sheet.name,
      rows: s.bodyCount,
      columns: s.sheet === chosen.sheet ? columns : this.columnsFor(s.headings),
      missing: missingRequired(s.sheet === chosen.sheet ? columns : this.columnsFor(s.headings)),
      selected: s.sheet === chosen.sheet,
      looksExplanatory: s.score < 10,
    }));

    return this.finish({
      source: 'xlsx',
      filename: file.originalname,
      sheets: summaries,
      entries,
      imageOnlyPages: [],
      pages: null,
    });
  }

  // ── PDF ───────────────────────────────────────────────────────────────────

  private async parsePdf(
    file: { buffer: Buffer; originalname: string },
    options: { mapping?: Record<string, number> },
  ): Promise<ParseResult> {
    const pdf = await readPdf(file.buffer);

    /*
     * A printed table repeats its header on every page. The first row that maps
     * to a required field is the heading; any later row that repeats it is a
     * header again, not a phone.
     */
    const headerRow = pdf.rows
      .map((r) => ({ page: r.page, cells: mergeByGap(r.cells) }))
      .find((r) => missingRequired(guessColumns(r.cells.map((c) => c.text))).length === 0);
    if (!headerRow) {
      throw new BadRequestException({
        code: 'pdf_no_table',
        message: 'No column headings were found in that PDF — check it is the stock list, not a letter',
      });
    }
    const headings = headerRow.cells.map((c) => c.text);
    /*
     * Where each column starts on the page.
     *
     * A printed row has no fixed number of cells: a phone with no second IMEI
     * simply prints nothing there, and reading cells in order would slide its
     * price into the IMEI 2 column. So every cell is placed in the column whose
     * heading it sits under — which is also what keeps a value on the row it
     * was printed on rather than near.
     */
    const columnX = headerRow.cells.map((c) => c.x);
    const columns = this.columnsFor(headings, options.mapping);
    const headerKey = headings.map((h) => h.trim().toLowerCase()).join('|');
    const headingCurrency = currencyInHeading(headings[columns.find((c) => c.field === 'cost')?.index ?? -1] ?? '');

    const entries: FileEntry[] = [];
    for (const [i, row] of pdf.rows.entries()) {
      const merged = mergeByGap(row.cells);
      if (merged.map((c) => c.text.trim().toLowerCase()).join('|') === headerKey) continue;
      if (row.cells.every((c) => !c.text.trim())) continue;
      if (entries.length >= MAX_PHONES_PER_FILE) {
        throw new BadRequestException({
          code: 'file_too_large',
          message: `A file may hold at most ${MAX_PHONES_PER_FILE} phones`,
        });
      }
      const source: SourceRef = { sheet: null, row: null, page: row.page };
      const entry = buildEntry({ cells: alignToColumns(row.cells, columnX), columns, source, headingCurrency }, `p${row.page}-${i}`);
      /*
       * Page furniture — a title, a page number, a total — is not a phone
       * somebody forgot to fill in. A printed line counts as a phone only when
       * it carries an identifier, or both a model and a price.
       */
      const identified = Boolean(entry.extracted.imei1 ?? entry.extracted.serial);
      const described = Boolean(entry.extracted.model && entry.extracted.cost !== null);
      if (!identified && !described) continue;
      entries.push(entry);
    }

    return this.finish({
      source: 'pdf',
      filename: file.originalname,
      sheets: [
        {
          name: file.originalname,
          rows: entries.length,
          columns,
          missing: missingRequired(columns),
          selected: true,
          looksExplanatory: false,
        },
      ],
      entries,
      imageOnlyPages: pdf.imageOnlyPages,
      pages: pdf.pages,
    });
  }

  // ── shared ────────────────────────────────────────────────────────────────


  /** The guess, with the app's corrections applied on top. */
  private columnsFor(headings: string[], mapping?: Record<string, number>): ColumnGuess[] {
    const columns = guessColumns(headings);
    if (!mapping) return columns;
    for (const [field, index] of Object.entries(mapping)) {
      for (const c of columns) if (c.field === field) c.field = null;
      const target = columns.find((c) => c.index === Number(index));
      if (target) target.field = field as FileField;
    }
    return columns;
  }

  /** Duplicates, catalogue matches and counts — the parts that need the database. */
  private async finish(base: Omit<ParseResult, 'matches' | 'counts'>): Promise<ParseResult> {
    markDuplicatesInFile(base.entries);

    const identifiers = identifiersOf(base.entries);
    const existing = identifiers.length
      ? await this.db.unit.findMany({
          where: {
            OR: [{ imeiPrimary: { in: identifiers } }, { imeiSecondary: { in: identifiers } }, { serialNo: { in: identifiers } }],
          },
          select: { imeiPrimary: true, imeiSecondary: true, serialNo: true },
        })
      : [];
    const inStock = new Set<string>();
    for (const u of existing) {
      for (const v of [u.imeiPrimary, u.imeiSecondary, u.serialNo]) if (v) inStock.add(v);
    }
    for (const e of base.entries) {
      const hit = [e.extracted.imei1, e.extracted.imei2, e.extracted.serial].some((v) => v && inStock.has(v));
      if (hit && !e.problems.includes('duplicate_in_stock')) e.problems.push('duplicate_in_stock');
    }

    const catalogue = await this.catalogue(base.entries);
    const matches: ParseResult['matches'] = {};
    for (const e of base.entries) {
      const outcome = matchProduct(
        {
          brand: e.extracted.brand,
          model: e.extracted.model,
          storage: e.extracted.storage,
          colour: e.extracted.colour,
        },
        catalogue,
      );
      if (outcome.kind === 'matched') {
        matches[e.key] = { productId: outcome.productId, candidates: [], exact: outcome.exact };
      } else if (outcome.kind === 'ambiguous') {
        matches[e.key] = { productId: null, candidates: outcome.candidates, exact: false };
        if (!e.problems.includes('product_ambiguous')) e.problems.push('product_ambiguous');
      } else {
        matches[e.key] = { productId: null, candidates: [], exact: false };
        if (e.extracted.model && !e.problems.includes('product_unknown')) e.problems.push('product_unknown');
      }
    }

    return { ...base, matches, counts: summarise(base.entries) };
  }

  /** Only the products a file could plausibly mean, scoped to this tenant. */
  private async catalogue(entries: FileEntry[]): Promise<CatalogueProduct[]> {
    const models = [...new Set(entries.map((e) => e.extracted.model).filter((m): m is string => Boolean(m)))];
    if (models.length === 0) return [];
    const rows = await this.db.product.findMany({
      where: { model: { in: models } },
      select: { id: true, brand: true, model: true, variant: true, trackingType: true },
      take: 2_000,
    });
    return rows.map((r) => ({
      id: binToUuid(r.id),
      brand: r.brand,
      model: r.model,
      variant: r.variant,
      trackingType: r.trackingType as CatalogueProduct['trackingType'],
    }));
  }
}

/**
 * Put each printed cell in the column whose heading it sits under.
 *
 * Nearest heading by starting position, with a guard: a cell further from every
 * heading than half the widest column gap is left out rather than forced into a
 * column it does not belong to.
 */
export function alignToColumns(cells: readonly PdfCell[], columnX: readonly number[]): { text: string }[] {
  const out: { text: string }[] = columnX.map(() => ({ text: '' }));
  const gaps = columnX.slice(1).map((x, i) => x - columnX[i]);
  const tolerance = (gaps.length ? Math.max(...gaps) : 60) * 0.75;

  const place = (text: string, x: number) => {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const [i, cx] of columnX.entries()) {
      const d = Math.abs(x - cx);
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    if (best < 0 || bestDistance > tolerance) return;
    out[best] = { text: out[best].text ? out[best].text + ' ' + text : text };
  };

  for (const cell of cells) {
    /*
     * One printed item can cover two columns.
     *
     * When the gap between them is narrow, pdfjs hands back a single text item
     * — "351234000001016 12500" — and reading it as one value puts the price
     * inside the IMEI. So an item that reaches past the next column heading is
     * split on its spaces, and each piece placed by where it actually sits,
     * estimated from the item's own measured width.
     */
    const pieces = cell.text.split(/\s+/).filter(Boolean);
    const spansAnother = columnX.some((cx) => cx > cell.x + 1 && cx < cell.x + cell.width);
    if (pieces.length > 1 && spansAnother && cell.width > 0) {
      const characters = pieces.reduce((a, piece) => a + piece.length, 0) + (pieces.length - 1);
      let consumed = 0;
      for (const piece of pieces) {
        place(piece, cell.x + (consumed / characters) * cell.width);
        consumed += piece.length + 1;
      }
      continue;
    }
    place(cell.text, cell.x);
  }
  return out;
}
