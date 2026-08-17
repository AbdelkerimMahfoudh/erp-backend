/**
 * Working out what a shopkeeper's columns mean (Milestone G).
 *
 * The single most important thing this milestone does. A shop's stock list was
 * written by the shop, not by us: the header might say `imei`, `IMEI Number`,
 * `الرقم التسلسلي`, or `Serial`. Making somebody map twelve columns by hand
 * before they can import anything is exactly the "complicated system" the
 * rulebook forbids — and it is the step where people give up and go back to the
 * notebook.
 *
 * So the mapping is GUESSED and then SHOWN. The shop confirms or corrects it;
 * they never build it from nothing.
 */

/** The fields an import can fill. */
export type ImportField =
  | 'imei'
  | 'serialNo'
  | 'barcode'
  | 'brand'
  | 'model'
  | 'variant'
  | 'cost'
  | 'price'
  | 'quantity'
  | 'note';

/**
 * Header synonyms, English and Arabic.
 *
 * Compared after normalisation, so `IMEI Number`, `imei_number` and `IMEI-No`
 * all reduce to the same thing. Arabic entries are here because a shop keeping
 * its list in Arabic is the normal case, not an edge one.
 */
const SYNONYMS: Record<ImportField, string[]> = {
  imei: ['imei', 'imeino', 'imeinumber', 'imei1', 'meid', 'ايمي', 'الايمي', 'رقمالايمي'],
  serialNo: ['serial', 'serialno', 'serialnumber', 'sn', 'مسلسل', 'الرقمالتسلسلي', 'رقمتسلسلي'],
  barcode: ['barcode', 'ean', 'upc', 'code', 'باركود', 'الباركود'],
  brand: ['brand', 'make', 'manufacturer', 'ماركة', 'الماركة', 'العلامة'],
  model: ['model', 'modelname', 'device', 'product', 'productname', 'item', 'موديل', 'الموديل', 'المنتج', 'الجهاز'],
  variant: ['variant', 'storage', 'capacity', 'colour', 'color', 'spec', 'سعة', 'التخزين', 'اللون', 'المواصفات'],
  cost: ['cost', 'costprice', 'purchase', 'purchaseprice', 'buy', 'buyprice', 'التكلفة', 'سعرالشراء', 'الشراء'],
  price: ['price', 'sellprice', 'sellingprice', 'retail', 'retailprice', 'sale', 'saleprice', 'السعر', 'سعرالبيع', 'البيع'],
  quantity: ['qty', 'quantity', 'count', 'stock', 'pieces', 'الكمية', 'العدد', 'كمية'],
  note: ['note', 'notes', 'comment', 'remark', 'description', 'ملاحظة', 'ملاحظات', 'وصف'],
};

/**
 * Reduce a header to something comparable.
 *
 * Strips spaces, punctuation and case, and normalises Arabic-Indic digits and
 * the alef/ya/ta-marbuta variants that differ by keyboard — `الماركه` and
 * `الماركة` are the same word to everybody except a string comparison.
 */
export function normalizeHeader(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ً-ْ]/g, '')
    .replace(/[^a-z0-9؀-ۿ]/g, '');
}

/**
 * The synonyms, normalised once at load.
 *
 * Comparing a normalised header against a raw synonym list is the bug this
 * removes: `normalizeHeader` folds ة to ه and أ to ا, so a synonym written
 * `الماركة` could never match a header the same function had just turned into
 * `الماركه`. Every Arabic entry failed, silently, while the English ones passed
 * — which is exactly the kind of half-working that survives a casual test.
 */
const NORMALIZED_SYNONYMS = Object.fromEntries(
  Object.entries(SYNONYMS).map(([field, words]) => [field, words.map(normalizeHeader)]),
) as Record<ImportField, string[]>;

export interface HeaderGuess {
  /** Zero-based column index in the sheet. */
  index: number;
  header: string;
  field: ImportField | null;
}

/**
 * Guess what each column is.
 *
 * A field is claimed by the FIRST column that matches it. A sheet with both
 * `Price` and `Sale Price` should not have both mapped to the same field and
 * silently disagree — the second stays unmapped and is shown as such.
 */
export function guessMapping(headers: string[]): HeaderGuess[] {
  const taken = new Set<ImportField>();
  return headers.map((header, index) => {
    const key = normalizeHeader(header);
    let field: ImportField | null = null;
    if (key) {
      for (const [candidate, words] of Object.entries(NORMALIZED_SYNONYMS) as [ImportField, string[]][]) {
        if (taken.has(candidate)) continue;
        if (words.includes(key)) {
          field = candidate;
          taken.add(candidate);
          break;
        }
      }
    }
    return { index, header, field };
  });
}

/**
 * What kind of stock a sheet describes, decided by which identifier it carries.
 *
 * Not asked. The shop already answered it by what they typed: a column of
 * IMEIs is phones, a column of serials is televisions, and neither is a box of
 * chargers. Asking again would be asking somebody to restate something the file
 * already says.
 */
export type ImportKind = 'imei' | 'serial' | 'quantity';

export function kindOf(mapping: HeaderGuess[]): ImportKind | null {
  const fields = new Set(mapping.map((m) => m.field));
  if (fields.has('imei')) return 'imei';
  if (fields.has('serialNo')) return 'serial';
  if (fields.has('quantity') || fields.has('barcode')) return 'quantity';
  return null;
}

export interface MappingProblem {
  field: ImportField | 'identifier';
  message: string;
}

/**
 * What is missing before this sheet can be imported at all.
 *
 * Reported as a list, not one at a time. Making somebody fix a header, re-upload
 * and discover the next missing column is the slowest possible way to learn
 * what a file needs.
 */
export function missingRequirements(mapping: HeaderGuess[]): MappingProblem[] {
  const fields = new Set(mapping.map((m) => m.field).filter(Boolean) as ImportField[]);
  const problems: MappingProblem[] = [];

  if (!kindOf(mapping)) {
    problems.push({
      field: 'identifier',
      message: 'No IMEI, serial number, barcode or quantity column was found',
    });
  }
  if (!fields.has('model')) {
    // Without it there is nothing to call the product on a screen, and every
    // row would create something unnameable.
    problems.push({ field: 'model', message: 'No model or product name column was found' });
  }
  if (!fields.has('cost')) {
    /**
     * Cost is required, and this is a deliberate product decision rather than a
     * technical one. Stock imported without a cost silently reports infinite
     * margin on every sale, and the shop only discovers it when the profit
     * figures are already wrong.
     */
    problems.push({ field: 'cost', message: 'No cost column was found' });
  }
  return problems;
}
