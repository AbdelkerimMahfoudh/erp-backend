// ===========================================================================
// What can actually be recognised from an IMEI.
//
//   npx ts-node scripts/tac-coverage.ts                       # development
//   APP_ENV=staging npx ts-node scripts/tac-coverage.ts --staging
//   … --company "Test Store"      # effective coverage for one shop
//
// Three different things get confused with one another, so they are counted
// separately and NEVER added up:
//
//   1. the SELECTOR catalogue — every brand and model somebody can choose;
//   2. the GLOBAL TAC catalogue — generic manufacturer/model by code;
//   3. a company's CONFIRMED mappings — what one shop has decided a code means.
//
// A catalogue of 323 models does not mean 323 models can be recognised. Nor
// does an empty global catalogue mean nothing resolves: a confirmed company
// mapping resolves **on its own**, without any global row, and returns the
// shop's exact product rather than a generic label. An earlier version of this
// report got that wrong in both directions — it counted barcode mappings as if
// they were TAC mappings, and concluded that a database with no `tac_catalog`
// rows could recognise nothing.
//
// Effective coverage for a shop is therefore a UNION, deduplicated by TAC:
// what the global catalogue knows, plus what that shop has confirmed.
// ===========================================================================

import { config as loadEnv } from 'dotenv';

if (process.argv.includes('--staging')) {
  loadEnv({ path: '.env.staging', override: true });
}

import { PrismaClient } from '@prisma/client';

function companyArg(): string | null {
  const arg = process.argv.find((a) => a.startsWith('--company='));
  if (arg) return arg.slice('--company='.length);
  const i = process.argv.indexOf('--company');
  return i > -1 ? (process.argv[i + 1] ?? null) : null;
}

const pad = (s: string, n = 42) => s.padEnd(n, '.');

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const db = new URL(process.env.DATABASE_URL ?? 'mysql://x/none').pathname.replace(/^\/+/, '');
  const wanted = companyArg();

  try {
    const [brands, models, tacs, mappings] = await Promise.all([
      prisma.deviceBrand.count({ where: { isActive: true } }),
      prisma.deviceModel.count({ where: { isActive: true } }),
      prisma.tacCatalog.findMany({
        select: { tac: true, brand: true, model: true, modelId: true, source: true, isActive: true },
      }),
      /*
       * `codeType: 'tac'` and nothing else. `product_recognition` also holds
       * `barcode` and `serial_prefix` rows, and only the first kind answers
       * "what phone is this IMEI" — counting the others was the error that
       * produced the wrong report.
       */
      prisma.productRecognition.findMany({
        where: { codeType: 'tac' },
        select: {
          code: true,
          status: true,
          companyId: true,
          company: { select: { name: true } },
          product: { select: { brand: true, model: true } },
        },
      }),
    ]);

    console.log(`\n  TAC coverage — ${db}\n`);

    // ── 1. the selector catalogue ─────────────────────────────────────────
    console.log('  1. SELECTOR catalogue — what somebody can choose');
    console.log(`     ${pad('brands')} ${brands}`);
    console.log(`     ${pad('models')} ${models}`);
    console.log('     (choosing from this list needs no IMEI at all)');

    // ── 2. the global TAC catalogue ───────────────────────────────────────
    const active = tacs.filter((t) => t.isActive);
    const bySource = new Map<string, { tacs: Set<string>; models: Set<string> }>();
    const byBrand = new Map<string, { tacs: Set<string>; models: Set<string> }>();
    const globalModelIds = new Set<number>();

    for (const t of active) {
      const key = `${t.brand ?? ''}|${t.model ?? ''}`;
      for (const [map, k] of [
        [bySource, t.source] as const,
        [byBrand, t.brand ?? '(no brand)'] as const,
      ]) {
        const e = map.get(k) ?? { tacs: new Set<string>(), models: new Set<string>() };
        e.tacs.add(t.tac);
        if (t.model) e.models.add(key);
        map.set(k, e);
      }
      if (t.modelId !== null) globalModelIds.add(t.modelId);
    }

    console.log('\n  2. GLOBAL TAC catalogue — generic identity by code');
    console.log(`     ${pad('distinct TACs (active)')} ${active.length}`);
    console.log(`     ${pad('inactive/retired')} ${tacs.length - active.length}`);
    if (active.length === 0) console.log('     (empty — no code resolves generically here)');
    for (const [source, e] of [...bySource].sort()) {
      console.log(`       by source  ${pad(source, 28)} ${e.tacs.size} TACs, ${e.models.size} models`);
    }
    for (const [brand, e] of [...byBrand].sort()) {
      console.log(`       by brand   ${pad(brand, 28)} ${e.tacs.size} TACs, ${e.models.size} models`);
    }

    // ── 3. company-confirmed mappings ─────────────────────────────────────
    const confirmed = mappings.filter((m) => m.status === 'confirmed');
    const perCompany = new Map<string, { name: string; tacs: Set<string>; models: Set<string> }>();
    for (const m of confirmed) {
      const id = m.companyId.toString('hex');
      const e = perCompany.get(id) ?? { name: m.company.name, tacs: new Set(), models: new Set() };
      e.tacs.add(m.code);
      e.models.add(`${m.product.brand}|${m.product.model}`);
      perCompany.set(id, e);
    }

    console.log('\n  3. COMPANY-CONFIRMED mappings — what one shop has decided');
    console.log(`     ${pad('confirmed tac mappings')} ${confirmed.length}`);
    console.log(`     ${pad('proposals (never auto-selected)')} ${mappings.filter((m) => m.status === 'proposed').length}`);
    console.log(`     ${pad('superseded (kept, not counted)')} ${mappings.filter((m) => m.status === 'superseded').length}`);
    if (perCompany.size === 0) console.log('     none');
    for (const [, e] of perCompany) {
      console.log(`       ${pad(e.name, 30)} ${e.tacs.size} TACs, ${e.models.size} products`);
    }
    if (confirmed.length > 0) {
      console.log('     These resolve WITHOUT a global row, and outrank one when both exist.');
    }

    // ── Effective coverage for one shop ───────────────────────────────────
    const globalTacs = new Set(active.map((t) => t.tac));
    console.log('\n  EFFECTIVE coverage — per company, deduplicated by TAC');
    const companies = wanted
      ? [...perCompany.values()].filter((c) => c.name === wanted)
      : [...perCompany.values()];

    if (wanted && companies.length === 0) {
      console.log(`     "${wanted}" has no confirmed TAC mappings.`);
      console.log(`     It still sees the ${globalTacs.size} generic TACs above.`);
    }
    for (const c of companies) {
      const union = new Set([...globalTacs, ...c.tacs]);
      const overlap = [...c.tacs].filter((t) => globalTacs.has(t)).length;
      console.log(`     ${c.name}`);
      console.log(`       ${pad('generic TACs it can see', 34)} ${globalTacs.size}`);
      console.log(`       ${pad('its own confirmed TACs', 34)} ${c.tacs.size}`);
      console.log(`       ${pad('overlapping both', 34)} ${overlap}`);
      console.log(`       ${pad('effective distinct TACs (union)', 34)} ${union.size}`);
    }
    if (!wanted && companies.length === 0) {
      console.log(`     No company has confirmed anything; every shop sees the same`);
      console.log(`     ${globalTacs.size} generic TACs and nothing more.`);
    }

    // ── The honest headline ───────────────────────────────────────────────
    console.log('\n  Stated precisely');
    console.log(`     ${pad('catalogue models with a GENERIC TAC row')} ${globalModelIds.size} of ${models}`);
    const pct = models === 0 ? 0 : Math.round((globalModelIds.size / models) * 1000) / 10;
    const label = [...bySource.keys()].join('+') || 'none';
    console.log(
      `\n  ${globalModelIds.size} of ${models} selectable models have a generic TAC row in\n` +
        `  ${db} (source: ${label}) — ${pct}%. That is THIS DATABASE'S generic\n` +
        `  catalogue coverage. It is not system coverage and it is not production\n` +
        '  coverage, and a company that has confirmed its own mappings resolves\n' +
        '  codes this number knows nothing about.\n\n' +
        '  Broad generic recognition needs licensed GSMA data.\n',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
