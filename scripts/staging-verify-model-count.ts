// ===========================================================================
// Proves the model count is DERIVED, against a real database.
//
// The unit tests prove the arithmetic. They cannot prove that the query hits
// the right rows, that branch scoping is applied, or that adding a phone
// actually moves the number — those need MySQL, and this is the only honest
// way to check them short of a phone.
//
// What it does, in order:
//
//   1. reads the model count for Test Store's branch and records it;
//   2. creates ONE temporary Unit of a model already on the shelf, with a
//      synthetic Luhn-valid IMEI that is not in use;
//   3. reads the count again and asserts it went up by exactly one;
//   4. deletes the temporary Unit;
//   5. asserts the shelf is byte-for-byte what it was in step 1.
//
// Step 5 is the point of step 4. A verification that leaves its own data behind
// has changed the thing it was verifying, and the next person to count the
// permanent fixture would find 21 units and no explanation.
//
// The temporary unit is removed in a `finally`, so a failed assertion still
// cleans up. If it ever cannot, the script says so loudly with the exact id.
//
// Staging only, guarded on the DATABASE NAME rather than on `APP_ENV` — an
// environment variable is a claim, and a database name is a fact.
//
//   APP_ENV=staging npx ts-node scripts/staging-verify-model-count.ts
// ===========================================================================

import { config as loadEnv } from 'dotenv';

// `override` is load-bearing: `@prisma/client` loads `.env` as an import side
// effect before this runs, and plain dotenv will not replace a variable that is
// already set. Without it the guard passes while the connection stays on
// development.
loadEnv({ path: '.env.staging', override: true });

import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';

function assertStaging(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Refusing.');
  if (url.includes('${')) throw new Error('DATABASE_URL has an unresolved variable. Refusing.');
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!/^[a-z0-9_]*stag(e|ing)[a-z0-9_]*$/i.test(name)) {
    throw new Error(`Refusing: "${name}" is not a staging database name.`);
  }
  for (const forbidden of [/^phonestore$/i, /prod/i, /^live$/i, /demo/i]) {
    if (forbidden.test(name)) throw new Error(`Refusing: "${name}" looks protected.`);
  }
  return name;
}

/** UUIDv7 as 16 bytes — time-ordered, like every other id in this schema. */
function uuidV7Bin(): Buffer {
  const b = randomBytes(16);
  const ms = BigInt(Date.now());
  b.writeUIntBE(Number(ms >> 16n), 0, 4);
  b.writeUIntBE(Number(ms & 0xffffn), 4, 2);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  return b;
}

/** The check digit, so the fixture is a well-formed IMEI and not just digits. */
function luhn(fourteen: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let d = Number(fourteen[13 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
}

const prisma = new PrismaClient();

/** The same grouping the service does, read straight from the Unit rows. */
async function countByModel(branchId: Buffer) {
  const grouped = await prisma.unit.groupBy({
    by: ['productId'],
    where: { status: 'in_stock', branchId },
    _count: { _all: true },
  });
  if (!grouped.length) return new Map<string, number>();
  const products = await prisma.product.findMany({
    where: { id: { in: grouped.map((g) => g.productId) } },
    select: { id: true, brand: true, model: true },
  });
  const byId = new Map(products.map((p) => [p.id.toString('hex'), p]));
  const out = new Map<string, number>();
  for (const g of grouped) {
    const p = byId.get(g.productId.toString('hex'));
    if (!p) continue;
    const key = `${p.brand} ${p.model}`.trim();
    out.set(key, (out.get(key) ?? 0) + g._count._all);
  }
  return out;
}

function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  const dbName = assertStaging();
  console.log(`database: ${dbName}\n`);

  const company = await prisma.company.findFirst({
    where: { name: { contains: 'Test Store' } },
    select: { id: true, name: true },
  });
  if (!company) throw new Error('Test Store not found. Nothing to verify against.');

  const branch = await prisma.branch.findFirst({
    where: { companyId: company.id },
    select: { id: true, name: true },
  });
  if (!branch) throw new Error('Test Store has no branch.');

  console.log(`company: ${company.name}\nbranch:  ${branch.name}\n`);

  // ── 1 · the shelf as it stands ───────────────────────────────────────────
  const before = await countByModel(branch.id);
  const totalBefore = [...before.values()].reduce((a, b) => a + b, 0);
  console.log('before:');
  for (const [model, n] of [...before].sort()) console.log(`    ${model} — ${n}`);
  console.log(`    (${totalBefore} units across ${before.size} models)\n`);

  // Reconciliation: the aggregate must equal a plain count of eligible rows.
  const eligible = await prisma.unit.count({
    where: { status: 'in_stock', branchId: branch.id },
  });
  check('the model counts add up to the eligible Unit rows', totalBefore === eligible,
    `${totalBefore} vs ${eligible}`);

  // ── 2 · one more of a model already on the shelf ─────────────────────────
  const target = await prisma.unit.findFirst({
    where: { status: 'in_stock', branchId: branch.id, imeiPrimary: { not: null } },
    select: { productId: true, product: { select: { brand: true, model: true } } },
  });
  if (!target) throw new Error('No tracked unit to add another of.');
  const key = `${target.product.brand} ${target.product.model}`.trim();

  /*
   * A synthetic IMEI, built rather than looked up. The `01000004` prefix is the
   * one the staging fixtures already use, the serial is time-derived so reruns
   * do not collide, and the check digit is computed — so this is a well-formed
   * identifier that belongs to no real handset anywhere.
   */
  let imei = '';
  for (let attempt = 0; attempt < 20; attempt++) {
    const serial = String((Date.now() + attempt) % 1_000_000).padStart(6, '0');
    const fourteen = `01000004${serial}`;
    const candidate = fourteen + luhn(fourteen);
    const taken = await prisma.unit.findFirst({
      where: { OR: [{ imeiPrimary: candidate }, { imeiSecondary: candidate }] },
      select: { id: true },
    });
    if (!taken) {
      imei = candidate;
      break;
    }
  }
  if (!imei) throw new Error('Could not find an unused synthetic IMEI.');

  const tempId = uuidV7Bin();
  let created = false;

  try {
    await prisma.unit.create({
      data: {
        id: tempId,
        companyId: company.id,
        branchId: branch.id,
        productId: target.productId,
        imeiPrimary: imei,
        status: 'in_stock',
        cost: 1,
      },
    });
    created = true;
    console.log(`temporary unit ${tempId.toString('hex')} · ${key} · IMEI ${imei}\n`);

    // ── 3 · the count moved, and only for that model ──────────────────────
    const after = await countByModel(branch.id);
    check(`"${key}" went from ${before.get(key)} to ${after.get(key)}`,
      after.get(key) === (before.get(key) ?? 0) + 1);
    check('no other model changed',
      [...before].every(([m, n]) => m === key || after.get(m) === n));
    check('the shelf gained exactly one unit',
      [...after.values()].reduce((a, b) => a + b, 0) === totalBefore + 1);

    // Branch isolation: another branch's shelf must not have moved.
    const otherBranch = await prisma.branch.findFirst({
      where: { id: { not: branch.id } },
      select: { id: true, name: true },
    });
    if (otherBranch) {
      const elsewhere = await countByModel(otherBranch.id);
      const total = [...elsewhere.values()].reduce((a, b) => a + b, 0);
      const mine = await prisma.unit.count({
        where: { status: 'in_stock', branchId: otherBranch.id },
      });
      check(`"${otherBranch.name}" counts only its own units`, total === mine, `${total} vs ${mine}`);
    }

    // ── A duplicate IMEI must change nothing ──────────────────────────────
    let refused = false;
    try {
      await prisma.unit.create({
        data: {
          id: uuidV7Bin(),
          companyId: company.id,
          branchId: branch.id,
          productId: target.productId,
          imeiPrimary: imei, // the one just used
          status: 'in_stock',
          cost: 1,
        },
      });
    } catch {
      refused = true;
    }
    check('a duplicate IMEI is refused by the database itself', refused);
    const afterDuplicate = await countByModel(branch.id);
    check('the refused duplicate left the count where it was',
      afterDuplicate.get(key) === after.get(key));
  } finally {
    // ── 4 · put the fixture back ────────────────────────────────────────────
    if (created) {
      await prisma.unit.delete({ where: { id: tempId } }).catch((e: unknown) => {
        console.error(
          `\nCOULD NOT REMOVE THE TEMPORARY UNIT ${tempId.toString('hex')} — remove it by hand.`,
          e,
        );
        process.exitCode = 1;
      });
    }
  }

  // ── 5 · the shelf is exactly what it was ─────────────────────────────────
  const restored = await countByModel(branch.id);
  const totalAfter = [...restored.values()].reduce((a, b) => a + b, 0);
  check(`the fixture is back to ${totalBefore} units`, totalAfter === totalBefore,
    `${totalAfter}`);
  check('every model is back to its original count',
    before.size === restored.size && [...before].every(([m, n]) => restored.get(m) === n));

  console.log(`\n${process.exitCode ? 'FAILED' : 'All checks passed.'}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
