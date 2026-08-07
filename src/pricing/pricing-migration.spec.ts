import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The pricing migration's contract (G2A-CP2).
 *
 * These read the real migration SQL, in the same spirit as
 * `role-matrix-drift.spec.ts`: what a production `migrate deploy` actually
 * applies is the only thing that matters, and a later edit that quietly drops a
 * uniqueness rule or starts backfilling prices should fail the build.
 *
 * The behavioural proofs that only a database can give — the append-only
 * triggers firing for the application account, the CHECK constraints rejecting a
 * negative price, uniqueness and foreign keys — were exercised against real
 * MySQL during the CP2 deployment proof and are recorded in the handoff. They
 * are deliberately NOT re-mocked here, because a mock would only be testing
 * itself.
 */

const SQL = readFileSync(
  join(__dirname, '..', '..', 'prisma', 'migrations', '0027_pricing_foundation', 'migration.sql'),
  'utf8',
);

/** Statements only — comments carry no guarantees. */
const statements = SQL.split('\n')
  .filter((l) => !l.trimStart().startsWith('--'))
  .join('\n');

describe('0027 creates the pricing tables', () => {
  it.each(['branch_variant_prices', 'unit_price_overrides', 'price_change_events'])(
    'creates %s',
    (table) => {
      expect(statements).toContain(`CREATE TABLE \`${table}\``);
    },
  );

  it('uses the project money precision everywhere, never a formatted string', () => {
    const money = statements.match(/`(price|previous_price|new_price)` DECIMAL\(14, 2\)/g) ?? [];
    expect(money.length).toBe(4); // price ×2, previous_price, new_price
    expect(statements).not.toMatch(/`price` VARCHAR/);
  });

  it('uses BINARY(16) UUIDv7 keys like every other table', () => {
    expect(statements).toContain('`id` BINARY(16) NOT NULL');
  });
});

describe('identity and concurrency invariants', () => {
  it('allows exactly one current price per exact variant per branch', () => {
    expect(statements).toMatch(
      /UNIQUE INDEX `branch_variant_prices_product_id_branch_id_key`\(`product_id`, `branch_id`\)/,
    );
  });

  it('allows at most one authoritative override per unit', () => {
    expect(statements).toMatch(/UNIQUE INDEX `unit_price_overrides_unit_id_key`\(`unit_id`\)/);
  });

  it('gives both current-price tables a version for compare-and-swap', () => {
    const versions = statements.match(/`version` INTEGER NOT NULL DEFAULT 0/g) ?? [];
    expect(versions.length).toBe(2);
  });
});

describe('a unit override is BRANCH-BOUND', () => {
  it('stores the branch whose authority set it', () => {
    // Without this an override set in Branch A would follow the phone into
    // Branch B and take effect under authority nobody granted there.
    const block = statements.slice(
      statements.indexOf('CREATE TABLE `unit_price_overrides`'),
      statements.indexOf(');', statements.indexOf('CREATE TABLE `unit_price_overrides`')),
    );
    expect(block).toContain('`branch_id` BINARY(16) NOT NULL');
    expect(block).toContain('`unit_id` BINARY(16) NOT NULL');
  });

  it('keeps identity on the Unit — no IMEI or serial text is copied in', () => {
    const block = statements.slice(
      statements.indexOf('CREATE TABLE `unit_price_overrides`'),
      statements.indexOf(');', statements.indexOf('CREATE TABLE `unit_price_overrides`')),
    );
    expect(block).not.toMatch(/imei|serial|identifier/i);
  });

  it('references a real Unit, so quantity stock cannot acquire an override', () => {
    expect(statements).toMatch(
      /ALTER TABLE `unit_price_overrides` ADD CONSTRAINT `unit_price_overrides_unit_id_fkey` FOREIGN KEY \(`unit_id`\) REFERENCES `units`\(`id`\)/,
    );
  });
});

describe('price history is immutable', () => {
  it('blocks UPDATE and DELETE with database triggers, not service convention', () => {
    expect(statements).toContain('CREATE TRIGGER `price_change_events_block_update`');
    expect(statements).toContain('CREATE TRIGGER `price_change_events_block_delete`');
    // Conditional on the application account, exactly like audit_logs, so a DBA
    // can still archive by range.
    expect(statements).toMatch(/USER\(\) LIKE 'phonestore\\_app@%'/);
  });

  it('allows a removal to be recorded rather than erased', () => {
    // Nullable old/new prices are what let "created", "changed" and "removed"
    // all be one append-only shape.
    expect(statements).toMatch(/`previous_price` DECIMAL\(14, 2\) NULL/);
    expect(statements).toMatch(/`new_price` DECIMAL\(14, 2\) NULL/);
  });

  it('records who and under what authority, including a system initiator', () => {
    const block = statements.slice(statements.indexOf('CREATE TABLE `price_change_events`'));
    expect(block).toContain('`scope` VARCHAR(20) NOT NULL');
    expect(block).toContain('`initiator` VARCHAR(20) NOT NULL');
    expect(block).toContain('`actor_id` BINARY(16) NULL');
    expect(block).toContain('`reason` TEXT NULL');
  });
});

describe('0028 puts the audit_logs guard in the migration chain', () => {
  // Found in CP3: a clean database built from every migration had ZERO
  // audit_logs triggers, because the guard lived in a manual init script. A
  // fresh production deployment would have shipped a mutable audit log. Nothing
  // fails when a guard is merely absent, so only this test notices.
  const AUDIT = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '0028_audit_append_only_triggers',
      'migration.sql',
    ),
    'utf8',
  );

  it('creates both audit_logs guards', () => {
    expect(AUDIT).toContain('CREATE TRIGGER `audit_logs_block_update` BEFORE UPDATE ON `audit_logs`');
    expect(AUDIT).toContain('CREATE TRIGGER `audit_logs_block_delete` BEFORE DELETE ON `audit_logs`');
  });

  it('guards against the application account, not the definer', () => {
    const guards = AUDIT.match(/USER\(\) LIKE 'phonestore\\_app@%'/g) ?? [];
    expect(guards.length).toBe(2);
  });

  it('is idempotent, so it is safe where the init script already ran', () => {
    expect(AUDIT).toContain('DROP TRIGGER IF EXISTS `audit_logs_block_update`');
    expect(AUDIT).toContain('DROP TRIGGER IF EXISTS `audit_logs_block_delete`');
  });

  it('touches nothing but the triggers', () => {
    expect(AUDIT).not.toMatch(/CREATE TABLE|ALTER TABLE|INSERT\s+INTO|DELETE\s+FROM/i);
  });
});

describe('monetary sanity', () => {
  it('rejects negative prices at the database, on every money column', () => {
    for (const c of ['chk_bvp_price_nonneg', 'chk_upo_price_nonneg', 'chk_pce_prev_nonneg', 'chk_pce_new_nonneg']) {
      expect(statements).toContain(c);
    }
  });
});

describe('what the migration must NOT do', () => {
  it('never touches products.default_price — it stays the company fallback', () => {
    expect(statements).not.toMatch(/ALTER TABLE `products`/);
    expect(statements).not.toMatch(/default_price/);
  });

  it('never touches stock_items — quantity stock keeps its own branch price', () => {
    expect(statements).not.toMatch(/ALTER TABLE `stock_items`/);
    expect(statements).not.toMatch(/`stock_items`/);
  });

  it('never touches completed sales', () => {
    expect(statements).not.toMatch(/`sale_items`|`sales`/);
  });

  it('backfills nothing — an absent row must mean "fall back"', () => {
    // A single INSERT here would invent prices nobody set and destroy the
    // fallback for every branch.
    expect(statements).not.toMatch(/INSERT\s+INTO/i);
  });

  it('is additive: it drops nothing', () => {
    expect(statements).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
  });
});
