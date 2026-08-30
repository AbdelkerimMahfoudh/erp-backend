// ===========================================================================
// What can actually be recognised from an IMEI.
//
//   npx ts-node scripts/tac-coverage.ts             # development
//   APP_ENV=staging npx ts-node scripts/tac-coverage.ts --staging
//
// Three different things get confused with each other, so this counts them
// separately and refuses to add them up:
//
//   1. the SELECTOR catalogue — every brand and model somebody can choose;
//   2. TAC rows — the codes an IMEI can actually be recognised from;
//   3. company `ProductRecognition` mappings — what one shop has decided.
//
// A catalogue of 323 models does NOT mean 323 models can be recognised from an
// IMEI. Reporting one number for both would be the easiest lie to tell here.
// ===========================================================================

import { config as loadEnv } from 'dotenv';

if (process.argv.includes('--staging')) {
  loadEnv({ path: '.env.staging', override: true });
}

import { PrismaClient } from '@prisma/client';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const db = new URL(process.env.DATABASE_URL ?? '').pathname.replace(/^\//, '');

  try {
    const [brands, models, tacs, recognitions] = await Promise.all([
      prisma.deviceBrand.count({ where: { isActive: true } }),
      prisma.deviceModel.count({ where: { isActive: true } }),
      prisma.tacCatalog.findMany({
        select: { tac: true, brand: true, model: true, modelId: true, source: true, isActive: true },
      }),
      prisma.productRecognition.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    const bySource = new Map<string, number>();
    const byBrand = new Map<string, number>();
    const coveredModelIds = new Set<number>();
    const coveredNames = new Set<string>();

    for (const t of tacs) {
      bySource.set(t.source, (bySource.get(t.source) ?? 0) + 1);
      byBrand.set(t.brand ?? '(no brand)', (byBrand.get(t.brand ?? '(no brand)') ?? 0) + 1);
      if (t.modelId !== null) coveredModelIds.add(t.modelId);
      if (t.model) coveredNames.add(`${t.brand ?? ''}|${t.model}`);
    }

    console.log(`\n  TAC coverage — ${db}\n`);

    console.log('  1. The SELECTOR catalogue — what somebody can choose');
    console.log(`     brands ................................ ${brands}`);
    console.log(`     models ................................ ${models}`);

    console.log('\n  2. TAC rows — what an IMEI can be recognised from');
    console.log(`     unique TACs ........................... ${tacs.length}`);
    console.log(`     active ................................ ${tacs.filter((t) => t.isActive).length}`);
    if (tacs.length === 0) {
      console.log('     (none — no IMEI resolves to anything here)');
    }
    for (const [source, n] of [...bySource].sort()) {
      console.log(`       by source: ${source.padEnd(22)} ${n}`);
    }
    for (const [brand, n] of [...byBrand].sort()) {
      console.log(`       by brand:  ${brand.padEnd(22)} ${n}`);
    }

    console.log('\n  3. Company mappings — what one shop has decided');
    if (recognitions.length === 0) console.log('     none');
    for (const r of recognitions) {
      console.log(`     ${r.status.padEnd(12)} .......................... ${r._count._all}`);
    }

    console.log('\n  Coverage, stated plainly');
    console.log(`     catalogue models WITH a TAC mapping ... ${coveredModelIds.size}`);
    console.log(`     catalogue models WITHOUT one .......... ${models - coveredModelIds.size}`);
    const pct = models === 0 ? 0 : Math.round((coveredModelIds.size / models) * 1000) / 10;
    console.log(`     recognisable share .................... ${pct}%`);
    console.log(
      `\n  ${coveredModelIds.size} of ${models} selectable models can be recognised from an IMEI.\n` +
        '  The rest are chosen from the list or typed. Broad recognition needs\n' +
        '  licensed GSMA data; nothing here substitutes for it.\n',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
