import { existsSync, readFileSync } from 'node:fs';
import { REQUIRE_PERMISSIONS_KEY } from '../rbac/require-permissions.decorator';
import { ReceivingFilesController } from './receiving-files.controller';
import { ReceivingFilesService } from './receiving-files.service';
import { columnIndex, readWorkbook } from './xlsx-reader';
import { currencyInHeading, guessColumns, missingRequired, normaliseHeading, sheetScore } from './file-columns';
import {
  buildEntry,
  identifiersOf,
  markDuplicatesInFile,
  parseCost,
  summarise,
  type FileEntry,
} from './file-entries';
import { matchProduct, variantLabel } from './product-match';
import { rowsFromItems } from './pdf-reader';

/**
 * Receiving a delivery from a file.
 *
 * The rules under test are the ones that decide whether a shop ends up with the
 * stock it actually bought: one row is one phone, two IMEIs are one unit,
 * nothing is invented, identifiers keep every digit, and parsing alone never
 * writes anything.
 */

const cell = (text: string, extra: Record<string, boolean> = {}) => ({ text, ...extra });
const columnsOf = (headings: string[]) => guessColumns(headings);
const HEADINGS = ['Unit reference', 'Category', 'Brand', 'Model', 'Storage GB', 'Colour', 'Condition', 'IMEI 1', 'IMEI 2', 'Purchase cost MRU', 'Currency'];
const row = (...values: string[]) => values.map((v) => cell(v));
const entryFrom = (values: string[], key = 'r2'): FileEntry =>
  buildEntry(
    {
      cells: row(...values),
      columns: columnsOf(HEADINGS),
      source: { sheet: 'Phones', row: 2, page: null },
      headingCurrency: currencyInHeading('Purchase cost MRU'),
    },
    key,
  );

const PHONE = ['DEMO-001', 'Smartphone', 'Apple', 'iPhone 12', '128', 'Black', 'New', '990001000000018', '990001000010017', '12500', 'MRU'];

describe('column headings', () => {
  it('reads English, French and Arabic headings', () => {
    expect(columnsOf(['Brand', 'Model', 'IMEI 1', 'Purchase cost']).map((c) => c.field)).toEqual([
      'brand',
      'model',
      'imei1',
      'cost',
    ]);
    expect(columnsOf(['Marque', 'Modèle', 'IMEI 1', "Prix d'achat", 'Couleur']).map((c) => c.field)).toEqual([
      'brand',
      'model',
      'imei1',
      'cost',
      'colour',
    ]);
    expect(columnsOf(['الماركة', 'الموديل', 'الايمي 1', 'سعر الشراء', 'اللون']).map((c) => c.field)).toEqual([
      'brand',
      'model',
      'imei1',
      'cost',
      'colour',
    ]);
  });

  it('never maps both IMEI columns to the same field', () => {
    const mapped = columnsOf(['IMEI 1', 'IMEI 2']).map((c) => c.field);
    expect(mapped).toEqual(['imei1', 'imei2']);
  });

  it('ignores case, spacing and punctuation', () => {
    expect(normaliseHeading('IMEI_1')).toBe(normaliseHeading('imei 1'));
    expect(columnsOf(['imei-1']).map((c) => c.field)).toEqual(['imei1']);
  });

  it('reads the currency named in a cost heading', () => {
    expect(currencyInHeading('Purchase cost MRU')).toBe('MRU');
    expect(currencyInHeading('Purchase cost')).toBeNull();
  });

  it('says what a sheet is missing before it can be received', () => {
    expect(missingRequired(columnsOf(['Brand', 'Colour']))).toEqual(['model', 'imei1', 'cost']);
    expect(missingRequired(columnsOf(HEADINGS))).toEqual([]);
  });

  it('scores a data sheet above an explanatory one', () => {
    expect(sheetScore(HEADINGS, 100)).toBeGreaterThan(sheetScore(['RECEIVE STOCK', '100-phone demo workbook'], 18));
  });
});

describe('one row is one phone', () => {
  it('keeps both IMEIs on a single entry', () => {
    const e = entryFrom(PHONE);
    expect(e.extracted.imei1).toBe('990001000000018');
    expect(e.extracted.imei2).toBe('990001000010017');
    expect(e.problems).toEqual([]);
  });

  it('accepts a phone with only IMEI 1', () => {
    const e = entryFrom([...PHONE.slice(0, 8), '', ...PHONE.slice(9)]);
    expect(e.extracted.imei2).toBeNull();
    expect(e.problems).toEqual([]);
  });

  it('refuses an invalid or repeated second IMEI instead of dropping it', () => {
    expect(entryFrom([...PHONE.slice(0, 8), '990001000010010', ...PHONE.slice(9)]).problems).toContain('imei2_invalid');
    expect(entryFrom([...PHONE.slice(0, 8), PHONE[7], ...PHONE.slice(9)]).problems).toContain('imei2_same_as_imei1');
  });

  it('names a missing identifier, model or cost — and invents none of them', () => {
    const e = entryFrom(['REF', 'Smartphone', 'Apple', '', '', '', '', '', '', '', 'MRU']);
    expect(e.problems).toEqual(expect.arrayContaining(['imei1_missing', 'model_missing', 'cost_missing']));
    expect(e.extracted.storage).toBeNull();
    expect(e.extracted.colour).toBeNull();
    expect(e.extracted.cost).toBeNull();
  });

  it('treats identifiers as text, keeping every digit and any leading zero', () => {
    const e = entryFrom([...PHONE.slice(0, 7), '012345678901231', '', ...PHONE.slice(9)]);
    expect(e.extracted.imei1).toBe('012345678901231');
  });

  it('flags a rounded identifier rather than reconstructing it', () => {
    const rounded = buildEntry(
      {
        cells: [...row(...PHONE.slice(0, 7)), cell('9.9E+14', { rounded: true }), cell(''), cell('12500'), cell('MRU')],
        columns: columnsOf(HEADINGS),
        source: { sheet: 'Phones', row: 5, page: null },
      },
      'r5',
    );
    expect(rounded.problems).toContain('imei1_rounded');
    expect(rounded.problems).not.toContain('imei1_invalid');
  });

  it('flags a formula value instead of trusting a cached result silently', () => {
    const formula = buildEntry(
      {
        cells: [...row(...PHONE.slice(0, 9)), cell('12500', { formula: true }), cell('MRU')],
        columns: columnsOf(HEADINGS),
        source: { sheet: 'Phones', row: 6, page: null },
      },
      'r6',
    );
    expect(formula.problems).toContain('formula_value');
  });

  it('keeps the row it came from', () => {
    expect(entryFrom(PHONE).source).toEqual({ sheet: 'Phones', row: 2, page: null });
  });
});

describe('costs', () => {
  it('reads the separators people actually type', () => {
    expect(parseCost('12500')).toBe(12500);
    expect(parseCost('12 500')).toBe(12500);
    expect(parseCost('12,500.50')).toBe(12500.5);
    expect(parseCost('12.500,50')).toBe(12500.5);
  });

  it('refuses nonsense rather than inventing a price', () => {
    expect(parseCost('')).toBeNull();
    expect(parseCost('n/a')).toBeNull();
    expect(parseCost('0')).toBeNull();
    expect(parseCost('-5')).toBeNull();
  });
});

describe('duplicates', () => {
  it('flags a repeat inside the file, whichever IMEI column it appears in', () => {
    const a = entryFrom(PHONE, 'a');
    const b = entryFrom([...PHONE.slice(0, 7), '990001000010017', '', ...PHONE.slice(9)], 'b');
    markDuplicatesInFile([a, b]);
    expect(a.problems).toContain('duplicate_in_file');
    expect(b.problems).toContain('duplicate_in_file');
  });

  it('asks the database about both columns at once', () => {
    const a = entryFrom(PHONE, 'a');
    expect(identifiersOf([a]).sort()).toEqual(['990001000000018', '990001000010017']);
  });
});

describe('product matching', () => {
  const catalogue = [
    { id: 'p1', brand: 'Apple', model: 'iPhone 12', variant: '128 GB · Black', trackingType: 'imei' as const },
    { id: 'p2', brand: 'Apple', model: 'iPhone 12', variant: '256 GB · Black', trackingType: 'imei' as const },
  ];

  it('matches an exact brand, model and variant', () => {
    expect(matchProduct({ brand: 'Apple', model: 'iPhone 12', storage: '128', colour: 'Black' }, catalogue)).toEqual({
      kind: 'matched',
      productId: 'p1',
      exact: true,
    });
  });

  it('asks rather than choosing when the variant does not decide it', () => {
    const outcome = matchProduct({ brand: 'Apple', model: 'iPhone 12', storage: null, colour: null }, catalogue);
    expect(outcome.kind).toBe('ambiguous');
  });

  it('reports an unknown model instead of creating one', () => {
    expect(matchProduct({ brand: 'Apple', model: 'iPhone 99', storage: null, colour: null }, catalogue)).toEqual({
      kind: 'unknown',
    });
  });

  it('writes a variant the way the catalogue does', () => {
    expect(variantLabel('128', 'Black')).toBe('128 GB · Black');
    expect(variantLabel(null, null)).toBeNull();
  });
});

describe('counts', () => {
  it('counts phones, ready, needing attention and excluded, and prices only what is ready', () => {
    const ok = entryFrom(PHONE, 'a');
    const bad = entryFrom(['REF', '', '', '', '', '', '', '', '', '', ''], 'b');
    const also = entryFrom([...PHONE.slice(0, 7), '990001000000026', '', '9500', 'MRU'], 'c');
    expect(summarise([ok, bad, also], ['c'])).toEqual({
      phones: 3,
      ready: 1,
      needsAttention: 1,
      excluded: 1,
      selectedCost: 12500,
    });
  });
});

describe('PDF rows', () => {
  const item = (str: string, x: number, y: number, width = str.length * 5) => ({ str, x, y, width });

  it('groups items on one baseline into a row, left to right', () => {
    const rows = rowsFromItems([item('990001000000018', 200, 700), item('iPhone 12', 60, 700), item('12500', 400, 700)], 1);
    expect(rows[0].page).toBe(1);
    expect(rows[0].cells.map((c) => c.text)).toEqual(['iPhone 12', '990001000000018', '12500']);
    // Each cell keeps where it was printed: columns are decided by position.
    expect(rows[0].cells.map((c) => c.x)).toEqual([60, 200, 400]);
  });

  it('keeps a price on its own phone rather than the one above', () => {
    const rows = rowsFromItems(
      [item('990001000000018', 200, 700), item('12500', 400, 700), item('990001000000026', 200, 680), item('9500', 400, 680)],
      2,
    );
    expect(rows.map((r) => r.cells.map((c) => c.text))).toEqual([
      ['990001000000018', '12500'],
      ['990001000000026', '9500'],
    ]);
  });

  it('reports a page with no text instead of pretending it was read', () => {
    expect(rowsFromItems([], 3)).toEqual([]);
  });
});

describe('the endpoint', () => {
  it('needs the import and purchase permissions, and the UI cannot be the only guard', () => {
    expect(Reflect.getMetadata(REQUIRE_PERMISSIONS_KEY, ReceivingFilesController.prototype.parse)).toEqual([
      'import.run',
      'purchase.manage',
    ]);
  });

  it('writes nothing: the service touches no purchase, unit, payment or stock table', () => {
    const source = readFileSync(__dirname + '/receiving-files.service.ts', 'utf8');
    expect(source).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    expect(source).not.toMatch(/\$transaction/);
    // And it is not the opening-inventory import, whose cash semantics differ.
    expect(source).not.toMatch(/importBatch|imports\.service/);
  });

  it('is mounted under purchases, not under imports', () => {
    const controller = readFileSync(__dirname + '/receiving-files.controller.ts', 'utf8');
    expect(controller).toMatch(/path: 'purchases\/file'/);
  });
});

describe('columnIndex', () => {
  it('reads spreadsheet column letters', () => {
    expect(columnIndex('A1')).toBe(0);
    expect(columnIndex('K101')).toBe(10);
    expect(columnIndex('AB7')).toBe(27);
  });
});

/**
 * The real workbook, when it is present.
 *
 * It lives outside the repository (a fixture of a hundred phones is not
 * repository content), so these are skipped rather than failed when it is not
 * there — and they are the ones that prove the 100-phone claim.
 */
const DEMO = 'C:/Users/HP/Downloads/demo-receiving-100-phones.xlsx';
const withDemo = existsSync(DEMO) ? describe : describe.skip;

withDemo('the 100-phone demo workbook', () => {
  it('reads both sheets, and the Phones sheet holds exactly 100 phones', async () => {
    const sheets = await readWorkbook(readFileSync(DEMO));
    expect(sheets.map((s) => s.name)).toEqual(['Phones', 'Read me']);
    const phones = sheets[0];
    expect(phones.rows.length).toBe(101);
    expect(sheetScore(phones.rows[0].map((c) => c.text), 100)).toBeGreaterThan(
      sheetScore(sheets[1].rows[0].map((c) => c.text), 18),
    );
  });

  it('keeps all 150 identifiers, 50 phones with a second IMEI and 50 without', async () => {
    const sheets = await readWorkbook(readFileSync(DEMO));
    const phones = sheets[0];
    const columns = guessColumns(phones.rows[0].map((c) => c.text));
    const entries = phones.rows
      .slice(1)
      .map((cells, i) =>
        buildEntry({ cells, columns, source: { sheet: 'Phones', row: phones.rowNumbers[i + 1], page: null } }, `r${i}`),
      );
    expect(entries).toHaveLength(100);
    expect(entries.filter((e) => e.extracted.imei2).length).toBe(50);
    expect(entries.filter((e) => !e.extracted.imei2).length).toBe(50);
    expect(identifiersOf(entries)).toHaveLength(150);
    for (const e of entries) expect(e.extracted.imei1).toMatch(/^\d{15}$/);
  });

  it('finds no problem in any row, and totals the cost the workbook states', async () => {
    const sheets = await readWorkbook(readFileSync(DEMO));
    const phones = sheets[0];
    const columns = guessColumns(phones.rows[0].map((c) => c.text));
    const entries = phones.rows
      .slice(1)
      .map((cells, i) =>
        buildEntry(
          {
            cells,
            columns,
            source: { sheet: 'Phones', row: phones.rowNumbers[i + 1], page: null },
            headingCurrency: 'MRU',
          },
          `r${i}`,
        ),
      );
    markDuplicatesInFile(entries);
    // Product matching is the only thing that can still need attention, and it
    // needs a catalogue — so here the file itself must be clean.
    expect(entries.filter((e) => e.problems.length > 0)).toEqual([]);
    expect(summarise(entries).selectedCost).toBe(1_242_000);
  });
});

/**
 * The endpoint has to be in the build that is actually running.
 *
 * The first real-device attempt failed with "That file could not be read"
 * because the API process serving the shop was older than the feature and
 * answered 404 — the module existed in Git and in no running process. These
 * checks cannot start a server, but they do keep the route wired into the app
 * and its parsers declared, so a build that omits either fails here first.
 */
describe('the parse endpoint stays wired into the application', () => {
  it('AppModule imports the receiving-files module', () => {
    const app = readFileSync(__dirname + '/../app.module.ts', 'utf8');
    expect(app).toContain('ReceivingFilesModule');
    expect(app).toMatch(/imports:\s*\[[\s\S]*ReceivingFilesModule/);
  });

  it('the module declares the controller that owns the route', () => {
    const module = readFileSync(__dirname + '/receiving-files.module.ts', 'utf8');
    expect(module).toContain('ReceivingFilesController');
    expect(module).toContain('ReceivingFilesService');
  });

  it('the route is still POST purchases/file/parse on version 1', () => {
    const controller = readFileSync(__dirname + '/receiving-files.controller.ts', 'utf8');
    expect(controller).toContain("path: 'purchases/file'");
    expect(controller).toContain("version: '1'");
    expect(controller).toContain("@Post('parse')");
  });

  it('both parsers are declared as dependencies, not merely installed', () => {
    const pkg = JSON.parse(readFileSync(__dirname + '/../../package.json', 'utf8'));
    expect(pkg.dependencies['pdfjs-dist']).toBeTruthy();
    expect(pkg.dependencies['jszip']).toBeTruthy();
  });
});
