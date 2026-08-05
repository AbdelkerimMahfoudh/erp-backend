#!/usr/bin/env node
'use strict';

/**
 * Remove `DEFINER=` clauses from a mysqldump file, into a SEPARATE new file.
 *
 * WHY THIS EXISTS
 * ---------------
 * `mysqldump --triggers` writes each trigger as
 *
 *     /*!50003 CREATE* / /*!50017 DEFINER=`root`@`localhost`* / /*!50003 TRIGGER ...
 *
 * Recreating an object owned by *another* account requires `SET_USER_ID` (or
 * `SUPER`). The migrator deliberately has neither — it holds `ALL PRIVILEGES`
 * on two schemas and nothing global — so restoring a dump that names
 * `root@localhost` as definer fails with ERROR 1227. Stripping the clause makes
 * the restoring account the definer, which is exactly what a rollback wants.
 *
 * WHY IT IS A SCRIPT AND NOT A `sed` ONE-LINER
 * --------------------------------------------
 * A dump of this database is *not valid UTF-8*. BINARY(16) UUID keys are
 * emitted as `_binary '<raw bytes>'`, so any tool that decodes the file as text
 * and re-encodes it — `sed` under some locales, PowerShell `-replace`,
 * `Get-Content`/`Set-Content`, Node's default utf8 read — silently replaces
 * every invalid byte sequence with U+FFFD and corrupts every primary key. The
 * damage is invisible until the restore finishes and rows do not join.
 *
 * This script reads and writes `latin1`, which is a byte-for-byte round trip,
 * and only rewrites lines that are DDL. Data lines are copied untouched.
 *
 * USAGE
 *   node scripts/sanitize-dump.js <dump.sql> [output.sql]
 *
 * The input is opened read-only and never written to. The output must not
 * already exist.
 */

const fs = require('node:fs');
const path = require('node:path');

/** `DEFINER=`user`@`host`` — backticked identifiers may contain doubled backticks. */
const IDENT = '`(?:[^`]|``)*`';
/** A version-gated comment whose entire content is a definer clause. */
const WRAPPED = new RegExp(`/\\*!\\d+ DEFINER=${IDENT}@${IDENT}\\s*\\*/\\s?`, 'g');
/** A bare definer clause, e.g. `CREATE DEFINER=...  PROCEDURE` or inside /*!50013 ... * /. */
const BARE = new RegExp(`DEFINER=${IDENT}@${IDENT}\\s?`, 'g');

/** mysqldump's final line. Its absence means the dump is truncated. */
const TRAILER = '-- Dump completed';

/**
 * Lines that carry row data. `DEFINER=` inside a string literal is just a
 * customer's product name, and rewriting it would corrupt the data.
 */
const DATA_LINE = /^(?:INSERT INTO|REPLACE INTO)\b/;

/**
 * @param {string} sql dump contents decoded as latin1
 * @returns {{ sql: string, stripped: number, linesChanged: number }}
 */
function sanitizeDump(sql) {
  let stripped = 0;
  let linesChanged = 0;

  // Split on \n only, so \r stays attached and CRLF files round-trip exactly.
  const out = sql.split('\n').map((line) => {
    if (DATA_LINE.test(line) || !line.includes('DEFINER=')) return line;

    const next = line.replace(WRAPPED, () => (stripped++, '')).replace(BARE, () => (stripped++, ''));
    if (next !== line) linesChanged++;
    return next;
  });

  return { sql: out.join('\n'), stripped, linesChanged };
}

function defaultOutputFor(input) {
  const dir = path.dirname(input);
  const base = path.basename(input, path.extname(input));
  return path.join(dir, `${base}.no-definer${path.extname(input) || '.sql'}`);
}

function main(argv) {
  const [input, requested] = argv;
  if (!input) {
    console.error('usage: node scripts/sanitize-dump.js <dump.sql> [output.sql]');
    return 2;
  }

  const output = requested || defaultOutputFor(input);

  if (path.resolve(input) === path.resolve(output)) {
    console.error('refusing to write over the input — the verified dump must stay untouched');
    return 1;
  }
  if (!fs.existsSync(input)) {
    console.error(`no such dump: ${input}`);
    return 1;
  }
  if (fs.existsSync(output)) {
    console.error(`refusing to overwrite an existing file: ${output}`);
    return 1;
  }

  const raw = fs.readFileSync(input);
  const text = raw.toString('latin1');

  if (!text.includes(TRAILER)) {
    console.error(`this dump has no "${TRAILER}" trailer — it is truncated, not a backup`);
    return 1;
  }

  const result = sanitizeDump(text);
  fs.writeFileSync(output, Buffer.from(result.sql, 'latin1'));

  const after = fs.statSync(output).size;
  console.log(`input      ${input} (${raw.length} bytes)`);
  console.log(`output     ${output} (${after} bytes)`);
  console.log(`definers   ${result.stripped} stripped on ${result.linesChanged} line(s)`);
  console.log(`trailer    present`);
  return 0;
}

module.exports = { sanitizeDump, defaultOutputFor, TRAILER };

if (require.main === module) process.exit(main(process.argv.slice(2)));
