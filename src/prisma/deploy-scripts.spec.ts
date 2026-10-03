import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The deployment scripts a migration night depends on (the 2026-10-03 rehearsal).
 *
 * Both were found wrong by running them on a disposable copy, not by reading
 * them: `deploy/mysql-identities.sql` stopped at its first password (MySQL
 * takes only a literal after IDENTIFIED BY) after creating the migrator with
 * the password `placeholder`; `deploy/restore-drill.sh` reported PASSED on a
 * copy in which a product named ``DEFINER=`x`@`y` cable`` had lost its name.
 * The end-to-end proof is the rehearsal record in docs/22; these pin the fixes.
 */

const ROOT = join(__dirname, '..', '..');
const identities = readFileSync(join(ROOT, 'deploy', 'mysql-identities.sql'), 'utf8');
const drill = readFileSync(join(ROOT, 'deploy', 'restore-drill.sh'), 'utf8');
/** The statements, without the header's comment lines. */
const statements = identities
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('deploy/mysql-identities.sql', () => {
  it('never puts a variable after IDENTIFIED BY, which MySQL refuses as a syntax error', () => {
    expect(statements).not.toMatch(/IDENTIFIED BY\s+@/);
  });

  it('never creates an account with a placeholder password, not even for a moment', () => {
    expect(statements).not.toMatch(/placeholder/i);
  });

  it('builds every password statement with QUOTE() and runs it prepared', () => {
    const accountStatements = statements.match(/(CREATE|ALTER) USER[^;]*/g) ?? [];
    expect(accountStatements).toHaveLength(8);
    for (const s of accountStatements) expect(s).toMatch(/IDENTIFIED BY ', QUOTE\(@(migrator|app|backup|admin)_pw\)\)/);
  });

  it('refuses to touch any account until all four passwords are present', () => {
    const guard = statements.indexOf('PREPARE identities_guard FROM @identities_ready');
    const firstAccount = statements.search(/(CREATE|ALTER) USER/);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstAccount);
    for (const v of ['@migrator_pw', '@app_pw', '@backup_pw', '@admin_pw']) {
      expect(statements.slice(0, guard)).toContain(`CHAR_LENGTH(IFNULL(${v}, '')) >= 16`);
    }
  });

  it('documents passwords arriving on standard input, never on the command line', () => {
    expect(identities).not.toMatch(/mysql -u root -p\s*\\\s*\n--\s*-e "SET @migrator_pw/);
    expect(identities).toMatch(/\| mysql --defaults-extra-file=/);
  });
});

describe('deploy/restore-drill.sh', () => {
  /** The sed program the drill pipes the decrypted dump through. */
  const program = /sed -E '([^']+)'/.exec(drill)?.[1];

  function strip(lines: string[]): string[] {
    const run = spawnSync('sed', ['-E', program as string], { input: lines.join('\n'), encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
    if (run.error) throw run.error;
    return run.stdout.split('\n');
  }

  it('strips a trigger DEFINER and leaves the trigger itself', () => {
    expect(program).toBeDefined();
    const [out] = strip([
      '/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `audit_logs_chain` BEFORE INSERT ON `audit_logs` FOR EACH ROW',
    ]);
    expect(out).not.toContain('DEFINER=');
    expect(out).toContain('TRIGGER `audit_logs_chain` BEFORE INSERT ON `audit_logs`');
  });

  it('never rewrites a row: DEFINER=`x`@`y` in a product name survives the restore', () => {
    const row = "INSERT INTO `products` VALUES (0x01A0FF06923A77748635AEC6AA878BA0,'Bankily','DEFINER=`x`@`y` cable a');";
    const replace = "REPLACE INTO `products` VALUES (0x01,'DEFINER=`x`@`y`');";
    expect(strip([row, replace])).toEqual([row, replace]);
  });

  it('creates the copy with the source database’s character set and collation, not fixed ones', () => {
    expect(drill).toContain("SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='$SOURCE_DB'");
    expect(drill).toContain('CHARACTER SET $SRC_CHARSET COLLATE $SRC_COLLATION');
    expect(drill).not.toMatch(/CREATE DATABASE[^\n]*utf8mb4_0900_ai_ci/);
  });

  it('restores with --comments, so trigger bodies come back byte-identical, and compares them', () => {
    expect(drill).toMatch(/mysql --comments "\$\{CONN\[@\]\}"/);
    expect(drill).toContain('cmp "trigger bodies"');
  });

  it('compares every table’s content, not only row counts', () => {
    expect(drill).toContain('CHECKSUM TABLE');
    expect(drill).toContain("PASS every table's CHECKSUM matches");
  });

  it('passes the append-only probe only when the trigger refused it, never for want of a grant', () => {
    expect(drill).toMatch(/elif grep -q "append-only" <<<"\$out"; then\s*\n\s*echo "PASS append-only trigger restored/);
    expect(drill).toMatch(/elif grep -q "ERROR 1142" <<<"\$out"; then\s*\n\s*echo "SKIP append-only probe/);
  });
});
