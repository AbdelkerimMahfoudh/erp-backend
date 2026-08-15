import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The `0039` migration's contract, and its permission grants (J1).
 *
 * Reads the real migration SQL, like `pricing-migration.spec.ts` and
 * `quantity-migration.spec.ts`: what a production `migrate deploy` applies is
 * the only thing that matters, and an edit that quietly widens who may confirm
 * a payment should fail the build.
 *
 * The behavioural proofs only a database can give — MySQL rejecting a cash
 * payment that names an account, a zero amount, a half-confirmed row, a
 * duplicate request id and a duplicate allocation — were exercised against real
 * MySQL during the J1 deployment proof and are recorded in `docs/28`. They are
 * deliberately NOT mocked here, because a mocked constraint only tests the mock.
 */

const SQL = readFileSync(
  join(__dirname, '..', '..', 'prisma', 'migrations', '0039_supplier_settlement', 'migration.sql'),
  'utf8',
);

/** Statements only — comments carry no guarantees. */
const statements = SQL.split('\n')
  .filter((l) => !l.trimStart().startsWith('--'))
  .join('\n');

describe('0039 creates the settlement tables', () => {
  it.each(['supplier_settlements', 'supplier_settlement_allocations'])('creates %s', (table) => {
    expect(statements).toContain(`CREATE TABLE \`${table}\``);
  });

  it('uses the project money precision, never a float or a string', () => {
    expect(statements).toMatch(/`amount`\s+DECIMAL\(14,2\)/);
    expect(statements).not.toMatch(/`amount`\s+(FLOAT|DOUBLE|VARCHAR)/);
  });

  it('uses BINARY(16) UUIDv7 keys like every other table', () => {
    expect(statements).toMatch(/`id`\s+BINARY\(16\)\s+NOT NULL/);
  });
});

describe('0039 makes the money rules database rules', () => {
  it('refuses a zero or negative payment', () => {
    expect(statements).toContain('`supplier_settlements_amount_positive_chk`');
    expect(statements).toMatch(/CHECK \(`amount` > 0\)/);
  });

  it('refuses a negative allocation', () => {
    expect(statements).toContain('`supplier_settlement_allocations_amount_positive_chk`');
  });

  it('ties the method to the account: an account payment names one, cash does not', () => {
    expect(statements).toContain('`supplier_settlements_method_account_chk`');
    expect(statements).toMatch(/`method` = 'account' AND `receiving_account_id` IS NOT NULL/);
    expect(statements).toMatch(/`method` = 'cash' AND `receiving_account_id` IS NULL/);
  });

  it('refuses a half-confirmed row — who, when and which day, or none of them', () => {
    expect(statements).toContain('`supplier_settlements_confirmed_shape_chk`');
    expect(statements).toMatch(
      /`status` = 'confirmed' AND `confirmed_at` IS NOT NULL AND `confirmation_date` IS NOT NULL/,
    );
  });

  it('keeps the receiving-account foreign key free of referential actions', () => {
    // MySQL 3823: a CHECK cannot sit on a column whose FK carries one. Losing
    // this line silently loses the method/account rule with it.
    expect(statements).toMatch(
      /`supplier_settlements_receiving_account_id_fkey`[\s\S]*?ON DELETE RESTRICT ON UPDATE RESTRICT/,
    );
  });
});

describe('0039 stops a payment being recorded twice', () => {
  it('makes the client request id unique per company', () => {
    expect(statements).toMatch(
      /UNIQUE KEY `supplier_settlements_company_id_client_uuid_key` \(`company_id`, `client_uuid`\)/,
    );
  });

  it('requires the request id and its fingerprint — neither is optional', () => {
    expect(statements).toMatch(/`client_uuid`\s+BINARY\(16\)\s+NOT NULL/);
    expect(statements).toMatch(/`client_request_hash`\s+CHAR\(64\)\s+NOT NULL/);
  });

  it('allows one allocation per purchase per settlement', () => {
    expect(statements).toMatch(
      /UNIQUE KEY `supplier_settlement_allocations_settlement_purchase_key` \(`settlement_id`, `purchase_id`\)/,
    );
  });
});

describe('0039 grants the two permissions to exactly the right roles', () => {
  /** The block of the migration that grants one permission. */
  const grantBlock = (key: string): string => {
    const start = statements.indexOf(`p.\`key\` = '${key}'`);
    expect(start).toBeGreaterThan(-1);
    return statements.slice(start, start + 400);
  };

  it('creates both permissions idempotently', () => {
    for (const key of ['supplier.payment.report', 'supplier.payment.confirm']) {
      expect(statements).toContain(`'${key}'`);
      expect(statements).toMatch(
        new RegExp(`WHERE NOT EXISTS \\(SELECT 1 FROM \`permissions\` WHERE \`key\` = '${key}'\\)`),
      );
    }
  });

  it('lets an Employee REPORT a payment — they are the one who handed it over', () => {
    expect(grantBlock('supplier.payment.report')).toMatch(
      /r\.`key` IN \('owner', 'store_manager', 'store_employee'\)/,
    );
  });

  it('never lets an Employee CONFIRM one', () => {
    const block = grantBlock('supplier.payment.confirm');
    expect(block).toMatch(/r\.`key` IN \('owner', 'store_manager'\)/);
    expect(block).not.toContain('store_employee');
  });

  it('uses the `label` column the permissions table actually has', () => {
    // `description` does not exist; the first deploy attempt failed on it.
    expect(statements).toMatch(/INSERT INTO `permissions` \(`id`, `key`, `label`\)/);
    expect(statements).not.toContain('`description`');
  });
});

describe('0039 is safe to deploy', () => {
  it('rewrites no existing row', () => {
    expect(statements).not.toMatch(/^\s*UPDATE\s/m);
    expect(statements).not.toMatch(/^\s*DELETE\s/m);
  });

  it('does not touch suppliers, purchases or supplier_payments', () => {
    expect(statements).not.toMatch(/ALTER TABLE `suppliers`/);
    expect(statements).not.toMatch(/ALTER TABLE `purchases`/);
    expect(statements).not.toMatch(/ALTER TABLE `supplier_payments`/);
  });

  it('adds the closing columns with a default, so old closings keep their figures', () => {
    expect(statements).toMatch(/ALTER TABLE `daily_closings`/);
    expect(statements).toMatch(/`supplier_paid_total`\s+DECIMAL\(14,2\) NOT NULL DEFAULT 0/);
    expect(statements).toMatch(/`supplier_paid_cash`\s+DECIMAL\(14,2\) NOT NULL DEFAULT 0/);
  });

  it('modifies no earlier migration', () => {
    expect(statements).not.toMatch(/003[0-8]_/);
  });

  it('documents the reverse SQL and names it destructive', () => {
    expect(SQL).toContain('Reverse SQL');
    expect(SQL).toContain('DROP TABLE `supplier_settlements`');
    expect(SQL).toMatch(/DESTROYS/);
  });

  it('records the legacy audit a production deployment must repeat', () => {
    expect(SQL).toMatch(/legacy audit/i);
    expect(SQL).toMatch(/supplier_payments = 0/);
  });
});
