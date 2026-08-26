// ===========================================================================
// Apply pending migrations to STAGING, behind the same guards as every other
// staging command.
//
//   npx ts-node scripts/staging-apply-migrations.ts
//
// Refuses outside staging, refuses a database whose name is not unmistakably
// staging, takes a dump, and RESTORE-PROVES that dump into a disposable
// database before letting `prisma migrate deploy` touch anything. A dump that
// exists is not a backup; a dump that restores is.
//
// It runs the migration chain and then the catalogue gate, so a deployment that
// leaves the permission catalogue short fails loudly instead of starting.
// ===========================================================================

import { config as loadEnv } from 'dotenv';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// `override` is load-bearing: `@prisma/client` loads `.env` as an import side
// effect, before this line runs, and plain dotenv will not replace a variable
// that is already set. See `scripts/staging-verification-code.ts` for the full
// account of how that made a staging guard pass while the connection stayed on
// development.
loadEnv({ path: '.env.staging', override: true });

const FORBIDDEN = [/^phonestore$/i, /prod/i, /production/i, /^live$/i, /demo/i];
const REQUIRED_SHAPE = /^[a-z0-9_]*stag(e|ing)[a-z0-9_]*$/i;

function assertStagingOnly(): string {
  const appEnv = (process.env.APP_ENV ?? '').toLowerCase();
  if (appEnv !== 'staging') {
    throw new Error(`APP_ENV is "${appEnv || 'unset'}", not "staging". Refusing.`);
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Refusing to guess.');
  if (/\$\{?[A-Z_]+\}?/.test(url)) {
    throw new Error('DATABASE_URL contains an unresolved variable. Refusing.');
  }

  const name = new URL(url).pathname.replace(/^\//, '').trim();
  if (!name) throw new Error('DATABASE_URL names no database. Refusing.');
  if (/[*%?]/.test(name)) throw new Error('Wildcards are not a database name. Refusing.');
  for (const pattern of FORBIDDEN) {
    if (pattern.test(name)) {
      throw new Error(`"${name}" looks like production or the demo database. Refusing.`);
    }
  }
  if (!REQUIRED_SHAPE.test(name)) {
    throw new Error(`"${name}" does not identify itself as staging. Refusing.`);
  }
  return name;
}

/** `mysqldump` / `mysql` are not on PATH under WAMP. */
function mysqlTool(name: 'mysql' | 'mysqldump'): string {
  const configured = process.env.MYSQL_BIN_DIR?.trim();
  const candidates = [
    ...(configured ? [join(configured, `${name}.exe`), join(configured, name)] : []),
    `C:/wamp64/bin/mysql/mysql8.4.7/bin/${name}.exe`,
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return name;
}

function mysqlConfig(): string {
  const cnf = join(homedir(), '.my.cnf');
  if (!existsSync(cnf)) {
    throw new Error('No ~/.my.cnf, so no verified backup can be taken. Refusing.');
  }
  return cnf;
}

function backup(name: string): string {
  const cnf = mysqlConfig();
  const dir = join(homedir(), 'erp-backups');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const out = join(
    dir,
    `${name}-before-migrate-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`,
  );

  execFileSync(
    mysqlTool('mysqldump'),
    [
      `--defaults-extra-file=${cnf}`,
      '--single-transaction', '--routines', '--triggers', '--events',
      '--no-tablespaces', '--hex-blob', `--result-file=${out}`, name,
    ],
    { maxBuffer: 512 * 1024 * 1024 },
  );

  const size = statSync(out).size;
  if (size < 1024) throw new Error(`The dump is only ${size} bytes. Refusing to trust it.`);
  console.log(`  backup       : ${out}  (${(size / 1024 / 1024).toFixed(1)} MB)`);
  return out;
}

function restoreProve(sourceName: string, dumpPath: string): void {
  const cnf = mysqlConfig();
  const scratch = `${sourceName}_restoreproof_${Date.now().toString(36)}`;
  for (const pattern of FORBIDDEN) {
    if (pattern.test(scratch)) throw new Error(`Refusing to create "${scratch}".`);
  }
  if (!REQUIRED_SHAPE.test(scratch)) throw new Error(`Refusing to create "${scratch}".`);

  const sql = (statement: string) =>
    execFileSync(mysqlTool('mysql'), [`--defaults-extra-file=${cnf}`, '-e', statement], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });

  try {
    sql(`CREATE DATABASE \`${scratch}\``);
    execFileSync(
      mysqlTool('mysql'),
      [`--defaults-extra-file=${cnf}`, scratch, '-e', `SOURCE ${dumpPath.replace(/\\/g, '/')}`],
      { maxBuffer: 512 * 1024 * 1024 },
    );

    const tables = Number(
      sql(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${scratch}'`)
        .split('\n')[1]?.trim() ?? 0,
    );
    if (tables < 50) throw new Error(`Restored only ${tables} tables. Not trustworthy.`);

    const perms = Number(
      sql(`SELECT COUNT(*) FROM \`${scratch}\`.permissions`).split('\n')[1]?.trim() ?? 0,
    );
    console.log(`  restore-proof: OK — ${tables} tables, ${perms} permission rows`);
  } finally {
    try {
      sql(`DROP DATABASE IF EXISTS \`${scratch}\``);
      console.log('  restore-proof: disposable database dropped');
    } catch {
      console.warn(`  ! Could not drop ${scratch}. Drop it by hand.`);
    }
  }
}

async function main() {
  const database = assertStagingOnly();
  console.log(`\n  staging migration — ${database}\n`);

  const dump = backup(database);
  restoreProve(database, dump);
  console.log('');

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit', shell: true });
  console.log('');

  // The gate. A deployment that leaves the catalogue short must fail here
  // rather than start and be discovered by a shopkeeper.
  execFileSync('npx', ['ts-node', 'scripts/verify-permission-catalogue.ts'], {
    stdio: 'inherit', shell: true,
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
