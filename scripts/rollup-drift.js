const path = require('node:path');
const fs = require('node:fs');
// Which days' derived figures are stale, exactly — without writing to live (docs/52 §5).
//
// A rollup row is stale when recomputing it from its source records would change it.
// The only exact way to know is to run the production recompute, so this does — on a
// COPY restored from a fresh backup of live — and compares every column of every
// branch-day, and every product fact, with what live stores. Live is only read.
//
// Usage (requires a current build: npm run build):
//   COPY=prisma_verify_drift node scripts/rollup-drift.js
//     LIVE defaults to phonestore. COPY must be a prisma_* database restored from a
//     backup of LIVE taken with no activity since; the script refuses otherwise.
//
// It prints the stale branch-days, each changed figure (live → recomputed), whether
// the day is closed, and the exact SQL that would ask the running API to recompute
// them through the durable request table. It never runs that SQL.

const BACKEND = path.resolve(__dirname, '..');
const LIVE = process.env.LIVE || 'phonestore';
const COPY = process.env.COPY || '';
if (!/^prisma_[a-z0-9_]+$/.test(COPY)) {
  console.error('COPY must name a prisma_* database restored from a backup of LIVE');
  process.exit(2);
}

const { PrismaClient } = require(path.join(BACKEND, 'node_modules/@prisma/client'));
const { RollupService } = require(path.join(BACKEND, 'dist/src/analytics/rollup.service.js'));

const env = {};
for (const line of fs.readFileSync(path.join(BACKEND, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const urlFor = (db) => {
  const u = new URL(env.DATABASE_URL);
  u.pathname = '/' + db;
  return u.toString();
};

/** Columns that are bookkeeping, not figures. */
const NOT_FIGURES = new Set(['id', 'company_id', 'branch_id', 'day', 'refreshed_at', 'created_at', 'updated_at']);

/** Every branch-day that has a source record, or a stored rollup row. */
const BRANCH_DAYS = `
  SELECT HEX(company_id) AS company, HEX(branch_id) AS branch, DATE_FORMAT(d, '%Y-%m-%d') AS day FROM (
    SELECT company_id, branch_id, business_date AS d FROM sales
    UNION SELECT company_id, branch_id, IF(expense_class = 'fixed', due_date, confirmation_date) FROM expenses WHERE status = 'confirmed'
    UNION SELECT company_id, branch_id, approval_date FROM return_reversals
    UNION SELECT company_id, branch_id, confirmation_date FROM refund_payouts WHERE status = 'confirmed'
    UNION SELECT company_id, branch_id, correction_date FROM financial_corrections WHERE status = 'approved'
    UNION SELECT company_id, branch_id, day FROM daily_rollups
  ) x WHERE d IS NOT NULL ORDER BY d, branch`;

/** The copy must be the live database as it is now — the same records, row for row. */
const FINGERPRINT = `
  SELECT (SELECT COUNT(*) FROM sales) AS sales, (SELECT COUNT(*) FROM sale_items) AS sale_items,
         (SELECT COUNT(*) FROM expenses) AS expenses, (SELECT COUNT(*) FROM return_reversals) AS returns,
         (SELECT COUNT(*) FROM refund_payouts) AS payouts, (SELECT COUNT(*) FROM financial_corrections) AS corrections,
         (SELECT COUNT(*) FROM daily_rollups) AS rollups, (SELECT COUNT(*) FROM audit_logs) AS audit,
         (SELECT BIT_XOR(CRC32(CONCAT(HEX(id), total, business_date))) FROM sales) AS sales_sum,
         (SELECT BIT_XOR(CRC32(CONCAT(HEX(id), revenue, net_profit, refreshed_at))) FROM daily_rollups) AS rollups_sum`;

const text = (v) => (v == null ? 'NULL' : typeof v === 'object' && 'toFixed' in v ? v.toFixed(2) : String(v));

(async () => {
  const live = new PrismaClient({ datasources: { db: { url: urlFor(LIVE) } } });
  const copy = new PrismaClient({ datasources: { db: { url: urlFor(COPY) } } });
  try {
    const [a] = await live.$queryRawUnsafe(FINGERPRINT);
    const [b] = await copy.$queryRawUnsafe(FINGERPRINT);
    if (JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? String(v) : v)) !== JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? String(v) : v))) {
      console.error(`${COPY} is not a fresh copy of ${LIVE}: restore a new backup and run again.`);
      process.exit(3);
    }
    console.log(`live: ${LIVE} (read only)   copy: ${COPY} (recomputed)\n`);

    const days = await copy.$queryRawUnsafe(BRANCH_DAYS);
    const service = new RollupService(copy);
    for (const d of days) await service.recomputeDaily(Buffer.from(d.company, 'hex'), Buffer.from(d.branch, 'hex'), d.day);

    const cols = (await live.$queryRawUnsafe(
      `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'daily_rollups' ORDER BY ordinal_position`,
    )).map((r) => r.c).filter((c) => !NOT_FIGURES.has(c));
    const rowSql = `SELECT ${cols.map((c) => `\`${c}\``).join(', ')} FROM daily_rollups WHERE branch_id = UNHEX(?) AND day = ?`;
    const productSql = `SELECT HEX(product_id) AS product, qty_sold, revenue, cogs FROM product_daily_rollups WHERE branch_id = UNHEX(?) AND day = ? ORDER BY product`;

    const stale = [];
    for (const d of days) {
      const [l] = await live.$queryRawUnsafe(rowSql, d.branch, d.day);
      const [c] = await copy.$queryRawUnsafe(rowSql, d.branch, d.day);
      const changes = [];
      if (!l) {
        const figures = cols.filter((col) => Number(c[col]) !== 0).map((col) => `${col} ${text(c[col])}`);
        changes.push(`no stored row — recomputed: ${figures.join(', ') || 'all zero'}`);
      } else for (const col of cols) if (text(l[col]) !== text(c[col])) changes.push(`${col} ${text(l[col])} → ${text(c[col])}`);
      const lp = JSON.stringify((await live.$queryRawUnsafe(productSql, d.branch, d.day)).map((r) => [r.product, text(r.qty_sold), text(r.revenue), text(r.cogs)]));
      const cp = JSON.stringify((await copy.$queryRawUnsafe(productSql, d.branch, d.day)).map((r) => [r.product, text(r.qty_sold), text(r.revenue), text(r.cogs)]));
      if (lp !== cp) changes.push('product facts differ');
      if (changes.length === 0) continue;
      const [closing] = await live.$queryRawUnsafe(
        `SELECT status, is_locked FROM daily_closings WHERE branch_id = UNHEX(?) AND closing_date = ?`, d.branch, d.day);
      stale.push({ ...d, closed: closing ? `${closing.status}${closing.is_locked ? ' (locked)' : ''}` : 'no closing', changes });
    }

    console.log(`${days.length} branch-day(s) with records or a stored row; ${stale.length} stale:\n`);
    for (const s of stale) {
      console.log(`  ${s.day}  branch ${s.branch}  [${s.closed}]`);
      for (const c of s.changes) console.log(`      ${c}`);
    }
    if (stale.length > 0) {
      console.log('\nTo repair (NOT run by this script; needs approval, a docs/22 backup, and the API running on 0081):');
      console.log('  INSERT INTO rollup_requests (id, company_id, branch_id, kind, day, cause, status, attempts, requested_at, next_attempt_at) VALUES');
      console.log(stale.map((s) => `    (UUID_TO_BIN(UUID(), 1), UNHEX('${s.company}'), UNHEX('${s.branch}'), 'daily', '${s.day}', 'repair_drift', 'pending', 0, NOW(6), NOW(6))`).join(',\n') + ';');
    }
    console.log(`\nlive was only read; ${COPY} now holds the recomputed figures.`);
  } finally {
    await live.$disconnect();
    await copy.$disconnect();
  }
})().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
