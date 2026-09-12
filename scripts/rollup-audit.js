const path = require('node:path');
// Rollup drift: the exact affected scope, and the repair, proved on a copy.
//
// Runs the REAL production recompute (`RollupService.recomputeDaily` from the
// compiled build) so the procedure proposed for live is the one tested here —
// not a hand-written UPDATE that happens to produce the same numbers.
//
// Usage:
//   Requires a current build (npm run build): it runs dist/src/analytics/rollup.service.js.
//   node scripts/rollup-audit.js                 → audit only (default DB: prisma_verify_optional)
//   DB=<name> node scripts/rollup-audit.js --repair → audit, recompute drifted rows, audit again
//   DB=phonestore node scripts/rollup-audit.js   → audit LIVE read-only (never repairs
//                                          unless --repair is also given)

const BACKEND = path.resolve(__dirname, '..');
const DB = process.env.DB || 'prisma_verify_optional';
const REPAIR = process.argv.includes('--repair');

const { PrismaClient } = require(path.join(BACKEND, 'node_modules/@prisma/client'));
const { RollupService } = require(path.join(BACKEND, 'dist/src/analytics/rollup.service.js'));

const num = (v) => (v == null ? 0 : Number(v));
const money = (v) => num(v).toFixed(2);

(async () => {
  // Read the migrator URL from backend/.env and swap ONLY the database name.
  const fs = require('node:fs');
  const env = {};
  for (const line of fs.readFileSync(path.join(BACKEND, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  const url = new URL(env.DATABASE_URL);
  url.pathname = '/' + DB;
  const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });

  console.log(`database: ${DB}   mode: ${REPAIR ? 'AUDIT + REPAIR' : 'AUDIT ONLY (read-only)'}\n`);

  /** Every rollup row, beside what the source ledger actually supports. */
  const audit = async () =>
    prisma.$queryRawUnsafe(`
      SELECT HEX(r.company_id) AS company,
             HEX(r.branch_id)  AS branch,
             DATE_FORMAT(r.day, '%Y-%m-%d') AS day,
             r.revenue      AS rollup_revenue,
             r.cogs         AS rollup_cogs,
             r.net_profit   AS rollup_net,
             r.sales_count  AS rollup_sales,
             COALESCE((SELECT SUM(si.price * si.quantity - si.discount)
                         FROM sale_items si JOIN sales s ON s.id = si.sale_id
                        WHERE si.voided = 0 AND DATE(s.sold_at) = r.day
                          AND s.branch_id = r.branch_id), 0) AS actual_revenue,
             COALESCE((SELECT SUM(si.cost * si.quantity)
                         FROM sale_items si JOIN sales s ON s.id = si.sale_id
                        WHERE si.voided = 0 AND DATE(s.sold_at) = r.day
                          AND s.branch_id = r.branch_id), 0) AS actual_cogs,
             COALESCE((SELECT COUNT(DISTINCT s.id)
                         FROM sales s
                        WHERE DATE(s.sold_at) = r.day AND s.branch_id = r.branch_id), 0) AS actual_sales
        FROM daily_rollups r
       ORDER BY r.day`);

  const show = (rows, title) => {
    console.log(title);
    console.log('  day         | rollup revenue | actual revenue | rollup net  | sales r/a | verdict');
    for (const r of rows) {
      const drift = money(r.rollup_revenue) !== money(r.actual_revenue);
      console.log(
        `  ${r.day}  | ${money(r.rollup_revenue).padStart(14)} | ${money(r.actual_revenue).padStart(14)} | ` +
          `${money(r.rollup_net).padStart(11)} | ${String(num(r.rollup_sales))}/${String(num(r.actual_sales))}`.padEnd(12) +
          ` | ${drift ? 'DRIFT' : 'ok'}`,
      );
    }
    console.log('');
  };

  const before = await audit();
  show(before, 'BEFORE:');

  const drifted = before.filter((r) => money(r.rollup_revenue) !== money(r.actual_revenue));
  console.log(`affected scope: ${drifted.length} branch-day row(s)`);
  for (const r of drifted) {
    console.log(
      `  company ${r.company} branch ${r.branch} day ${r.day}: ` +
        `revenue ${money(r.rollup_revenue)} → ${money(r.actual_revenue)}, ` +
        `net ${money(r.rollup_net)} → (recomputed), sales ${num(r.rollup_sales)} → ${num(r.actual_sales)}`,
    );
  }
  const totalBefore = before.reduce((a, r) => a + num(r.rollup_revenue), 0);
  const totalActual = before.reduce((a, r) => a + num(r.actual_revenue), 0);
  console.log(`\ntotals across all rollup days: rollup ${totalBefore.toFixed(2)} vs ledger ${totalActual.toFixed(2)} ` +
    `(overstated by ${(totalBefore - totalActual).toFixed(2)})\n`);

  if (!REPAIR) {
    console.log('audit only — nothing was written.');
    await prisma.$disconnect();
    return;
  }

  // The repair: the production recompute, one affected branch-day at a time.
  const service = new RollupService(prisma);
  for (const r of drifted) {
    const companyId = Buffer.from(r.company, 'hex');
    const branchId = Buffer.from(r.branch, 'hex');
    await service.recomputeDaily(companyId, branchId, r.day);
    console.log(`recomputed ${r.day}`);
  }

  const after = await audit();
  console.log('');
  show(after, 'AFTER:');
  const stillDrifted = after.filter((r) => money(r.rollup_revenue) !== money(r.actual_revenue));
  console.log(stillDrifted.length === 0
    ? 'every rollup row now matches the source ledger.'
    : `STILL DRIFTED: ${stillDrifted.length} row(s)`);

  await prisma.$disconnect();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
