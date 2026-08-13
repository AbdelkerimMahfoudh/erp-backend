import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The `0034` migration's contract (H1.4-CP2).
 *
 * Reads the real migration SQL, in the same spirit as `pricing-migration.spec.ts`
 * and `role-matrix-drift.spec.ts`: what a production `migrate deploy` applies is
 * the only thing that matters, and a later edit that quietly drops the line-kind
 * CHECK or the duplicate-line index should fail the build.
 *
 * The behavioural proofs only a database can give — MySQL rejecting a line that
 * is both kinds, rejecting a duplicate accessory line, rejecting a cost snapshot
 * on a serialized line, and refusing to delete a unit a transfer still names —
 * were exercised against real MySQL during the CP2 deployment proof and are
 * recorded in `docs/25` §13. They are deliberately NOT mocked here, because a
 * mocked constraint only tests the mock.
 */

const SQL = readFileSync(
  join(__dirname, '..', '..', 'prisma', 'migrations', '0034_quantity_transfer_lines', 'migration.sql'),
  'utf8',
);

/** Statements only — comments carry no guarantees. */
const statements = SQL.split('\n')
  .filter((l) => !l.trimStart().startsWith('--'))
  .join('\n');

describe('0034 makes a transfer line exactly one kind', () => {
  it('adds the CHECK that refuses "both" and "neither"', () => {
    expect(statements).toContain('`transfer_items_line_kind_chk`');
    // Serialized: a unit, no product, exactly one of it.
    expect(statements).toMatch(
      /`unit_id` IS NOT NULL AND `product_id` IS NULL\s+AND `quantity` = 1/,
    );
    // Quantity: a product, no unit, at least one of it.
    expect(statements).toMatch(
      /`unit_id` IS NULL\s+AND `product_id` IS NOT NULL AND `quantity` >= 1/,
    );
  });

  it('leaves the existing positive-quantity CHECK alone', () => {
    expect(statements).not.toContain('DROP CHECK `transfer_items_quantity_pos_chk`');
  });

  it('stops duplicate quantity lines in the DATABASE, not just the service', () => {
    expect(statements).toContain('CREATE UNIQUE INDEX `transfer_items_transfer_id_product_id_key`');
    expect(statements).toMatch(/ON `transfer_items`\(`transfer_id`, `product_id`\)/);
  });
});

describe('0034 adds the shipment cost snapshot', () => {
  it('is nullable, because it does not exist until the goods leave', () => {
    expect(statements).toMatch(/ADD COLUMN `shipped_unit_cost` DECIMAL\(14,2\) NULL/);
  });

  it('uses the project money precision, never a float or a string', () => {
    expect(statements).not.toMatch(/`shipped_unit_cost` (FLOAT|DOUBLE|VARCHAR)/);
  });

  it('confines the snapshot to quantity lines and forbids a negative', () => {
    expect(statements).toContain('`transfer_items_snapshot_kind_chk`');
    expect(statements).toMatch(/`product_id` IS NOT NULL AND `shipped_unit_cost` >= 0/);
  });
});

describe('0034 stops a parent row being erased behind the CHECK', () => {
  it.each(['unit_id', 'product_id'])('rebuilds the %s foreign key as RESTRICT', (column) => {
    const fk = `transfer_items_${column.replace('_id', '')}_id_fkey`;
    expect(statements).toContain(`DROP FOREIGN KEY \`${fk}\``);
    expect(statements).toMatch(
      new RegExp(`ADD CONSTRAINT \`${fk}\`[\\s\\S]*?ON DELETE RESTRICT ON UPDATE RESTRICT`),
    );
  });

  it('leaves no SET NULL behind on transfer_items', () => {
    expect(statements).not.toMatch(/transfer_items[\s\S]*ON DELETE SET NULL/);
  });
});

describe('0034 makes an unpriced quantity row representable', () => {
  it('relaxes stock_items.price to NULL rather than inventing a value', () => {
    expect(statements).toMatch(/ALTER TABLE `stock_items`\s*\n?\s*MODIFY `price` DECIMAL\(14,2\) NULL/);
  });

  it('backfills nothing — no price is written or defaulted', () => {
    expect(statements).not.toMatch(/UPDATE `stock_items`/);
    expect(statements).not.toMatch(/INSERT INTO `stock_items`/);
    expect(statements).not.toMatch(/DEFAULT 0/);
  });

  it('does not touch cost, which is still always known', () => {
    expect(statements).not.toMatch(/MODIFY `cost`/);
  });
});

describe('0034 is safe to deploy', () => {
  it('rewrites no existing row', () => {
    expect(statements).not.toMatch(/^\s*(UPDATE|DELETE|INSERT)\s/m);
  });

  it('modifies no earlier migration', () => {
    expect(statements).not.toMatch(/003[0-3]_/);
  });

  it('documents the reverse SQL, including the destructive parts', () => {
    expect(SQL).toContain('Reverse SQL');
    expect(SQL).toContain('DROP CHECK `transfer_items_line_kind_chk`');
    expect(SQL).toContain('DROP COLUMN `shipped_unit_cost`');
    expect(SQL).toMatch(/DESTRUCTIVE/);
  });

  it('records the legacy audit a production deployment must repeat', () => {
    expect(SQL).toMatch(/legacy audit/i);
    expect(SQL).toMatch(/transfer_items = 0/);
  });
});
