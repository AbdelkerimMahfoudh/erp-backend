import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Buying a phone from whoever walked in with it.
 *
 * The everyday case in this shop has no trading partner: a handset is bought
 * over the counter and paid for on the spot. This pins the rules that make that
 * safe, and — more importantly — the ones that stop it becoming a hole in the
 * payables ledger.
 *
 * Source-level, like `sale-receiving-account.spec.ts`, because what matters is
 * WHICH guard exists and what it refuses. A fixture that happens to succeed
 * proves nothing about the case nobody remembered to write.
 */
const SERVICE = readFileSync(join(__dirname, 'purchasing.service.ts'), 'utf8');
const DTO = readFileSync(join(__dirname, 'dto', 'create-purchase.dto.ts'), 'utf8');
const SCHEMA = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
const MIGRATION = readFileSync(
  join(__dirname, '..', '..', 'prisma', 'migrations', '0070_optional_supplier_on_purchase', 'migration.sql'),
  'utf8',
);

const modelOf = (name: string): string => {
  const start = SCHEMA.indexOf(`model ${name} {`);
  const end = SCHEMA.indexOf('\n}', start);
  expect(start).toBeGreaterThanOrEqual(0);
  return SCHEMA.slice(start, end);
};

describe('a purchase with no supplier', () => {
  it('is expressible: the column and its relation are optional', () => {
    const purchase = modelOf('Purchase');
    expect(purchase).toMatch(/supplierId\s+Bytes\?/);
    expect(purchase).toMatch(/supplier\s+Supplier\?/);
  });

  it('keeps its payment record, so the money that moved is not lost', () => {
    // The purchase would otherwise read as paid with nothing recording payment.
    const payment = modelOf('SupplierPayment');
    expect(payment).toMatch(/supplierId\s+Bytes\?/);
    expect(payment).toMatch(/supplier\s+Supplier\?/);
    expect(SERVICE).toContain('supplierId: supplier?.id ?? null, purchaseId: pid');
  });

  it('is optional in the DTO rather than merely tolerated by the service', () => {
    const block = DTO.slice(DTO.indexOf('supplierId?'), DTO.indexOf('supplierId?') + 40);
    expect(block).toContain('supplierId?');
    expect(DTO).toMatch(/@IsOptional\(\)\s*\n\s*@IsUUID\(\)\s*\n\s*supplierId\?/);
  });

  it('REFUSES an outstanding balance with nobody named, and says why', () => {
    /*
     * The rule the whole change rests on. A debt owed to nobody is a figure no
     * report can chase and no settlement can clear.
     */
    expect(SERVICE).toContain('supplier_required_for_balance');
    expect(SERVICE).toContain('if (!supplier && round2(amountPaid) !== round2(total))');
    expect(SERVICE).toContain('An unpaid balance has to be owed to somebody');
  });

  it('never treats an absent supplier as evidence that payment happened', () => {
    // `paidAmount` must be stated. Defaulting it to the total would invent a
    // payment nobody made.
    const validation = SERVICE.slice(
      SERVICE.indexOf('const amountPaid = dto.paidAmount ?? 0;'),
      SERVICE.indexOf('const status = amountPaid'),
    );
    expect(validation).not.toMatch(/paidAmount\s*=\s*total/);
    expect(validation).not.toMatch(/\?\?\s*total/);
  });

  it('never invents an "unknown supplier" to satisfy the column', () => {
    /*
     * Checked against CODE, with comments stripped.
     *
     * The first version of this test searched the whole file for the words
     * "unknown supplier" and failed on the service's own comment explaining why
     * such a row would be wrong. A test that fails on its subject agreeing with
     * it teaches the next person to weaken the assertion rather than trust it.
     */
    const code = SERVICE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/supplier\.(create|upsert)\(/);
    expect(code.toLowerCase()).not.toContain('unknown supplier');
    // The reasoning still has to be written down where the next person looks.
    expect(SERVICE).toContain('fictional counterparty');
  });

  it('leaves a named supplier\'s balance and settlements exactly as they were', () => {
    // The balance is only ever touched when there IS a supplier, and the guard
    // is explicit rather than relying on the validation above holding forever.
    expect(SERVICE).toContain('if (payable !== 0 && supplier)');
    expect(SERVICE).toContain('balance: { increment: payable }');
  });

  it('resolves a named supplier and still refuses one that does not exist', () => {
    expect(SERVICE).toContain("if (dto.supplierId && !supplier) throw new NotFoundException('Supplier not found')");
  });

  it('hashes a missing supplier stably, so a replay is still recognised', () => {
    // `JSON.stringify` drops undefined properties, which would make a walk-in
    // purchase hash a different shape from its own retry.
    expect(SERVICE).toContain('supplierId: dto.supplierId ?? null');
  });

  it('agrees with the payables ledger about rounding', () => {
    // A purchase the service calls settled and the ledger calls a penny short
    // would be an unpayable debt nobody could clear.
    expect(SERVICE).toContain("import { round2 } from '../suppliers/payable'");
  });
});

describe('migration 0070', () => {
  it('widens both columns to NULL and nothing else', () => {
    expect(MIGRATION).toContain('ALTER TABLE `purchases`');
    expect(MIGRATION).toContain('MODIFY COLUMN `supplier_id` BINARY(16) NULL');
    expect(MIGRATION).toContain('ALTER TABLE `supplier_payments`');
  });

  it('drops nothing, backfills nothing and keeps the foreign keys', () => {
    /*
     * A NULL-able FK is still enforced for every non-NULL value, so a named
     * supplier is still guaranteed to exist. Dropping the constraint would have
     * traded one problem for a worse one.
     */
    expect(MIGRATION).not.toMatch(/DROP\s+(TABLE|COLUMN|FOREIGN KEY|CONSTRAINT)/i);
    expect(MIGRATION).not.toMatch(/\bUPDATE\b|\bINSERT\b|\bDELETE\b/i);
  });
});
