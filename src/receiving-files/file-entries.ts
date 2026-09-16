import { isValidImei } from '../inventory/imei.util';
import type { ColumnGuess, FileField } from './file-columns';

/**
 * One row of a file becomes one physical phone — or an entry that says exactly
 * why it cannot be received yet.
 *
 * The rules that matter, all of them from the brief and all of them tested:
 *
 * - **A row is a phone.** Two IMEIs on one row are one unit with a second
 *   identifier, never two units and never two unrelated phones paired up.
 * - **Nothing is invented.** A missing storage, colour or cost stays missing.
 *   Nothing is inferred from an IMEI: a TAC may suggest a model for REVIEW, and
 *   it never fills a price, a colour or a capacity.
 * - **Identifiers are strings.** Digits and leading zeros are preserved, and a
 *   value the file already rounded is refused rather than reconstructed.
 * - **Every entry keeps its source** — sheet and spreadsheet row, or PDF page —
 *   so a person can find the line they need to fix.
 */

export type EntryProblem =
  | 'imei1_missing'
  | 'imei1_invalid'
  | 'imei1_rounded'
  | 'imei2_invalid'
  | 'imei2_same_as_imei1'
  | 'imei2_rounded'
  | 'model_missing'
  | 'cost_missing'
  | 'cost_invalid'
  | 'duplicate_in_file'
  | 'duplicate_in_stock'
  | 'product_unknown'
  | 'product_ambiguous'
  | 'formula_value';

export interface SourceRef {
  /** Worksheet name, or null for a PDF. */
  sheet: string | null;
  /** 1-based spreadsheet row, when the source is a sheet. */
  row: number | null;
  /** 1-based page, when the source is a PDF. */
  page: number | null;
}

export interface FileEntry {
  /** Stable within one parse, so corrections and exclusions can name a row. */
  key: string;
  source: SourceRef;
  /** Exactly what the file said, kept apart from any correction. */
  extracted: {
    reference: string | null;
    category: string | null;
    brand: string | null;
    model: string | null;
    storage: string | null;
    colour: string | null;
    condition: string | null;
    imei1: string | null;
    imei2: string | null;
    serial: string | null;
    cost: number | null;
    currency: string | null;
  };
  problems: EntryProblem[];
}

const digitsOnly = (s: string): string => s.replace(/[^0-9]/g, '');

/**
 * A cost as the file wrote it. Handles "12 500", "12,500.00" and "12.500,00",
 * and refuses anything else rather than reading a price nobody typed.
 */
export function parseCost(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[^\d.,-]/g, '').trim();
  if (!cleaned) return null;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalised: string;
  if (lastComma > lastDot) {
    // European: dots group, comma decides the decimals.
    normalised = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    normalised = cleaned.replace(/,/g, '');
  }
  const value = Number(normalised);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100) / 100;
}

export interface RawCell {
  text: string;
  formula?: boolean;
  rounded?: boolean;
}

export interface BuildInput {
  cells: RawCell[];
  columns: ColumnGuess[];
  source: SourceRef;
  /** A currency named by the cost heading, when the sheet has no currency column. */
  headingCurrency?: string | null;
}

function cellFor(input: BuildInput, field: FileField): RawCell | null {
  const col = input.columns.find((c) => c.field === field);
  if (!col) return null;
  return input.cells[col.index] ?? null;
}

const textOf = (cell: RawCell | null): string | null => {
  const value = cell?.text?.trim();
  return value ? value : null;
};

/** One row → one entry, with its problems already named. */
export function buildEntry(input: BuildInput, key: string): FileEntry {
  const problems: EntryProblem[] = [];
  const cell = (f: FileField) => cellFor(input, f);

  const imei1Cell = cell('imei1');
  const imei2Cell = cell('imei2');
  const costCell = cell('cost');

  const imei1Raw = textOf(imei1Cell);
  const imei2Raw = textOf(imei2Cell);
  const imei1 = imei1Raw ? digitsOnly(imei1Raw) : null;
  const imei2 = imei2Raw ? digitsOnly(imei2Raw) : null;
  const serial = textOf(cell('serial'));
  const model = textOf(cell('model'));
  const costText = textOf(costCell);
  const cost = parseCost(costText);

  if (!imei1 && !serial) problems.push('imei1_missing');
  if (imei1Cell?.rounded) problems.push('imei1_rounded');
  else if (imei1 && !isValidImei(imei1)) problems.push('imei1_invalid');

  if (imei2Cell?.rounded) problems.push('imei2_rounded');
  else if (imei2) {
    if (imei2 === imei1) problems.push('imei2_same_as_imei1');
    else if (!isValidImei(imei2)) problems.push('imei2_invalid');
  }

  if (!model) problems.push('model_missing');
  if (!costText) problems.push('cost_missing');
  else if (cost === null) problems.push('cost_invalid');

  if (imei1Cell?.formula || imei2Cell?.formula || costCell?.formula) problems.push('formula_value');

  return {
    key,
    source: input.source,
    extracted: {
      reference: textOf(cell('reference')),
      category: textOf(cell('category')),
      brand: textOf(cell('brand')),
      model,
      storage: textOf(cell('storage')),
      colour: textOf(cell('colour')),
      condition: textOf(cell('condition')),
      imei1,
      imei2: imei2 && imei2 !== imei1 ? imei2 : null,
      serial,
      cost,
      currency: textOf(cell('currency')) ?? input.headingCurrency ?? null,
    },
    problems,
  };
}

/**
 * Duplicates inside the file, across every selected sheet and page.
 *
 * Both columns are one namespace: an IMEI printed as a phone's second
 * identifier on one row and as another phone's first identifier on the next is
 * the same physical phone twice, and both rows are flagged.
 */
export function markDuplicatesInFile(entries: FileEntry[]): void {
  const seen = new Map<string, string>();
  for (const e of entries) {
    for (const id of [e.extracted.imei1, e.extracted.imei2]) {
      if (!id) continue;
      const first = seen.get(id);
      if (first === undefined) {
        seen.set(id, e.key);
        continue;
      }
      if (!e.problems.includes('duplicate_in_file')) e.problems.push('duplicate_in_file');
      const other = entries.find((x) => x.key === first);
      if (other && !other.problems.includes('duplicate_in_file')) other.problems.push('duplicate_in_file');
    }
  }
}

/** Every identifier a batch would create, for one uniqueness question to the database. */
export function identifiersOf(entries: FileEntry[]): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    if (e.extracted.imei1) out.add(e.extracted.imei1);
    if (e.extracted.imei2) out.add(e.extracted.imei2);
  }
  return [...out];
}

export type EntryState = 'ready' | 'needs_attention';

export function entryState(entry: FileEntry): EntryState {
  return entry.problems.length === 0 ? 'ready' : 'needs_attention';
}

/** What the review screen counts, and what the totals line adds up. */
export function summarise(entries: FileEntry[], excludedKeys: readonly string[] = []) {
  const excluded = new Set(excludedKeys);
  let ready = 0;
  let needsAttention = 0;
  let total = 0;
  for (const e of entries) {
    if (excluded.has(e.key)) continue;
    if (entryState(e) === 'ready') {
      ready += 1;
      total += e.extracted.cost ?? 0;
    } else needsAttention += 1;
  }
  return {
    phones: entries.length,
    ready,
    needsAttention,
    excluded: excluded.size,
    /** Only what would actually be received: problems are not priced. */
    selectedCost: Math.round(total * 100) / 100,
  };
}
