// ===========================================================================
// Tear down STAGING test artifacts, keeping the environment itself.
//
//   npx ts-node scripts/staging-cleanup.ts
//
// Removes what a test run created — synthetic tenants and their users, the
// temporary administrator, live sessions, unexpired verification codes — while
// leaving the database, the migrations and the pricing configuration in place,
// so the environment stays available for the next round of acceptance testing.
//
// **It preserves the audit and subscription-event timelines.** They are
// append-only by database trigger, so the application account cannot delete
// them even if asked — which is the entire point. A cleanup that could edit the
// audit trail would prove the audit trail is worthless.
//
// Refuses outside staging, and refuses on any database whose name does not look
// like staging. See `docs/39_STAGING_ENVIRONMENT.md`.
// ===========================================================================

import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';

// `override` is load-bearing: `@prisma/client` loads `.env` as an import
// side effect, before this line runs, and plain dotenv will not replace a
// variable that is already set. See `scripts/staging-verification-code.ts`
// for the full account of how that made a staging guard pass while the
// connection stayed on development.
loadEnv({ path: '.env.staging', override: true });

/** Only synthetic identities. `.invalid` can never be a real domain (RFC 2606). */
const SYNTHETIC_EMAIL = /@example\.(invalid|com|org|net)$/i;

/**
 * Nothing is deleted unless somebody asks.
 *
 * A cleanup script is run in a hurry, often in the wrong terminal, usually
 * while something else has gone wrong. Reporting first and deleting second
 * costs one extra command and removes the only outcome that cannot be undone.
 */
const APPLY = process.argv.includes('--apply');

/**
 * The staging administrator is deliberate infrastructure, not test litter.
 *
 * It used to be swept away on every run, so the next session had to recreate it
 * before it could do anything. Removing it is now something you ask for.
 */
const REMOVE_ADMIN = process.argv.includes('--remove-admin');

/**
 * Only what a given run created.
 *
 * "Owner has an `@example.invalid` address" identifies test data, but it does
 * NOT distinguish this afternoon's litter from the staging fixtures every
 * session depends on — those are synthetic too, because staging has no real
 * shops in it at all. The CP8 acceptance found this the safe way round, in a
 * dry run: the script proposed deleting 41 companies, and three of them were
 * the baseline.
 *
 * With `--since`, a company must be synthetic AND newer than the moment the
 * run began. Without it nothing changes — a full sweep is still what somebody
 * resetting the whole environment wants.
 */
function parseSince(): Date | null {
  const arg = process.argv.find((a) => a.startsWith('--since='));
  if (!arg) return null;
  const raw = arg.slice('--since='.length);
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`--since="${raw}" is not a date I can read. Use an ISO timestamp.`);
  }
  return at;
}

const SINCE = parseSince();

function assertStaging(): string {
  const appEnv = (process.env.APP_ENV ?? '').toLowerCase();
  if (appEnv !== 'staging') {
    throw new Error(`APP_ENV is "${appEnv || 'unset'}", not "staging". Refusing.`);
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Refusing.');
  if (url.includes('${')) throw new Error('DATABASE_URL has an unresolved variable. Refusing.');

  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name || name === '*') throw new Error('Refusing: empty or wildcard database name.');
  if (!/^[a-z0-9_]*stag(e|ing)[a-z0-9_]*$/i.test(name)) {
    throw new Error(`Refusing: "${name}" is not a staging database name.`);
  }
  for (const forbidden of [/^phonestore$/i, /prod/i, /production/i, /^live$/i, /demo/i]) {
    if (forbidden.test(name)) throw new Error(`Refusing: "${name}" looks like a protected database.`);
  }
  return name;
}

async function main() {
  const database = assertStaging();
  const prisma = new PrismaClient();
  const removed: Record<string, number> = {};

  try {
    console.log(`\n  staging cleanup — ${database}\n`);

    /*
     * Sessions first, everywhere.
     *
     * A revoked session is the one piece of cleanup that must not wait for the
     * rest to succeed: a live token outlives the row it authenticates and is a
     * working credential until it expires on its own.
     */
    removed.adminSessions = APPLY
      ? (await prisma.platformAdminSession.deleteMany({})).count
      : await prisma.platformAdminSession.count();

    // Verification codes: consume every unexpired one so nothing that was
    // issued during testing can still be redeemed afterwards.
    removed.verificationCodes = APPLY
      ? (
          await prisma.contactVerification.updateMany({
            where: { consumedAt: null },
            data: { consumedAt: new Date() },
          })
        ).count
      : await prisma.contactVerification.count({ where: { consumedAt: null } });

    /*
     * Unspent continuations and handoff tickets.
     *
     * Both live in `verification_intents` and both are credentials. A ticket
     * left unconsumed after a test run is a working credential nobody is
     * watching, and expiring it costs nothing.
     */
    removed.openIntents = APPLY
      ? (
          await prisma.verificationIntent.updateMany({
            where: { consumedAt: null },
            data: { consumedAt: new Date() },
          })
        ).count
      : await prisma.verificationIntent.count({ where: { consumedAt: null } });

    /*
     * The administrator, only when asked for.
     *
     * `platform_audit_events.admin_id` is a nullable foreign key with no
     * delete action, so it RESTRICTS — which is why this used to fail outright
     * with "Foreign key constraint violated: admin_id". The fix is not to
     * cascade: the schema deliberately keeps the actor's name as text beside
     * the reference precisely "so the record still reads after an admin row is
     * gone". So the reference is released and the audit row is KEPT.
     *
     * Deleting the events instead would destroy exactly the records that must
     * outlive the thing they describe.
     */
    if (REMOVE_ADMIN) {
      /*
       * The same window applies here. A run that creates a temporary
       * administrator should be able to take its own away without also removing
       * the deliberate staging one, which is the whole point of keeping that
       * one by default.
       */
      const admins = await prisma.platformAdmin.findMany({
        where: {
          email: { contains: '@example.' },
          ...(SINCE ? { createdAt: { gte: SINCE } } : {}),
        },
        select: { id: true },
      });
      const ids = admins.map((a) => a.id);
      removed.platformAdmins = ids.length;

      if (APPLY && ids.length > 0) {
        removed.auditReferencesReleased = (
          await prisma.platformAuditEvent.updateMany({
            where: { adminId: { in: ids } },
            data: { adminId: null },
          })
        ).count;
        await prisma.platformAdmin.deleteMany({ where: { id: { in: ids } } });
      }
    } else {
      removed.platformAdmins = 0;
      console.log('  keeping the staging administrator (pass --remove-admin to delete it)');
    }

    // Synthetic tenants. Only companies whose owner is a synthetic address —
    // never a sweep of every company, because "delete all tenants" is a command
    // that must not exist in a file somebody might run in the wrong shell.
    const users = await prisma.user.findMany({
      select: { id: true, email: true, companyId: true, company: { select: { createdAt: true } } },
    });
    /*
     * Deduplicated BY VALUE, not by reference.
     *
     * `companyId` is a Buffer, and a Set of Buffers dedupes by object identity
     * — so two users of the same company produced two entries, and the script
     * both over-reported and tried to delete the same company twice. Keying on
     * the hex string is what makes one company count once.
     */
    const byHex = new Map<string, Buffer>();
    /** Companies holding a real contact. Never candidates, whatever else matches. */
    const real = new Set<string>();
    for (const u of users) {
      const hex = u.companyId.toString('hex');
      // A real address anywhere in a company disqualifies the whole company.
      if (u.email && !SYNTHETIC_EMAIL.test(u.email)) { real.add(hex); continue; }
      if (SINCE && u.company.createdAt < SINCE) continue;
      /*
       * Inside a window, a company with NO email at all counts too. A
       * WhatsApp-only registration leaves an owner with a phone and no address,
       * so the email rule cannot see it — the CP8 acceptance created six such
       * shops and the first dry run listed none of them. Outside a window the
       * old, narrower rule still applies: without a timestamp to bound it,
       * "has no email" would match far too much.
       */
      if (u.email || SINCE) byHex.set(hex, u.companyId);
    }
    for (const hex of real) byHex.delete(hex);
    const syntheticCompanyIds = byHex.values();

    if (byHex.size === 0) {
      console.log('  no synthetic tenant found — nothing to remove\n');
    }

    for (const companyId of syntheticCompanyIds) {
      /*
       * Deletion is attempted, not assumed. Financial and audit rows are
       * append-only by trigger and referenced by foreign keys, so a tenant that
       * has been through a full lifecycle may legitimately refuse to be
       * deleted. That is correct behaviour, and it is reported rather than
       * worked around: nothing here disables a trigger or drops a constraint.
       */
      if (!APPLY) {
        removed.companyCandidates = (removed.companyCandidates ?? 0) + 1;
        continue;
      }
      try {
        await prisma.company.delete({ where: { id: companyId } });
        removed.companiesRemoved = (removed.companiesRemoved ?? 0) + 1;
      } catch {
        removed.companiesRefused = (removed.companiesRefused ?? 0) + 1;
      }
    }

    for (const [what, n] of Object.entries(removed)) console.log(`  ${what}: ${n}`);

    /*
     * A tenant is a CANDIDATE, never a promise.
     *
     * `companies` is referenced by seventy-odd tables and every one of them
     * restricts deletion — branches, users, roles, role_permissions and
     * subscriptions among them, all of which registration itself creates. So
     * `company.delete()` cannot succeed for any shop that has ever registered,
     * and this script has never removed one. It reported "companies: 38" in a
     * dry run and then removed nothing, which reads exactly like success.
     *
     * Deleting the children in dependency order is not the fix. "Nothing
     * financial is hard-deleted" is a rule of this system, not an obstacle to
     * route around. Reclaiming a staging tenant means restoring the database,
     * which is a deliberate act with its own procedure in `docs/22`.
     */
    const refusedCount = removed.companiesRefused ?? 0;
    if (refusedCount > 0) {
      console.log(
        `\n  ${refusedCount} tenant(s) could NOT be removed, and were left intact.\n` +
          '  That is the schema working: a company is referenced by its branches,\n' +
          '  users, roles and subscription, and all of them restrict deletion.\n' +
          '  Staging tenants accumulate. Reclaiming them means restoring the\n' +
          '  database (docs/22), not deleting rows.',
      );
    }
    if (!APPLY && (removed.companyCandidates ?? 0) > 0) {
      console.log(
        `\n  NOTE: ${removed.companyCandidates} tenant(s) match, but tenant deletion is\n` +
          '  refused by foreign keys in practice. Expect them to remain.',
      );
    }

    const kept = {
      auditEvents: await prisma.platformAuditEvent.count(),
      subscriptionEvents: await prisma.subscriptionEvent.count(),
    };
    console.log('\n  preserved (append-only, by design):');
    for (const [what, n] of Object.entries(kept)) console.log(`  ${what}: ${n}`);
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
