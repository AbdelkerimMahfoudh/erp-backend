import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Who reads a correction, and who deliberately does not (0079, docs/51 §15 D18–D19).
 *
 * Two kinds of reader, and getting either wrong double-counts or hides money:
 *
 *   "What exists now" — a cancelled sale is owed by nobody, is no partner's trade,
 *   counts toward no goal and moves no stock velocity; a voided phone is in no stock,
 *   no arrival and no sale. These MUST see the correction.
 *
 *   "What happened on day X" — the corrected record's own day keeps it exactly as it
 *   was: its rollup and its report never filter a released line or a cancelled sale.
 *   The correction is a separate movement on its own day.
 *
 * Read from the source, like the reconciliation specs: these are structural properties.
 */

const SRC = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');
const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const rollup = code(read('analytics', 'rollup.service.ts'));
const queries = code(read('closing', 'closing-report.queries.ts'));
const closing = code(read('closing', 'closing.service.ts'));
const ranking = code(read('consignment', 'partner-ranking.service.ts'));
const goals = code(read('goals', 'goals.service.ts'));
const sales = code(read('sales', 'sales.service.ts'));
const collections = code(read('sales', 'sale-payments.service.ts'));
const returns = code(read('returns', 'returns.service.ts'));
const inventory = code(read('inventory', 'inventory.service.ts'));
const dashboard = code(read('analytics', 'dashboard.service.ts'));

describe('the corrected record\'s own day stays exactly as it was', () => {
  it('the rollup\'s revenue and the report\'s sales never filter a cancelled sale\'s lines', () => {
    const revenue = rollup.slice(rollup.indexOf('AS revenue,'), rollup.indexOf('const expRows'));
    expect(revenue).not.toMatch(/released_by_correction_id/);
    const salesFigures = queries.slice(queries.indexOf('export async function salesFigures'), queries.indexOf('export async function returnFigures'));
    expect(salesFigures).not.toMatch(/released_by_correction_id|financial_corrections/);
  });

  it('the cancellation, the reversal and the legs are keyed on the correction day', () => {
    expect(rollup).toMatch(/fc\.target_kind = 'sale'[\s\S]{0,80}fc\.correction_date = \$\{day\}/);
    expect(rollup).toMatch(/fc\.target_kind = 'expense'[\s\S]{0,80}fc\.correction_date = \$\{day\}/);
    expect(queries).toMatch(/fc\.target_kind = 'sale' AND fc\.status = 'approved' AND fc\.correction_date = \$\{date\}/);
    expect(closing).toMatch(/FROM financial_correction_legs l[\s\S]{0,200}fc\.correction_date BETWEEN \$\{fromDay\} AND \$\{toDay\}/);
  });

  it('collected for a day\'s sales counts only the corrections posted by the end of that day', () => {
    expect(queries).toMatch(/fc\.status = 'approved' AND fc\.correction_date <= \$\{date\}/);
  });

  it('an expense reversal reaches the drawer once — through its leg, never through the rollup\'s cash column', () => {
    expect(rollup).toMatch(/const expensesCash = round2\(toNum\(expRows\[0\]\.expenses_cash\)\)/);
    expect(rollup).toMatch(/const expenses = round2\(toNum\(expRows\[0\]\.expenses\) - expenseReversals\)/);
  });
});

describe('what exists now sees the correction', () => {
  it('a cancelled sale is no partner\'s trade', () => {
    expect(ranking).toMatch(/NOT EXISTS \(SELECT 1 FROM financial_corrections fc\s+WHERE fc\.target_sale_id = s\.id AND fc\.status = 'approved'\)/);
  });

  it('a cancelled sale comes off every goal on the day it was cancelled, and moves no stock velocity', () => {
    // Its own period keeps it, as its Daily closing does (docs/51 §16): no goal filters a released line.
    expect(goals).not.toMatch(/released_by_correction_id/);
    expect(goals).toMatch(/CANCELLED_ADJUSTMENT\[metric\]/);
    expect(goals).toMatch(/fc\.target_kind = 'sale' AND fc\.status = 'approved'\s+AND fc\.correction_date BETWEEN \$\{from\} AND \$\{to\}/);
    expect(rollup).toMatch(/AND si\.released_by_correction_id IS NULL\s+GROUP BY product_id/);
  });

  it('a cancelled sale takes no payment and no return', () => {
    expect(collections).toMatch(/where: \{ targetSaleId: saleId, status: 'approved' \}[\s\S]{0,200}code: 'sale_cancelled'/);
    expect(returns).toMatch(/if \(line\.releasedByCorrectionId\) \{\s*throw new ConflictException\(\{ code: 'sale_cancelled'/);
  });

  it('a cancelled sale says so, and nothing on it can be returned', () => {
    expect(sales).toMatch(/cancellation: approvedCancel/);
    expect(sales).toMatch(/const live = sale\.items\.filter\(\(i\) => !i\.voided && !i\.releasedByCorrectionId\)/);
    expect(sales).toMatch(/cancelled,\s+cancellationRequested:/);
  });

  it('a voided phone is in no stock list, no arrival, and no conflict for the receipt that corrects it', () => {
    expect(inventory).toMatch(/status: filter\.status \?\? \{ not: 'voided' as const \}/);
    expect(dashboard).toMatch(/status: \{ not: 'voided' \}/);
    expect(inventory).toMatch(/if \(ours\.length > 0 && ours\.every\(\(u\) => u\.status === 'voided'\)\) return NO_CONFLICT;/);
    expect(inventory).toMatch(/opts\.includeVoided === false \? \{ status: \{ not: 'voided' as const \} \} : \{\}/);
  });

  it('everything else still treats a voided phone\'s numbers as taken', () => {
    // The default keeps them: only receiving asks without them, and receiving reactivates.
    expect(inventory).toMatch(/async findExistingIdentifiers\(identifiers: string\[\], opts: \{ includeVoided\?: boolean \} = \{\}\)/);
    expect(code(read('purchasing', 'purchasing.service.ts'))).toMatch(/\{ includeVoided: false \}/);
  });
});

describe('a closed day reads back as it was closed', () => {
  it('the stored report records an unchecked balance as the close left it — not verified — so nothing reads as changed', () => {
    expect(closing).toMatch(/const asClosed = \(r: ClosingReport\): ClosingReport =>/);
    expect(closing).toMatch(/unverified\.includes\('cash:NONE'\) \? \{ \.\.\.r\.expected\.cash, verification: 'not_verified' \}/);
    expect(closing).toMatch(/const frozenReport: ClosingReport = asClosed\(/);
  });
});
