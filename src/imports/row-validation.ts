import type { ImportField, ImportKind } from './column-mapping';

/**
 * Deciding what happens to each row (Milestone G).
 *
 * The rule that shapes everything here: **a bad row fails alone.** A shop
 * importing 200 phones with three mistyped IMEIs should get 197 phones and a
 * list of three things to fix — not a rejected file and no idea which line was
 * wrong. All-or-nothing sounds safer and is, in practice, the behaviour that
 * sends somebody back to the notebook.
 *
 * What makes that safe rather than sloppy is that nothing is written until the
 * shop has seen the count. The preview says "197 will be added, 3 cannot" and
 * they decide.
 */

export type RowStatus = 'valid' | 'warning' | 'error';

export interface ParsedRow {
  imei?: string;
  serialNo?: string;
  barcode?: string;
  brand?: string;
  model?: string;
  variant?: string;
  cost?: number;
  price?: number;
  quantity?: number;
  note?: string;
}

export interface RowVerdict {
  status: RowStatus;
  /** Plain sentences, in order. A row can be wrong in more than one way. */
  messages: string[];
  parsed: ParsedRow;
}

/** Luhn, the same check `lib/imei.ts` applies on the phone. */
export function luhnValid(digits: string): boolean {
  if (!/^\d{15}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = Number(digits[14 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * Read a number the way a spreadsheet writes one.
 *
 * Handles the separators that appear in real files: `1 200`, `1,200`, `1.200,50`
 * and Arabic-Indic digits. Returns `null` when it is not a number at all, which
 * is different from zero — a cost of nothing and a cost nobody typed are not
 * the same fact.
 */
export function parseNumber(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;

  let s = raw
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    // Currency symbols and spaces used as thousands separators.
    .replace(/[\s '٬]/g, '')
    .replace(/[^\d.,-]/g, '');
  if (s === '') return null;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    // Whichever comes last is the decimal separator: `1.200,50` vs `1,200.50`.
    const decimal = lastComma > lastDot ? ',' : '.';
    const thousands = decimal === ',' ? '.' : ',';
    s = s.split(thousands).join('').replace(decimal, '.');
  } else if (lastComma !== -1) {
    /**
     * One comma only. `1,50` is a decimal; `1,200` is a thousands separator.
     * Decided by how many digits follow it — the only signal available, and the
     * one a person reading it would use.
     */
    s = s.length - lastComma - 1 === 3 ? s.split(',').join('') : s.replace(',', '.');
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export interface ValidateInput {
  /** Cell values keyed by the field their column was mapped to. */
  cells: Partial<Record<ImportField, string>>;
  kind: ImportKind;
  /** Identifiers already seen EARLIER in this same file. */
  seenInFile: Set<string>;
  /** Identifiers that already exist in the shop. */
  existsInShop: Set<string>;
}

/**
 * Decide one row.
 *
 * `error` means it will not be imported. `warning` means it will, but something
 * is worth a look. The distinction matters: a warning that blocks an import is
 * just an error with a friendlier colour, and it teaches people to ignore both.
 */
export function validateRow(input: ValidateInput): RowVerdict {
  const { cells, kind, seenInFile, existsInShop } = input;
  const messages: string[] = [];
  let status: RowStatus = 'valid';
  const fail = (m: string) => {
    messages.push(m);
    status = 'error';
  };
  const warn = (m: string) => {
    messages.push(m);
    if (status !== 'error') status = 'warning';
  };

  const parsed: ParsedRow = {};
  const text = (f: ImportField) => cells[f]?.trim() || undefined;

  parsed.brand = text('brand');
  parsed.model = text('model');
  parsed.variant = text('variant');
  parsed.note = text('note');

  if (!parsed.model) fail('No model or product name');

  // ── The identifier ────────────────────────────────────────────────────────
  let identifier: string | undefined;

  if (kind === 'imei') {
    const raw = (text('imei') ?? '').replace(/[\s-]/g, '');
    identifier = raw;
    if (!raw) fail('No IMEI');
    else if (!/^\d+$/.test(raw)) fail('The IMEI has characters that are not digits');
    else if (raw.length !== 15) fail(`An IMEI is 15 digits; this one has ${raw.length}`);
    else if (!luhnValid(raw)) {
      /**
       * A failed check digit is an ERROR, not a warning. An IMEI that does not
       * check out is a typo, and importing it creates a phone that can never be
       * found by scanning the real one — the single worst outcome of an import,
       * because it looks like it worked.
       */
      fail('That IMEI fails its check digit — it is probably mistyped');
    }
    if (raw) parsed.imei = raw;
  } else if (kind === 'serial') {
    const raw = text('serialNo');
    identifier = raw;
    if (!raw) fail('No serial number');
    else parsed.serialNo = raw;
  } else {
    const raw = text('barcode');
    if (raw) {
      identifier = raw;
      parsed.barcode = raw;
    }
    const qty = parseNumber(cells.quantity ?? null);
    if (qty == null) fail('No quantity');
    else if (!Number.isInteger(qty) || qty <= 0) fail('The quantity must be a whole number above zero');
    else parsed.quantity = qty;
  }

  if (identifier) {
    /**
     * Duplicates are checked against the file as well as the shop. A sheet that
     * lists the same phone twice would otherwise import it once and fail once,
     * which reads as a mysterious error rather than as "you typed it twice".
     */
    if (seenInFile.has(identifier)) fail('This appears earlier in the same file');
    else if (existsInShop.has(identifier)) fail('This is already in stock');
  }

  // ── Money ─────────────────────────────────────────────────────────────────
  const cost = parseNumber(cells.cost ?? null);
  if (cost == null) fail('No cost');
  else if (cost < 0) fail('The cost cannot be negative');
  else {
    parsed.cost = cost;
    if (cost === 0) {
      /**
       * A warning rather than an error. Free stock is real — a supplier
       * replacement, a promotional unit — but a whole column of zeros is much
       * more likely to be an empty column, and the shop should look before
       * every margin becomes 100%.
       */
      warn('The cost is zero — check this is really free stock');
    }
  }

  const price = parseNumber(cells.price ?? null);
  if (price != null) {
    if (price < 0) fail('The price cannot be negative');
    else {
      parsed.price = price;
      if (cost != null && cost > 0 && price > 0 && price < cost) {
        // Not refused: clearance below cost is a real decision. But it must not
        // pass silently, because it is also what a swapped column looks like.
        warn('The selling price is below the cost');
      }
    }
  }

  return { status, messages, parsed };
}

/** Batch counts, so a preview can lead with the sentence that matters. */
export function summarise(verdicts: RowVerdict[]) {
  return {
    total: verdicts.length,
    valid: verdicts.filter((v) => v.status === 'valid').length,
    warning: verdicts.filter((v) => v.status === 'warning').length,
    error: verdicts.filter((v) => v.status === 'error').length,
    /** Valid AND warning rows both import — that is what a warning means. */
    willImport: verdicts.filter((v) => v.status !== 'error').length,
  };
}
