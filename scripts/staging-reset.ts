// ===========================================================================
// Reset the STAGING database.
//
//   npx ts-node scripts/staging-reset.ts --confirm <database-name>
//
// This is the most dangerous script in the repository, so it is the most
// suspicious one. It refuses unless **every** guard passes, and each guard
// exists because of a specific way this goes wrong:
//
//   - an unresolved `${VAR}` that expanded to nothing;
//   - an empty or whitespace name, which some clients read as "the current one";
//   - a wildcard;
//   - a name that looks like production or the shared demo database;
//   - a name that does not announce itself as staging;
//   - a name typed at the prompt that does not match the configured target.
//
// The last one matters most: it is the difference between "I meant to wipe
// staging" and "I was in the wrong terminal".
// ===========================================================================

import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

loadEnv({ path: '.env.staging' });

/** Names this script will never touch, however they are spelled. */
const FORBIDDEN = [/^phonestore$/i, /prod/i, /production/i, /^live$/i, /demo/i];

/** A staging database must say so in its own name. */
const REQUIRED_SHAPE = /^[a-z0-9_]*stag(e|ing)[a-z0-9_]*$/i;

function databaseNameFrom(url: string | undefined): string {
  if (!url) throw new Error('DATABASE_URL is not set. Refusing to guess.');
  // An unexpanded ${VAR} means the environment did not resolve — never proceed.
  if (/\$\{?[A-Z_]+\}?/.test(url)) {
    throw new Error('DATABASE_URL contains an unresolved variable. Refusing.');
  }
  const name = new URL(url).pathname.replace(/^\//, '').trim();
  if (!name) throw new Error('DATABASE_URL names no database. Refusing.');
  return name;
}

function assertSafe(name: string): void {
  if (!name.trim()) throw new Error('Empty database name. Refusing.');
  if (/[*%?]/.test(name)) throw new Error('Wildcards are not a database name. Refusing.');

  for (const pattern of FORBIDDEN) {
    if (pattern.test(name)) {
      throw new Error(`"${name}" looks like production or the demo database. Refusing.`);
    }
  }
  if (!REQUIRED_SHAPE.test(name)) {
    throw new Error(
      `"${name}" does not identify itself as staging. Name it e.g. phonestore_staging. Refusing.`,
    );
  }
}

/** A dump before the wipe. A reset you cannot undo is not a reset, it is a loss. */
function backup(name: string): string | null {
  const dir = join(homedir(), 'erp-backups');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const out = join(dir, `${name}-before-reset-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`);

  const cnf = join(homedir(), '.my.cnf');
  if (!existsSync(cnf)) {
    console.warn('  ! No ~/.my.cnf — skipping the pre-reset dump.');
    return null;
  }

  try {
    const dump = execFileSync(
      'mysqldump',
      [
        `--defaults-extra-file=${cnf}`,
        '--single-transaction',
        '--routines',
        '--triggers',
        '--events',
        '--no-tablespaces',
        '--hex-blob',
        name,
      ],
      { maxBuffer: 512 * 1024 * 1024 },
    );
    require('node:fs').writeFileSync(out, dump);
    return out;
  } catch {
    console.warn('  ! Could not take a pre-reset dump. Continuing only because this is staging.');
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const confirmIdx = args.indexOf('--confirm');
  if (confirmIdx === -1 || !args[confirmIdx + 1]) {
    throw new Error(
      'Usage: npx ts-node scripts/staging-reset.ts --confirm <database-name>\n' +
        'The name must match the configured staging database exactly.',
    );
  }

  const typed = args[confirmIdx + 1].trim();
  const configured = databaseNameFrom(process.env.DATABASE_URL);

  assertSafe(configured);
  assertSafe(typed);

  if (typed !== configured) {
    throw new Error(
      `You typed "${typed}" but .env.staging points at "${configured}". Refusing.`,
    );
  }

  if ((process.env.APP_ENV ?? '').toLowerCase() !== 'staging') {
    throw new Error('APP_ENV is not "staging". Refusing.');
  }

  console.log(`Resetting ${configured} …`);
  const dump = backup(configured);
  if (dump) console.log(`  backup: ${dump}`);

  const prisma = new PrismaClient();
  try {
    // Drop and recreate rather than truncate: a truncate leaves the schema at
    // whatever the last migration made it, which is the thing being tested.
    await prisma.$executeRawUnsafe(`DROP DATABASE \`${configured}\``);
    await prisma.$executeRawUnsafe(
      `CREATE DATABASE \`${configured}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    console.log('  dropped and recreated, empty.');
    console.log('  next: npx dotenv -e .env.staging -- prisma migrate deploy');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('REFUSED: ' + (e instanceof Error ? e.message : e));
  process.exitCode = 1;
});
