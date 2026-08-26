// ===========================================================================
// Seed a STAGING database.
//
//   npx dotenv -e .env.staging -- ts-node prisma/seed-staging.ts
//
// Seeds the **minimum platform configuration** and nothing else:
//
//   - the Standard plan version, if migration 0058 did not already insert it.
//
// It deliberately does NOT seed:
//
//   - the demo company, or any copy of it;
//   - any real user, phone number, email, IMEI, sale or financial record;
//   - a platform administrator — that is a deliberate, interactive act with a
//     password nobody should paste into a seed file.
//
// Staging exists to test the workflow with synthetic identities created THROUGH
// the product. Pre-seeding tenants would test the seed instead.
// ===========================================================================

import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { newUuidV7Bin } from './lib/uuid';
import { PERMISSIONS } from '../src/rbac/role-permissions';

// `override` is load-bearing: `@prisma/client` loads `.env` as an import
// side effect, before this line runs, and plain dotenv will not replace a
// variable that is already set. See `scripts/staging-verification-code.ts`
// for the full account of how that made a staging guard pass while the
// connection stayed on development.
loadEnv({ path: '.env.staging', override: true });

const prisma = new PrismaClient();

async function main() {
  if ((process.env.APP_ENV ?? '').toLowerCase() !== 'staging') {
    throw new Error('APP_ENV is not "staging". Refusing to seed.');
  }

  const dbName = new URL(process.env.DATABASE_URL ?? '').pathname.replace(/^\//, '');
  if (!/stag(e|ing)/i.test(dbName)) {
    throw new Error(`"${dbName}" does not identify itself as staging. Refusing.`);
  }

  // Nothing tenant-shaped may already exist. If it does, this is not a fresh
  // staging database and seeding it would be layering onto unknown state.
  const companies = await prisma.company.count();
  if (companies > 0) {
    console.log(`  ${companies} company(ies) already present — leaving them alone.`);
  }

  /*
   * The permission catalogue is REFERENCE data, and every environment needs
   * all of it.
   *
   * It is not created by any migration. The base keys — `sale.create`,
   * `report.view`, `user.manage` and the rest — are inserted only by
   * `prisma/seed.ts`, which also seeds the demo company and therefore never
   * runs here. Staging was left holding 44 of the 61 keys, and the first thing
   * that noticed was the role repair refusing to provision a partial Owner.
   *
   * Seeded through the same `PERMISSIONS` constant the main seed uses, so there
   * is no second list. `upsert` keeps this idempotent and leaves existing rows
   * alone.
   */
  let added = 0;
  for (const permission of PERMISSIONS) {
    const before = await prisma.permission.findUnique({ where: { key: permission.key } });
    await prisma.permission.upsert({
      where: { key: permission.key },
      update: { label: permission.label },
      create: { id: newUuidV7Bin(), key: permission.key, label: permission.label },
    });
    if (!before) added++;
  }
  console.log(
    `  permission catalogue: ${PERMISSIONS.length} keys present (${added} added this run)`,
  );

  const plans = await prisma.planVersion.count({ where: { planKey: 'standard' } });
  if (plans === 0) {
    // Only reachable if the migration's insert was rolled back somehow; the
    // migration normally provides this.
    throw new Error(
      'No Standard plan version found. Run `prisma migrate deploy` first — 0058 inserts it.',
    );
  }

  const plan = await prisma.planVersion.findFirst({
    where: { planKey: 'standard' },
    orderBy: { effectiveFrom: 'asc' },
  });

  console.log('Staging platform configuration:');
  console.log(`  plan v${plan!.version}: ${plan!.branchMonthly} MRU per branch, ` +
    `${plan!.includedStaffPerBranch} staff included per branch, ` +
    `${plan!.extraStaffMonthly} MRU per extra staff account`);
  console.log(`  companies: ${companies}   (synthetic tenants are created through the website)`);
  console.log('');
  console.log('  No demo company, no real users, no financial records were seeded.');
  console.log('  Create the first administrator with:');
  console.log('    PLATFORM_ADMIN_PASSWORD=… npx dotenv -e .env.staging -- ts-node prisma/create-platform-admin.ts you@example.com "Your Name"');
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
