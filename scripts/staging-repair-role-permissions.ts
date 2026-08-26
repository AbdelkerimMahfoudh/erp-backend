// ===========================================================================
// Repair tenants that were provisioned with roles but no permissions.
//
//   npx ts-node scripts/staging-repair-role-permissions.ts          # dry run
//   npx ts-node scripts/staging-repair-role-permissions.ts --apply  # writes
//
// **Dry run by default.** Writing requires `--apply`, spelled out, every time.
//
// The defect: `RegistrationService` created three `roles` rows and no
// `role_permissions`, while `AccessService` resolves authority only from
// `role_permissions`. Every self-registered shop got an Owner who could sign in
// and then do nothing. Registration is fixed; this repairs the companies
// created before the fix.
//
// The matrix is NOT written down here. It comes from `provisionDefaultRoles`,
// the same function registration and the seed use — a second copy of the matrix
// in a repair script is exactly the kind of thing that caused the original bug.
// There is no SQL and no migration: this is data repair on specific rows, not a
// schema change.
//
// **Conservative on purpose.** A company is repaired only when it is provably
// the empty case. Anything partial, customised or unrecognised is skipped whole
// and reported for a person to look at. Completing somebody's deliberately
// narrowed role would be a worse bug than the one being fixed, and a silent one.
// ===========================================================================

import { config as loadEnv } from 'dotenv';
import { PrismaClient, type Prisma } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { binToUuid } from '../src/common/utils/uuid.util';
import { provisionDefaultRoles, DEFAULT_TENANT_ROLE_KEYS } from '../src/rbac/role-provisioning';
import { judgeCompany, DEMO_COMPANY_UUID, type Verdict } from '../src/rbac/role-repair-eligibility';

// `override` is load-bearing: `@prisma/client` loads `.env` as an import side
// effect, before this line runs, and plain dotenv will not replace a variable
// that is already set. See `scripts/staging-verification-code.ts` for the full
// account of how that made a staging guard pass while the connection stayed on
// development.
loadEnv({ path: '.env.staging', override: true });

const APPLY = process.argv.includes('--apply');

/** Names this script will never touch, however they are spelled. */
const FORBIDDEN = [/^phonestore$/i, /prod/i, /production/i, /^live$/i, /demo/i];
/** A staging database must say so in its own name. */
const REQUIRED_SHAPE = /^[a-z0-9_]*stag(e|ing)[a-z0-9_]*$/i;

function databaseNameFrom(url: string | undefined): string {
  if (!url) throw new Error('DATABASE_URL is not set. Refusing to guess.');
  if (/\$\{?[A-Z_]+\}?/.test(url)) {
    throw new Error('DATABASE_URL contains an unresolved variable. Refusing.');
  }
  const name = new URL(url).pathname.replace(/^\//, '').trim();
  if (!name) throw new Error('DATABASE_URL names no database. Refusing.');
  return name;
}

function assertStagingOnly(): string {
  const appEnv = (process.env.APP_ENV ?? '').toLowerCase();
  if (appEnv !== 'staging') {
    throw new Error(`APP_ENV is "${appEnv || 'unset'}", not "staging". Refusing.`);
  }

  const name = databaseNameFrom(process.env.DATABASE_URL);
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

// ── Backup, and proof that the backup is restorable ────────────────────────

function mysqlConfig(): string | null {
  const cnf = join(homedir(), '.my.cnf');
  return existsSync(cnf) ? cnf : null;
}

/**
 * Find `mysqldump` / `mysql`.
 *
 * They are not on PATH under WAMP, and "the backup silently did not happen" is
 * the one failure a repair command must never have. `MYSQL_BIN_DIR` names the
 * directory explicitly; otherwise the usual WAMP location is tried, and PATH is
 * the last resort. If none of them work the caller throws rather than writing.
 */
function mysqlTool(name: 'mysql' | 'mysqldump'): string {
  const configured = process.env.MYSQL_BIN_DIR?.trim();
  const candidates = [
    ...(configured ? [join(configured, `${name}.exe`), join(configured, name)] : []),
    `C:/wamp64/bin/mysql/mysql8.4.7/bin/${name}.exe`,
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return name; // PATH, and let execFileSync report if it is not there.
}

function backup(name: string): string {
  const cnf = mysqlConfig();
  if (!cnf) {
    throw new Error(
      'No ~/.my.cnf, so no verified backup can be taken. Refusing to write without one.',
    );
  }

  const dir = join(homedir(), 'erp-backups');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const out = join(
    dir,
    `${name}-before-role-repair-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`,
  );

  const dump = execFileSync(
    mysqlTool('mysqldump'),
    [
      `--defaults-extra-file=${cnf}`,
      '--single-transaction',
      '--routines',
      '--triggers',
      '--events',
      '--no-tablespaces',
      '--hex-blob',
      '--result-file=' + out,
      name,
    ],
    { maxBuffer: 512 * 1024 * 1024 },
  );
  void dump;

  const size = statSync(out).size;
  if (size < 1024) throw new Error(`The dump is only ${size} bytes. Refusing to trust it.`);
  console.log(`  backup      : ${out}  (${(size / 1024 / 1024).toFixed(1)} MB)`);
  return out;
}

/**
 * Prove the backup by RESTORING it, not by looking at the file.
 *
 * A dump that exists is not a backup; a dump that restores is. It goes into a
 * throwaway database and the database is dropped straight after, so nothing is
 * left behind and staging itself is never touched by the proof.
 */
function restoreProve(sourceName: string, dumpPath: string): void {
  const cnf = mysqlConfig()!;
  const scratch = `${sourceName}_restoreproof_${Date.now().toString(36)}`;
  // The scratch name inherits the staging shape, so it is covered by the same
  // grants and could never collide with a protected database.
  assertNameSafe(scratch);

  const sql = (statement: string, database?: string) =>
    execFileSync(
      mysqlTool('mysql'),
      [`--defaults-extra-file=${cnf}`, ...(database ? [database] : []), '-e', statement],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );

  try {
    sql(`CREATE DATABASE \`${scratch}\``);
    execFileSync(
      mysqlTool('mysql'),
      [`--defaults-extra-file=${cnf}`, scratch, '-e', `SOURCE ${dumpPath.replace(/\\/g, '/')}`],
      { maxBuffer: 512 * 1024 * 1024 },
    );

    const tables = sql(
      `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${scratch}'`,
      undefined,
    );
    const count = Number(tables.split('\n')[1]?.trim() ?? 0);
    if (count < 50) {
      throw new Error(`Restored only ${count} tables. The backup is not trustworthy.`);
    }
    console.log(`  restore-proof: OK — restored ${count} tables into a disposable database`);
  } finally {
    try {
      sql(`DROP DATABASE IF EXISTS \`${scratch}\``);
      console.log('  restore-proof: disposable database dropped');
    } catch {
      console.warn(`  ! Could not drop ${scratch}. Drop it by hand.`);
    }
  }
}

function assertNameSafe(name: string): void {
  for (const pattern of FORBIDDEN) {
    if (pattern.test(name)) throw new Error(`Refusing to create "${name}".`);
  }
  if (!REQUIRED_SHAPE.test(name)) throw new Error(`Refusing to create "${name}".`);
}

// ── Eligibility ────────────────────────────────────────────────────────────

interface Candidate {
  companyId: Buffer;
  name: string;
  verdict: Verdict;
  current: Record<string, number>;
}

const DEFAULTS = [...DEFAULT_TENANT_ROLE_KEYS];

async function survey(prisma: PrismaClient | Prisma.TransactionClient): Promise<Candidate[]> {
  const companies = await prisma.company.findMany({
    select: {
      id: true,
      name: true,
      roles: {
        select: { key: true, _count: { select: { rolePermissions: true } } },
      },
    },
  });

  // Registration provenance: a `registration_attempts` row naming the company.
  const attempts = await prisma.registrationAttempt.findMany({ select: { companyId: true } });
  const registered = new Set(
    attempts.filter((a) => a.companyId).map((a) => a.companyId!.toString('hex')),
  );

  return companies.map((c) => {
    const roles = c.roles.map((r) => ({ key: r.key, mappingCount: r._count.rolePermissions }));
    const current: Record<string, number> = {};
    for (const r of roles) current[r.key] = r.mappingCount;
    return {
      companyId: c.id,
      name: c.name,
      current,
      verdict: judgeCompany({
        uuid: binToUuid(c.id),
        cameFromSelfRegistration: registered.has(c.id.toString('hex')),
        roles,
      }),
    };
  });
}

/** A fingerprint of one company's role permissions, for before/after proof. */
async function checksum(
  prisma: PrismaClient | Prisma.TransactionClient,
  companyId: Buffer,
): Promise<string> {
  const rows = await prisma.rolePermission.findMany({
    where: { companyId },
    select: { role: { select: { key: true } }, permission: { select: { key: true } } },
  });
  const canon = rows
    .map((r) => `${r.role.key}:${r.permission.key}`)
    .sort()
    .join('|');
  return createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const database = assertStagingOnly();
  const prisma = new PrismaClient();

  console.log('');
  console.log(`  role-permission repair — ${database}`);
  console.log(`  mode        : ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
  console.log('');

  try {
    const candidates = await survey(prisma);
    const eligible = candidates.filter((c) => c.verdict.kind === 'eligible');
    const skipped = candidates.filter((c) => c.verdict.kind === 'skip');

    // The demo tenant's fingerprint, before anything happens.
    const demo = candidates.find((c) => binToUuid(c.companyId) === DEMO_COMPANY_UUID);
    const demoBefore = demo ? await checksum(prisma, demo.companyId) : null;

    console.log(`  companies   : ${candidates.length}`);
    console.log(`  eligible    : ${eligible.length}`);
    console.log(`  skipped     : ${skipped.length}`);
    console.log('');

    for (const c of eligible) {
      const v = c.verdict as Extract<Verdict, { kind: 'eligible' }>;
      console.log(`  ELIGIBLE  ${binToUuid(c.companyId)}  ${c.name}`);
      for (const key of DEFAULTS) {
        console.log(`      ${key.padEnd(16)} now ${String(c.current[key] ?? 0).padStart(3)}  ->  ${String(v.willAdd[key]).padStart(3)}`);
      }
    }
    for (const c of skipped) {
      const v = c.verdict as Extract<Verdict, { kind: 'skip' }>;
      console.log(`  SKIP      ${binToUuid(c.companyId)}  ${c.name}`);
      console.log(`      ${v.why}`);
    }
    console.log('');

    if (!APPLY) {
      console.log('  Dry run — nothing was written. Re-run with --apply to repair.');
      console.log('');
      return;
    }
    if (eligible.length === 0) {
      console.log('  Nothing eligible. No backup taken, nothing written.');
      console.log('');
      return;
    }

    const dump = backup(database);
    restoreProve(database, dump);
    console.log('');

    let repaired = 0;
    for (const c of eligible) {
      /*
       * Re-judged INSIDE the transaction, against rows read in that
       * transaction. The survey above is a report; between printing it and
       * writing, somebody could have configured this company by hand, and
       * repairing them then would overwrite a real decision.
       */
      await prisma.$transaction(async (tx) => {
        const fresh = (await survey(tx)).find((x) => x.companyId.equals(c.companyId));
        if (!fresh || fresh.verdict.kind !== 'eligible') {
          console.log(`  RECHECK   ${binToUuid(c.companyId)} is no longer eligible — skipped`);
          return;
        }

        const { mappingsCreated } = await provisionDefaultRoles(tx, c.companyId);

        await tx.platformAuditEvent.create({
          data: {
            id: (await import('../src/common/utils/uuid.util')).newUuidV7Bin(),
            /*
             * No admin id, and an actor that says what it is. A person did not
             * do this, and recording one would put a name on a change they
             * never made — the audit trail's whole value is that it does not
             * say things that are untrue.
             */
            adminId: null,
            actor: 'system:role-permission-repair',
            action: 'maintenance.role_permissions_repaired',
            targetType: 'company',
            targetId: c.companyId,
            targetLabel: c.name.slice(0, 200),
            reason:
              'Default roles were provisioned without permissions before the ' +
              'registration fix. Canonical matrix applied.',
            beforeJson: fresh.current as never,
            afterJson: { mappingsCreated } as never,
          },
        });

        console.log(`  REPAIRED  ${binToUuid(c.companyId)}  ${c.name}  (+${mappingsCreated} mappings)`);
        repaired++;
      });
    }

    console.log('');
    console.log(`  repaired    : ${repaired}`);

    if (demo && demoBefore) {
      const demoAfter = await checksum(prisma, demo.companyId);
      console.log(
        `  demo tenant : ${demoBefore === demoAfter ? 'UNCHANGED ✓' : 'CHANGED — INVESTIGATE'}` +
          `  (${demoBefore} -> ${demoAfter})`,
      );
    }
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
