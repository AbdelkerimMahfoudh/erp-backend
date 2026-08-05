import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sanitizeDump, defaultOutputFor } = require('../../scripts/sanitize-dump');

/**
 * The dump sanitiser is a recovery tool, so it is tested like one.
 *
 * A rollback happens on the worst day the shop has. The thing that must not
 * happen then is a "restore" that appears to succeed and silently corrupts
 * every BINARY(16) key, or that drops the append-only audit triggers. Both are
 * possible with a careless text substitution, so both are asserted here.
 */

const SCRIPT = join(__dirname, '..', '..', 'scripts', 'sanitize-dump.js');
const TRAILER = '-- Dump completed on 2026-08-05 10:00:00';

/** The exact shape `mysqldump --triggers` emits, CRLF and all. */
const TRIGGER_DUMP = [
  'DELIMITER ;;',
  '/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `audit_logs_block_update` BEFORE UPDATE ON `audit_logs` FOR EACH ROW BEGIN',
  "  IF USER() LIKE 'phonestore\\_app@%' THEN",
  "    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only for the application user';",
  '  END IF;',
  'END */;;',
  'DELIMITER ;',
  TRAILER,
  '',
].join('\r\n');

function run(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout?: string; stderr?: string };
    return { code: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('sanitizeDump', () => {
  it('strips the trigger definer while keeping the trigger itself', () => {
    const { sql, stripped } = sanitizeDump(TRIGGER_DUMP);

    expect(stripped).toBe(1);
    expect(sql).not.toContain('DEFINER=');
    // The protection must survive — a dump that loses the trigger loses the
    // append-only audit guarantee without saying so.
    expect(sql).toContain('TRIGGER `audit_logs_block_update` BEFORE UPDATE ON `audit_logs`');
    expect(sql).toContain("SIGNAL SQLSTATE '45000'");
  });

  it('strips the bare definer form used by views and routines', () => {
    const view =
      'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v` AS SELECT 1;';

    const { sql, stripped } = sanitizeDump(`${view}\n${TRAILER}\n`);

    expect(stripped).toBe(1);
    expect(sql).toContain('CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v`');
  });

  it('leaves row data alone even when it contains the word DEFINER', () => {
    // A product name is not DDL. Rewriting it would corrupt real business data.
    const data = "INSERT INTO `products` VALUES ('DEFINER=`root`@`localhost` cable');";

    const { sql, stripped } = sanitizeDump(`${data}\n${TRAILER}\n`);

    expect(stripped).toBe(0);
    expect(sql).toContain(data);
  });

  it('preserves raw binary bytes exactly — the reason this is not a sed one-liner', () => {
    // BINARY(16) UUIDs are dumped as raw bytes inside _binary '...'. 0x81 is not
    // valid UTF-8; a utf8 read/write round trip replaces it with U+FFFD and
    // every primary key in the database quietly changes.
    const key = Buffer.from([0x01, 0x8f, 0x81, 0xfe, 0x00, 0x70]).toString('latin1');
    const row = `INSERT INTO \`companies\` VALUES (_binary '${key}','Demo');`;
    const input = `${TRIGGER_DUMP}${row}\r\n`;

    const { sql } = sanitizeDump(input);

    expect(Buffer.from(sql, 'latin1').includes(Buffer.from([0x8f, 0x81, 0xfe]))).toBe(true);
    expect(sql).toContain(row);
  });

  it('changes nothing but the definer clauses', () => {
    const { sql } = sanitizeDump(TRIGGER_DUMP);

    // Same line count, same line endings — a restore replays identically.
    expect(sql.split('\n')).toHaveLength(TRIGGER_DUMP.split('\n').length);
    expect(sql).toContain('\r\n');
    expect(sql).toContain(TRAILER);
  });

  it('is idempotent — sanitising an already-sanitised dump is a no-op', () => {
    const once = sanitizeDump(TRIGGER_DUMP).sql;
    const twice = sanitizeDump(once);

    expect(twice.stripped).toBe(0);
    expect(twice.sql).toBe(once);
  });
});

describe('sanitize-dump CLI', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'erp-dump-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeDump(name = 'phonestore.sql'): string {
    const p = join(dir, name);
    writeFileSync(p, Buffer.from(TRIGGER_DUMP, 'latin1'));
    return p;
  }

  it('writes a separate file and never touches the verified dump', () => {
    const input = writeDump();
    const before = readFileSync(input);

    const { code } = run([input]);

    expect(code).toBe(0);
    expect(readFileSync(input).equals(before)).toBe(true);
    const output = defaultOutputFor(input);
    expect(existsSync(output)).toBe(true);
    expect(readFileSync(output, 'latin1')).not.toContain('DEFINER=');
  });

  it('refuses to write over the input', () => {
    const input = writeDump();

    const { code, out } = run([input, input]);

    expect(code).toBe(1);
    expect(out).toContain('refusing to write over the input');
  });

  it('refuses to overwrite an existing output', () => {
    const input = writeDump();
    const output = join(dir, 'out.sql');
    writeFileSync(output, 'precious');

    const { code, out } = run([input, output]);

    expect(code).toBe(1);
    expect(out).toContain('refusing to overwrite');
    expect(readFileSync(output, 'utf8')).toBe('precious');
  });

  it('refuses a truncated dump instead of sanitising a useless file', () => {
    const input = join(dir, 'partial.sql');
    writeFileSync(input, TRIGGER_DUMP.replace(TRAILER, ''));

    const { code, out } = run([input]);

    expect(code).toBe(1);
    expect(out).toContain('truncated');
    expect(existsSync(defaultOutputFor(input))).toBe(false);
  });
});
