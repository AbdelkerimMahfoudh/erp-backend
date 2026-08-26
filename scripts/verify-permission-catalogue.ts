// ===========================================================================
// Verify a database's permission catalogue against the canonical source.
//
//   npx ts-node scripts/verify-permission-catalogue.ts
//   npx dotenv -e .env.staging -- ts-node scripts/verify-permission-catalogue.ts
//
// Exits non-zero when the catalogue is missing a key, holds a key the codebase
// does not define, or holds a duplicate. Intended as a **deploy-time gate**:
// run it after `prisma migrate deploy` and refuse to start on a failure.
//
// A short catalogue is the failure this exists to catch. It does not announce
// itself — the application starts, people sign in, and permissions they should
// have simply are not there. `AccessService` resolves authority only from
// `role_permissions`, which can only reference catalogue rows that exist, so a
// missing row silently narrows what a role can do.
//
// **It never deletes anything.** An unknown key fails the gate and is reported
// for a person to look at. Deleting it automatically could revoke authority a
// deliberate change granted, and this command cannot tell those apart.
//
// Prints counts and key names only — no connection string, no credential.
// ===========================================================================

import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSION_KEYS, PERMISSIONS } from '../src/rbac/role-permissions';

interface Report {
  ok: boolean;
  inDatabase: number;
  canonical: number;
  missing: string[];
  unknown: string[];
  duplicated: string[];
  relabelled: { key: string; database: string; canonical: string }[];
}

export async function verifyCatalogue(prisma: PrismaClient): Promise<Report> {
  const rows = await prisma.permission.findMany({ select: { key: true, label: true } });

  const seen = new Map<string, number>();
  for (const r of rows) seen.set(r.key, (seen.get(r.key) ?? 0) + 1);

  const canonical = new Set(ALL_PERMISSION_KEYS);
  const labels = new Map(PERMISSIONS.map((p) => [p.key, p.label]));

  const missing = [...canonical].filter((k) => !seen.has(k)).sort();
  const unknown = [...seen.keys()].filter((k) => !canonical.has(k)).sort();
  const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k).sort();

  /*
   * A drifted LABEL is reported but does not fail the gate.
   *
   * Labels are display text, not authority — a shop that renamed one has
   * changed nothing about what anybody can do, and failing a deployment over
   * wording would teach people to ignore this command.
   */
  const relabelled = rows
    .filter((r) => canonical.has(r.key) && labels.get(r.key) !== r.label)
    .map((r) => ({ key: r.key, database: r.label, canonical: labels.get(r.key)! }));

  return {
    ok: missing.length === 0 && unknown.length === 0 && duplicated.length === 0,
    inDatabase: seen.size,
    canonical: canonical.size,
    missing,
    unknown,
    duplicated,
    relabelled,
  };
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const r = await verifyCatalogue(prisma);

    console.log('');
    /*
     * Matched, not just totalled. A database missing one canonical key and
     * carrying one unknown key has the same ROW COUNT as a correct one, so a
     * bare total reads as reassuring at exactly the moment it should not.
     */
    const matched = r.inDatabase - r.unknown.length;
    console.log(
      `  permission catalogue: ${matched}/${r.canonical} canonical keys present` +
        (r.unknown.length ? `, plus ${r.unknown.length} unknown` : ''),
    );

    if (r.missing.length) {
      console.log(`  MISSING (${r.missing.length}) — roles referencing these cannot be granted:`);
      for (const k of r.missing) console.log(`    - ${k}`);
    }
    if (r.unknown.length) {
      console.log(`  UNKNOWN (${r.unknown.length}) — present here, not defined in the codebase:`);
      for (const k of r.unknown) console.log(`    ? ${k}`);
      console.log('    Nothing was deleted. Decide deliberately whether these belong.');
    }
    if (r.duplicated.length) {
      console.log(`  DUPLICATED (${r.duplicated.length}): ${r.duplicated.join(', ')}`);
    }
    if (r.relabelled.length) {
      console.log(`  relabelled (${r.relabelled.length}, not a failure — labels are display text):`);
      for (const x of r.relabelled) console.log(`    ~ ${x.key}`);
    }

    console.log(r.ok ? '  catalogue complete ✓' : '  CATALOGUE INCOMPLETE — refusing');
    console.log('');
    process.exitCode = r.ok ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
