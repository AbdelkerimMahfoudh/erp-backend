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
import { ALL_PERMISSION_KEYS, PERMISSIONS, ROLE_PERMISSIONS, type RoleKey } from '../src/rbac/role-permissions';

/**
 * A role holding a permission the codebase does not grant it.
 *
 * Found in the CP6 live run: `discount.override` was removed from
 * `branch_manager` in code when A2 made approval Owner-only, and the
 * `role_permissions` row stayed. `AccessService` resolves authority from that
 * table alone, so the retired role could still approve a discount — and this
 * command reported "61/61, catalogue complete", because it only ever checked
 * that the KEYS exist. A catalogue can be perfect while the grants are wrong.
 */
interface GrantDrift {
  role: string;
  roleKey: RoleKey;
  /** Held in the database, not granted by the codebase. Authority nobody meant. */
  extra: string[];
  /** Granted by the codebase, absent here. Authority somebody is missing. */
  missing: string[];
}

interface Report {
  ok: boolean;
  inDatabase: number;
  canonical: number;
  missing: string[];
  unknown: string[];
  duplicated: string[];
  relabelled: { key: string; database: string; canonical: string }[];
  grants: GrantDrift[];
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

  const grants = await verifyGrants(prisma);

  return {
    ok:
      missing.length === 0 &&
      unknown.length === 0 &&
      duplicated.length === 0 &&
      /*
       * An EXTRA grant fails the gate; a missing one does not.
       *
       * They are not symmetrical. An extra grant is authority nobody decided
       * to give, which is the shape of every privilege escalation — and it is
       * exactly what a retired role kept after the code took it away. A missing
       * grant is a shop that deliberately narrowed a role, which this command
       * has no business overruling.
       */
      grants.every((g) => g.extra.length === 0),
    inDatabase: seen.size,
    canonical: canonical.size,
    missing,
    unknown,
    duplicated,
    relabelled,
    grants,
  };
}

/**
 * What each role is actually granted, against what the codebase grants it.
 *
 * Matched by the role's KEY, never its display name. The first version matched
 * on the label, so a shop that renamed "Branch Manager" would have had its
 * drifted grant skipped and this gate would have reported green — exactly the
 * false reassurance it exists to prevent. `roles.key` is the `RoleKey` enum, the
 * same identifier `ROLE_PERMISSIONS` is keyed by.
 *
 * A key the codebase does not define is left alone rather than judged.
 */
async function verifyGrants(prisma: PrismaClient): Promise<GrantDrift[]> {
  const roles = await prisma.role.findMany({
    select: {
      key: true,
      name: true,
      rolePermissions: { select: { permission: { select: { key: true } } } },
    },
  });

  const drift: GrantDrift[] = [];
  for (const role of roles) {
    const roleKey = role.key as RoleKey;
    if (!Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, roleKey)) continue;

    const held = new Set(role.rolePermissions.map((rp) => rp.permission.key));
    const granted = new Set(ROLE_PERMISSIONS[roleKey]);

    const extra = [...held].filter((k) => !granted.has(k)).sort();
    const missing = [...granted].filter((k) => !held.has(k)).sort();
    if (extra.length || missing.length) drift.push({ role: role.name, roleKey, extra, missing });
  }
  return drift;
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

    const escalations = r.grants.filter((g) => g.extra.length);
    if (escalations.length) {
      console.log(`  EXTRA GRANTS (${escalations.length}) — authority the codebase does not give:`);
      for (const g of escalations) {
        console.log(`    ! ${g.role} (${g.roleKey}) holds: ${g.extra.join(', ')}`);
      }
      console.log('    Nothing was deleted. Remove the grant deliberately, or grant it in code.');
    }
    const narrowed = r.grants.filter((g) => g.missing.length && !g.extra.length);
    if (narrowed.length) {
      console.log(`  narrowed (${narrowed.length}, not a failure — a shop may mean this):`);
      for (const g of narrowed) console.log(`    ~ ${g.role} lacks: ${g.missing.join(', ')}`);
    }

    console.log(r.ok ? '  catalogue and grants complete ✓' : '  PERMISSION DRIFT — refusing');
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
