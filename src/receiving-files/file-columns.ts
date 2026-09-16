/**
 * Which column is which, in English, French and Arabic.
 *
 * Separate from `imports/column-mapping.ts` on purpose: opening inventory takes
 * one identifier and a quantity, while receiving a delivery needs the two IMEI
 * columns apart, the variant split into storage and colour, and a currency. The
 * older mapping keeps working for opening inventory, unchanged.
 *
 * A heading is matched on its letters alone — case, spaces, punctuation, Arabic
 * diacritics and the French accents all removed — because "IMEI 1", "imei_1"
 * and "IMEI-1" are the same column to everyone except a computer.
 */

export type FileField =
  | 'reference'
  | 'category'
  | 'brand'
  | 'model'
  | 'storage'
  | 'colour'
  | 'condition'
  | 'imei1'
  | 'imei2'
  | 'serial'
  | 'cost'
  | 'currency';

export const FILE_FIELDS: readonly FileField[] = [
  'reference',
  'category',
  'brand',
  'model',
  'storage',
  'colour',
  'condition',
  'imei1',
  'imei2',
  'serial',
  'cost',
  'currency',
];

/** Fields a row cannot be received without. */
export const REQUIRED_FIELDS: readonly FileField[] = ['model', 'imei1', 'cost'];

const SYNONYMS: Record<FileField, string[]> = {
  reference: ['unitreference', 'reference', 'ref', 'line', 'no', 'number', 'مرجع', 'المرجع', 'رقمالسطر', 'reference', 'numero', 'ligne'],
  category: ['category', 'type', 'kind', 'categorie', 'famille', 'فئة', 'الفئة', 'النوع', 'التصنيف'],
  brand: ['brand', 'make', 'manufacturer', 'marque', 'fabricant', 'ماركة', 'الماركة', 'العلامة', 'العلامةالتجارية'],
  model: ['model', 'modelname', 'device', 'product', 'productname', 'item', 'modele', 'appareil', 'produit', 'article', 'موديل', 'الموديل', 'المنتج', 'الجهاز', 'الصنف'],
  storage: ['storage', 'storagegb', 'capacity', 'memory', 'gb', 'stockage', 'capacite', 'memoire', 'سعة', 'السعة', 'التخزين', 'الذاكرة'],
  colour: ['colour', 'color', 'couleur', 'لون', 'اللون'],
  condition: ['condition', 'grade', 'state', 'quality', 'etat', 'qualite', 'حالة', 'الحالة'],
  imei1: ['imei', 'imei1', 'imeione', 'primaryimei', 'imeiprincipal', 'imeia', 'ايمي', 'الايمي', 'ايمي1', 'الايمي1', 'رقمالايمي'],
  imei2: ['imei2', 'imeitwo', 'secondimei', 'secondaryimei', 'imeisecondaire', 'imeib', 'ايمي2', 'الايمي2', 'الايميالثاني'],
  serial: ['serial', 'serialno', 'serialnumber', 'sn', 'numeroserie', 'serie', 'مسلسل', 'الرقمالتسلسلي', 'رقمتسلسلي'],
  cost: ['cost', 'costprice', 'purchase', 'purchasecost', 'purchaseprice', 'buy', 'buyprice', 'unitcost', 'prix', 'prixdachat', 'cout', 'coutunitaire', 'achat', 'التكلفة', 'تكلفة', 'سعرالشراء', 'الشراء', 'ثمنالشراء'],
  currency: ['currency', 'devise', 'monnaie', 'عملة', 'العملة'],
};

/** Letters and digits only, accents and Arabic marks stripped. */
export function normaliseHeading(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]/g, '');
}

/** Which currency-unit cost a heading itself names, e.g. "Purchase cost MRU". */
export function currencyInHeading(raw: string): string | null {
  const m = /\b(MRU|USD|EUR|MAD|AED|SAR)\b/i.exec(raw);
  return m ? m[1].toUpperCase() : null;
}

export interface ColumnGuess {
  index: number;
  heading: string;
  field: FileField | null;
}

/**
 * Guess each column's field. The FIRST column to claim a field keeps it, so a
 * sheet with "IMEI 1" and "IMEI 2" never maps both to the same field — and
 * `imei2` is tested before `imei1`, because "IMEI 2" contains "IMEI".
 */
export function guessColumns(headings: string[]): ColumnGuess[] {
  const taken = new Set<FileField>();
  const order: FileField[] = ['imei2', 'imei1', 'serial', 'storage', 'colour', 'condition', 'category', 'brand', 'model', 'cost', 'currency', 'reference'];
  return headings.map((heading, index) => {
    const key = normaliseHeading(heading);
    if (!key) return { index, heading, field: null };
    for (const field of order) {
      if (taken.has(field)) continue;
      if (SYNONYMS[field].some((s) => key === normaliseHeading(s))) {
        taken.add(field);
        return { index, heading, field };
      }
    }
    // A heading that starts with a synonym ("Purchase cost MRU", "IMEI 1 (text)").
    for (const field of order) {
      if (taken.has(field)) continue;
      if (SYNONYMS[field].some((s) => key.startsWith(normaliseHeading(s)) && normaliseHeading(s).length >= 3)) {
        taken.add(field);
        return { index, heading, field };
      }
    }
    return { index, heading, field: null };
  });
}

/** Which mapped fields are missing before a sheet can be received at all. */
export function missingRequired(columns: ColumnGuess[]): FileField[] {
  const present = new Set(columns.map((c) => c.field).filter((f): f is FileField => f !== null));
  return REQUIRED_FIELDS.filter((f) => !present.has(f));
}

/**
 * How likely a sheet is the data, rather than instructions.
 *
 * A "Read me" sheet is prose in one or two columns; a data sheet has a heading
 * row that maps to identifier and money columns and many rows under it. Scored
 * rather than name-matched, so a data sheet called "Read me" is still read and
 * an instruction sheet called "Phones" is still not mistaken for stock.
 */
export function sheetScore(headings: string[], dataRowCount: number): number {
  const mapped = guessColumns(headings).filter((c) => c.field !== null);
  const hasIdentifier = mapped.some((c) => c.field === 'imei1' || c.field === 'serial');
  return (hasIdentifier ? 10 : 0) + mapped.length + Math.min(dataRowCount, 20) / 10;
}
