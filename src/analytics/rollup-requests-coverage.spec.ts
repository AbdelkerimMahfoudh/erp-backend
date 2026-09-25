import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { binToUuid } from '../common/utils/uuid.util';
import {
  DEST,
  DEST_MANAGER,
  emptyDb,
  EMPLOYEE,
  EMPLOYEE_PERMISSIONS,
  MANAGER,
  MANAGER_PERMISSIONS,
  seedBranchesAndPeople,
  seedUnit,
  SOURCE,
} from '../transfers/__testing__/transfer-db';
import { makeHarness } from '../transfers/__testing__/harness';

/**
 * Every transaction that changes derived figures writes its recompute request INSIDE
 * itself (0081, docs/52). The rollup reads sales and their lines, confirmed expenses,
 * approved return reversals, confirmed refund payouts and approved corrections; the
 * branch snapshots read stock. These are all the writers that move them:
 *
 *   sale recorded            daily (sale's business date) + branch
 *   expense confirmed        daily (confirmation day, or a fixed expense's due date)
 *   return approved          daily (approval day)
 *   refund payout confirmed  daily (confirmation day)
 *   correction approved      daily (correction day) + branch when goods moved
 *   purchase received        branch
 *   transfer shipped/received branch, for both ends
 *
 * Read from the source, like the other reconciliation specs, plus the transfer path
 * end to end through the real service and its database double.
 */

const SRC = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const between = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  const b = s.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`markers not found: ${from} … ${to}`);
  return s.slice(a, b);
};

/** The request sits after the transaction opens and before the code that runs after its commit. */
function insideTransaction(body: string, request: RegExp, afterCommit: string) {
  const open = body.indexOf('$transaction(');
  const req = body.search(request);
  const after = body.indexOf(afterCommit, req);
  expect(open).toBeGreaterThan(-1);
  expect(req).toBeGreaterThan(open);
  expect(after).toBeGreaterThan(req);
}

describe('every transaction that changes the figures requests its recompute inside itself', () => {
  it('a sale: its business day and its branch, before the event that runs after commit', () => {
    const create = code(read('sales', 'sales.service.ts'));
    insideTransaction(create, /await requestRollupTx\(tx as never, \[/, "this.events.emit('sale.recorded'");
    expect(create).toMatch(/\{ kind: 'daily', companyId, branchId, day: businessDate, cause: 'sale', sourceId: saleId \}/);
    expect(create).toMatch(/\{ kind: 'branch', companyId, branchId, cause: 'sale', sourceId: saleId \}/);
  });

  it('an expense confirmed: the day it lands on, in one transaction with the confirmation', () => {
    const confirm = between(code(read('expenses', 'expenses.service.ts')), 'async confirm(', 'async reject(');
    insideTransaction(confirm, /await requestRollupTx\(tx as never, \[/, 'if (moved.count === 0)');
    expect(confirm).toMatch(/day: landsOn, cause: 'expense_confirmed'/);
    expect(confirm).toMatch(/void this\.rollups\.processNow\(\);/);
  });

  it('a return approved and a refund confirmed: their own days, worked after commit without failing the request', () => {
    const svc = code(read('returns', 'returns.service.ts'));
    const approve = between(svc, 'async approve(', 'async reject(');
    insideTransaction(approve, /await requestRollupTx\(tx as never, \[/, 'await this.rollups.processNow()');
    expect(approve).toMatch(/day: approvalDay, cause: 'return_approved'/);
    const confirm = svc.slice(svc.indexOf("cause: 'refund_confirmed'") - 2000);
    insideTransaction(confirm, /await requestRollupTx\(tx as never, \[/, 'await this.rollups.processNow()');
    expect(svc).toMatch(/day: confirmationDay, cause: 'refund_confirmed'/);
  });

  it('a correction approved: its day, and the branch when goods moved, last in its locked transaction', () => {
    const approve = between(code(read('corrections', 'corrections.service.ts')), 'async approve(', 'async reject(');
    insideTransaction(approve, /await requestRollupTx\(tx as never, \[/, 'await this.queue.processNow()');
    expect(approve).toMatch(/cause: 'correction_approved', sourceId: correction\.id \}/);
    expect(approve).toMatch(/\.\.\.\(stockChanged \? \[\{ kind: 'branch' as const/);
  });

  it('a purchase received: the branch, inside the purchase transaction', () => {
    const svc = code(read('purchasing', 'purchasing.service.ts'));
    insideTransaction(svc, /await requestRollupTx\(tx as never, \[\{ kind: 'branch', companyId, branchId, cause: 'purchase_received'/, 'return pid;');
  });

  it('nothing recomputes on its own any more — only the worker, and the close before it commits', () => {
    const callers: string[] = [];
    for (const [dir, file] of [
      ['sales', 'sales.service.ts'],
      ['expenses', 'expenses.service.ts'],
      ['returns', 'returns.service.ts'],
      ['corrections', 'corrections.service.ts'],
      ['purchasing', 'purchasing.service.ts'],
      ['transfers', 'transfers.service.ts'],
      ['closing', 'closing.service.ts'],
      ['analytics', 'rollup.listener.ts'],
    ]) {
      const src = code(read(dir, file));
      if (/recomputeDaily\(|refreshBranch\(|enqueueDailyRecompute|enqueueBranchRefresh/.test(src)) callers.push(file);
    }
    expect(callers).toEqual(['closing.service.ts']);
    // The close recomputes the day it is about to freeze, before its own transaction: a failure there refuses the close.
    expect(code(read('closing', 'closing.service.ts'))).toMatch(/await this\.rollups\.recomputeDaily\(companyId, branchId, day\);\s+const rollup = await this\.db\.dailyRollup\.findUnique/);
  });
});

describe('working a request twice cannot count anything twice', () => {
  const rollup = code(read('analytics', 'rollup.service.ts'));

  it('the rollup rebuilds a branch-day from its records — it never adds to a stored total', () => {
    expect(rollup).not.toMatch(/increment/);
    expect(rollup).toMatch(/this\.prisma\.dailyRollup\.upsert\(\{\s*where: \{ branchId_day: \{ branchId, day: dayDate \} \}/);
    // Product facts: deleted and written again, never patched.
    expect(rollup.indexOf('productDailyRollup.deleteMany')).toBeLessThan(rollup.indexOf('productDailyRollup.createMany'));
  });

  it('the worker claims what it has seen, then recomputes, then marks exactly those rows done', () => {
    const worker = code(read('analytics', 'rollup-outbox.service.ts'));
    const claim = worker.indexOf("data: { status: 'processing', claimToken: token");
    const recompute = worker.indexOf('await this.rollups.recomputeDaily(');
    const done = worker.indexOf("where: { claimToken: token, status: 'processing' },\n        data: { status: 'done'");
    expect(claim).toBeGreaterThan(-1);
    expect(recompute).toBeGreaterThan(claim);
    expect(done).toBeGreaterThan(recompute);
  });

  it('0081 creates the table the requests live in, with the day required exactly for a daily request', () => {
    const sql = readFileSync(join(SRC, '..', 'prisma', 'migrations', '0081_rollup_requests', 'migration.sql'), 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS `rollup_requests`/);
    expect(sql).toMatch(/CONSTRAINT `ck_rr_day`\s+CHECK \(\(`kind` = 'daily'\) = \(`day` IS NOT NULL\)\)/);
    expect(sql).toMatch(/`status`\s+ENUM\('pending', 'processing', 'done'\)/);
  });
});

describe('a transfer requests both ends, inside the shipment and the receipt', () => {
  it('shipped: the source and the destination; received: both again — one request each, all in the transaction', async () => {
    const db = emptyDb();
    seedBranchesAndPeople(db);
    const h = makeHarness(db, { userId: EMPLOYEE, branchId: SOURCE, permissions: EMPLOYEE_PERMISSIONS });
    const unit = seedUnit(db, { branchId: SOURCE });
    const t = (await h.service.create({ clientUuid: randomUUID(), toBranchId: binToUuid(DEST), identifiers: [unit.imeiPrimary as string] })) as { id: string; version: number };
    h.act({ userId: MANAGER, branchId: SOURCE, permissions: MANAGER_PERMISSIONS });
    await h.service.approve(t.id, { expectedVersion: t.version });
    expect(db.rollupRequest).toHaveLength(0);

    h.act({ userId: EMPLOYEE, branchId: SOURCE, permissions: EMPLOYEE_PERMISSIONS });
    await h.service.ship(t.id, { expectedVersion: t.version + 1 });
    const shipped = db.rollupRequest.map((r) => [r.kind, (r.branchId as Buffer).equals(SOURCE) ? 'source' : 'destination', r.cause]);
    expect(shipped).toEqual([
      ['branch', 'source', 'transfer_shipped'],
      ['branch', 'destination', 'transfer_shipped'],
    ]);

    h.act({ userId: DEST_MANAGER, branchId: DEST, permissions: MANAGER_PERMISSIONS });
    await h.service.receiveConfirm(t.id, { identifiers: [unit.imeiPrimary as string], expectedVersion: t.version + 2 });
    expect(db.rollupRequest.slice(2).map((r) => r.cause)).toEqual(['transfer_received', 'transfer_received']);
    expect(db.rollupRequest.every((r) => r.day === null)).toBe(true);
  });
});
