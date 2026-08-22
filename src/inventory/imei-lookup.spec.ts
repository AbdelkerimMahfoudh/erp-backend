import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Either IMEI must find the same phone (milestone O).
 *
 * A dual-SIM handset is ONE unit carrying TWO identifiers. Both are printed on
 * the same box and both get scanned, so a lookup that reads only
 * `imei_primary` reports "Unit not found" for a phone sitting on the shelf —
 * and the person holding it has no way to tell the difference between that and
 * a phone the shop never had.
 *
 * This is a source-level guard rather than a database test because the mistake
 * is a shape: an `OR` that names two columns instead of three. It is the kind
 * of thing that gets reintroduced by copy-paste in a new query, which is
 * exactly what a drift test is for.
 *
 * Migration `0042` guarantees an identifier belongs to only one unit across
 * both columns, so widening these lookups cannot make one identifier match two
 * phones.
 */
describe('IMEI lookup spans both identifier columns', () => {
  const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

  /** Every `OR:` block in a file, with comments stripped so prose is not code. */
  function orBlocks(source: string): string[] {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const blocks: string[] = [];
    const re = /OR:\s*\[/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      let depth = 1;
      let i = re.lastIndex;
      while (i < code.length && depth > 0) {
        if (code[i] === '[') depth++;
        else if (code[i] === ']') depth--;
        i++;
      }
      blocks.push(code.slice(m.index, i));
    }
    return blocks;
  }

  const CASES: { file: string[]; what: string }[] = [
    { file: ['inventory', 'inventory.service.ts'], what: 'looking a unit up by identifier' },
    { file: ['sales', 'sales.service.ts'], what: 'resolving a sale line' },
    { file: ['pricing', 'pricing.service.ts'], what: 'pricing one exact item' },
    { file: ['imports', 'imports.service.ts'], what: 'detecting an already-claimed identifier' },
  ];

  for (const { file, what } of CASES) {
    it(`${what} searches imeiSecondary too`, () => {
      const blocks = orBlocks(read(...file)).filter((b) => b.includes('imeiPrimary'));
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(block).toContain('imeiSecondary');
      }
    });
  }

  it('the import duplicate set reads back the column it searched', () => {
    // Selecting a row BY its second IMEI and then not selecting that column
    // finds the duplicate and forgets it again — a half-fix that still lets the
    // row through to a trigger rejection at insert time.
    const source = read('imports', 'imports.service.ts');
    const select = source.match(/select: \{[^}]*imeiPrimary[^}]*\}/);
    expect(select).not.toBeNull();
    expect(select![0]).toContain('imeiSecondary');
  });

  it('migration 0042 is still present, since these lookups now depend on it', () => {
    const sql = readFileSync(
      join(__dirname, '..', '..', 'prisma', 'migrations', '0042_identifier_cross_uniqueness', 'migration.sql'),
      'utf8',
    );
    // Without cross-column uniqueness, widening the OR would let one scanned
    // identifier match two different phones.
    expect(sql).toContain('units_identifier_unique_insert');
    expect(sql).toContain('units_identifier_unique_update');
  });
});
