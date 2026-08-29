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
      const admins = await prisma.platformAdmin.findMany({
        where: { email: { contains: '@example.' } },
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
    const users = await prisma.user.findMany({ select: { id: true, email: true, companyId: true } });
    /*
     * Deduplicated BY VALUE, not by reference.
     *
     * `companyId` is a Buffer, and a Set of Buffers dedupes by object identity
     * — so two users of the same company produced two entries, and the script
     * both over-reported and tried to delete the same company twice. Keying on
     * the hex string is what makes one company count once.
     */
    const byHex = new Map<string, Buffer>();
    for (const u of users) {
      if (u.email && SYNTHETIC_EMAIL.test(u.email)) byHex.set(u.companyId.toString('hex'), u.companyId);
    }
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
      try {
        if (APPLY) await prisma.company.delete({ where: { id: companyId } });
        removed.companies = (removed.companies ?? 0) + 1;
      } catch (e) {
        console.log(
          '  a synthetic tenant could not be deleted, and was left in place:\n' +
            '    ' + (e instanceof Error ? e.message.split('\n')[0] : String(e)) + '\n' +
            '    This usually means append-only audit rows reference it. That is the\n' +
            '    protection working. Reset the database instead if it must go.\n',
        );
      }
    }

    for (const [what, n] of Object.entries(removed)) console.log(`  ${what}: ${n}`);

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
