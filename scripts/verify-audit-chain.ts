// ===========================================================================
// Verify the audit hash chain (docs/48 §8.1, migration 0085).
//
//   DATABASE_URL='mysql://phonestore_backup:…@host/phonestore' npx ts-node scripts/verify-audit-chain.ts
//   … --company <uuid>     one company only
//   … --json               machine-readable summary
//
// Read-only. Walks every company's audit rows in id order and, for each row,
// recomputes the hash with the SAME SQL expression the trigger used, then
// checks three things: the recomputed hash equals the stored one (the row's
// content is what was hashed), the row's prev_hash equals the previous row's
// entry_hash (no row was removed or reordered), and the chain head equals the
// last row (nothing was appended behind the head's back). Any break is
// reported with the company and the first offending row id, and the process
// exits 1 — this is meant to run from the backup host on a schedule and to
// alert.
//
// Any read-only identity can run it; the backup account is the natural one.
// ===========================================================================

import { config as loadEnv } from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';

loadEnv();
const prisma = new PrismaClient();

interface Row {
  id: bigint;
  company: string;
  prev_hash: string | null;
  entry_hash: string | null;
  recomputed: string;
}

const HEX = (b: Buffer) => b.toString('hex');
const uuidToBin = (uuid: string) => Buffer.from(uuid.replace(/-/g, ''), 'hex');

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const onlyCompany = args.includes('--company') ? args[args.indexOf('--company') + 1] : null;

  const companies = await prisma.company.findMany({
    where: onlyCompany ? { id: uuidToBin(onlyCompany) } : {},
    select: { id: true, name: true },
    orderBy: { id: 'asc' },
  });

  const heads = new Map(
    (await prisma.auditChainHead.findMany()).map((h) => [HEX(h.companyId), { lastHash: h.lastHash, entries: Number(h.entries) }]),
  );

  const report: { company: string; name: string; rows: number; problems: string[] }[] = [];
  let broken = 0;

  for (const company of companies) {
    const problems: string[] = [];
    const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT id, HEX(company_id) AS company, prev_hash, entry_hash,
             SHA2(CONCAT_WS('|', IFNULL(prev_hash, ''), HEX(company_id), IFNULL(HEX(branch_id), ''), IFNULL(HEX(user_id), ''),
                            entity_type, IFNULL(HEX(entity_id), ''), action,
                            IFNULL(CAST(\`before\` AS CHAR), ''), IFNULL(CAST(\`after\` AS CHAR), ''),
                            IFNULL(reason, ''), IFNULL(ip, ''), DATE_FORMAT(\`at\`, '%Y-%m-%d %H:%i:%s.%f')), 256) AS recomputed
      FROM audit_logs WHERE company_id = ${company.id} ORDER BY id ASC`);

    let prev = '';
    for (const r of rows) {
      if (!r.entry_hash) {
        problems.push(`row ${r.id}: unchained (no entry_hash) — the seal of 0085 did not cover it`);
        break;
      }
      if (r.prev_hash !== prev) {
        problems.push(`row ${r.id}: prev_hash does not match the previous row — a row was removed, reordered or inserted behind the chain`);
        break;
      }
      if (r.recomputed !== r.entry_hash) {
        problems.push(`row ${r.id}: content does not match its hash — the row was modified`);
        break;
      }
      prev = r.entry_hash;
    }
    const head = heads.get(HEX(company.id));
    if (rows.length > 0 && problems.length === 0) {
      if (!head) problems.push('no chain head for a company with audit rows');
      else if (head.lastHash !== prev) problems.push(`chain head (${head.lastHash.slice(0, 12)}…) does not match the last row (${prev.slice(0, 12)}…)`);
      else if (head.entries !== rows.length) problems.push(`chain head counts ${head.entries} entries, ${rows.length} rows exist`);
    }
    if (problems.length > 0) broken++;
    report.push({ company: HEX(company.id), name: company.name, rows: rows.length, problems });
  }

  if (json) {
    console.log(JSON.stringify({ companies: report.length, broken, report }, null, 2));
  } else {
    for (const r of report) {
      console.log(`${r.problems.length === 0 ? 'OK  ' : 'FAIL'} ${r.name} (${r.company}): ${r.rows} rows${r.problems.length ? '\n     ' + r.problems.join('\n     ') : ''}`);
    }
    console.log(`\n${report.length} companies checked, ${broken} with a broken chain`);
  }
  process.exit(broken === 0 ? 0 : 1);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(2);
  })
  .finally(() => prisma.$disconnect());
