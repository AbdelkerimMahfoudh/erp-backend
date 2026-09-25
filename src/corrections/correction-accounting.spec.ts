import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CorrectionsController } from './corrections.controller';
import { REQUIRE_PERMISSIONS_KEY } from '../rbac/require-permissions.decorator';
import { ROLE_PERMISSIONS } from '../../prisma/seed-data/permissions';

/**
 * What a correction is allowed to touch, and who may do it (Milestone B).
 *
 * These read the source rather than running a server, for the same reason the
 * reconciliation specs do: the properties being protected are structural, and a
 * structural property is best asserted where it is written.
 */

const SRC = __dirname;
const service = readFileSync(join(SRC, 'corrections.service.ts'), 'utf8');
const sql = readFileSync(join(SRC, 'correction-sql.ts'), 'utf8');
const migration = readFileSync(
  join(SRC, '..', '..', 'prisma', 'migrations', '0040_financial_correction', 'migration.sql'),
  'utf8',
);
const returns = readFileSync(join(SRC, '..', 'returns', 'returns.service.ts'), 'utf8');
const rollup = readFileSync(join(SRC, '..', 'analytics', 'rollup.service.ts'), 'utf8');
const closing = readFileSync(join(SRC, '..', 'closing', 'closing.service.ts'), 'utf8');

/** Strip comments, so an assertion cannot pass by matching its own prose. */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('permissions', () => {
  it('requesting needs financial.correction.request', () => {
    expect(
      Reflect.getMetadata(REQUIRE_PERMISSIONS_KEY, CorrectionsController.prototype.request),
    ).toEqual(['financial.correction.request']);
  });

  it('approving needs financial.correction.approve — a different key', () => {
    expect(
      Reflect.getMetadata(REQUIRE_PERMISSIONS_KEY, CorrectionsController.prototype.approve),
    ).toEqual(['financial.correction.approve']);
  });

  it('rejecting needs the SAME authority as approving', () => {
    // Rejecting is a decision on somebody else's request; a manager who could
    // reject could bury a correction they did not want reviewed.
    expect(
      Reflect.getMetadata(REQUIRE_PERMISSIONS_KEY, CorrectionsController.prototype.reject),
    ).toEqual(['financial.correction.approve']);
  });

  it('a Store Manager may request but NEVER approve', () => {
    expect(ROLE_PERMISSIONS.store_manager).toContain('financial.correction.request');
    expect(ROLE_PERMISSIONS.store_manager).not.toContain('financial.correction.approve');
  });

  it('a Store Employee holds neither', () => {
    // The person who reported a payment must not be able to open the process
    // that unwinds it.
    expect(ROLE_PERMISSIONS.store_employee).not.toContain('financial.correction.request');
    expect(ROLE_PERMISSIONS.store_employee).not.toContain('financial.correction.approve');
  });

  it('the Owner holds both', () => {
    expect(ROLE_PERMISSIONS.owner).toContain('financial.correction.request');
    expect(ROLE_PERMISSIONS.owner).toContain('financial.correction.approve');
  });

  it('the migration grants exactly that, so a deploy matches the seed', () => {
    expect(migration).toMatch(/'financial\.correction\.request'[\s\S]{0,400}?'owner', 'store_manager'/);
    expect(migration).toMatch(/'financial\.correction\.approve'[\s\S]{0,400}?r\.`key` = 'owner'/);
  });
});

describe('the original transaction is never rewritten', () => {
  /**
   * The core safety property. If any of these ever appear, the correction has
   * stopped being append-only and has started editing settled money.
   */
  /**
   * The payout DOES take one write, and this pins exactly which.
   *
   * `0041` added `correctedById`, a back-reference set at approval so a
   * replacement payout can exist while "one live payout per return" stays a
   * database guarantee. It is a link, not a financial edit — and this test is
   * what stops that distinction eroding into a general licence to update the
   * payout.
   */
  it('writes ONLY the supersession back-reference onto the payout', () => {
    const c = code(service);
    const payoutWrite = c.slice(c.indexOf('refundPayout.updateMany'));
    const dataBlock = payoutWrite.slice(payoutWrite.indexOf('data:'), payoutWrite.indexOf('});'));
    expect(dataBlock).toMatch(/correctedById: correction\.id/);
    // Not one financial field among them.
    for (const field of [
      'status',
      'reportedAmount',
      'netAmountDue',
      'method',
      'confirmedAt',
      'confirmedById',
      'accountLabelSnapshot',
    ]) {
      expect(dataBlock).not.toMatch(new RegExp(`${field}\\s*:`));
    }
  });

  it('never touches a supplier settlement at all', () => {
    // Settlements need no supersession marker: a supplier may always have
    // several, so nothing blocks a replacement there.
    expect(code(service)).not.toMatch(/supplierSettlement\.(update|create|delete)/);
  });

  it('deletes nothing, ever', () => {
    const c = code(service);
    expect(c).not.toMatch(/\.delete\(/);
    expect(c).not.toMatch(/deleteMany/);
  });

  it('creates rows only in financialCorrection', () => {
    const creates = code(service).match(/this\.db\.(\w+)\.(create|upsert)/g) ?? [];
    for (const w of creates) expect(w).toMatch(/financialCorrection/);
  });

  it('the supersession write is guarded, so it cannot fire twice', () => {
    expect(code(service)).toMatch(/correctedById: null/);
  });

  it('the correction row itself is append-only in the database', () => {
    expect(migration).toMatch(/financial_corrections_block_delete/);
    expect(migration).toMatch(/BEFORE DELETE ON `financial_corrections`/);
  });
});

describe('the liability comes back exactly once', () => {
  /**
   * It is restored by DERIVATION, not by decrementing anything — which is what
   * makes "exactly once" impossible to get wrong.
   */
  it('every live-liability query excludes a corrected payment', () => {
    // Supplier liabilities left the launch app with the Suppliers module (first
    // release); the refund liability is the one still live.
    expect(returns).toMatch(/payoutNotCorrected\('p'\)/);
  });

  it('the exclusion is written once, not inlined per call site', () => {
    expect(sql).toMatch(/export function settlementNotCorrected/);
    expect(sql).toMatch(/export function payoutNotCorrected/);
    // No hand-rolled copies anywhere else.
    expect(returns).not.toMatch(/NOT EXISTS[\s\S]{0,80}financial_corrections/);
  });

  it('the database refuses a second approved correction per target', () => {
    expect(migration).toMatch(/active_target_payout_id/);
    expect(migration).toMatch(/active_target_settlement_id/);
    expect(migration).toMatch(/UNIQUE KEY `uq_fc_active_payout`/);
    expect(migration).toMatch(/UNIQUE KEY `uq_fc_active_settlement`/);
  });
});

describe('the original day stays exactly as it was', () => {
  /**
   * A correction is a movement on the CORRECTION day. The day the payment
   * happened keeps its figures, and its closing stays locked.
   */
  it('the compensating movement is keyed on correction_date', () => {
    expect(rollup).toMatch(/FROM financial_corrections[\s\S]{0,200}correction_date = \$\{day\}/);
  });

  it('the per-day refund and supplier queries are NOT filtered by corrections', () => {
    // Filtering both the original day and the correction day would remove the
    // money twice. Only live liability excludes; history does not.
    const refundBlock = rollup.slice(
      rollup.indexOf('FROM refund_payouts'),
      rollup.indexOf('FROM financial_corrections'),
    );
    expect(refundBlock).not.toMatch(/financial_corrections/);
  });

  it('approval refuses a locked day rather than reopening it', () => {
    expect(code(service)).toMatch(/assertDayOpen\(closing, day\)/);
  });

  /**
   * The live test found this missing: without the recompute the correction
   * restored the liability and left the till reporting a shortage that no
   * longer existed, because the compensating movement never reached the day's
   * figures at all.
   */
  it('recomputes the correction day, or the movement reaches nothing', () => {
    // `[^)]*` would stop at the `)` inside `companyId()`.
    expect(code(service)).toMatch(/rollups\.recomputeDaily\(.*correction\.branchId, day\)/);
  });

  it('the correction day is today, never the payment’s day', () => {
    // 0076: the paying branch's business date, from the one service every writer uses.
    expect(code(service)).toMatch(/const day = await this\.businessDay\.today\(correction\.branchId\)/);
    expect(code(service)).toMatch(/correctionDate,/);
  });
});

describe('a correction moves cash and liability only', () => {
  /**
   * 0079 widened what an approval may write, and these pin exactly how far: the
   * record being corrected is never created, edited or deleted — a sale, a payment,
   * an expense, a purchase, a purchase payment, a return. What follows the
   * correction is written in its own narrow terms, each asserted below.
   */
  it('creates no sale, payment, expense, purchase or return', () => {
    const c = code(service);
    expect(c).not.toMatch(/\.(sale|payment|expense|purchase|supplierPayment|returnReversal|refundPayout|saleItem)\.(create|createMany|upsert)\(/);
  });

  it('never edits the corrected record itself', () => {
    const c = code(service);
    expect(c).not.toMatch(/\.(payment|expense|purchase|supplierPayment|returnReversal)\.(update|updateMany|upsert)\(/);
  });

  it('writes a sale only in its receivable caches — never its lines, totals or payments', () => {
    const c = code(service);
    const writes = c.match(/tx\.sale\.update\(\{[\s\S]*?\}\);/g) ?? [];
    expect(writes).toHaveLength(1);
    const data = writes[0]!.slice(writes[0]!.indexOf('data:'));
    expect([...data.matchAll(/(\w+):/g)].map((m) => m[1]).filter((k) => k !== 'data')).toEqual(['amountPaid', 'balanceDue', 'payStatus']);
  });

  it('writes a sale line only to release its phone from sold-once, once', () => {
    const c = code(service);
    const writes = c.match(/tx\.saleItem\.updateMany\(\{[\s\S]*?\}\);/g) ?? [];
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/releasedByCorrectionId: null/);
    expect(writes[0]).toMatch(/data: \{ releasedByCorrectionId: correctionId \}/);
  });

  it('moves a phone only between the two states a correction allows, guarded on where it was', () => {
    const c = code(service);
    const writes = c.match(/tx\.unit\.updateMany\(\{[\s\S]*?\}\);/g) ?? [];
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/where: \{ id: u\.id, status: u\.from \}/);
    expect(writes[0]).not.toMatch(/cost|productId|imei|serial|branchId/);
  });

  it('writes its money only as legs, inside the approval', () => {
    const c = code(service);
    expect(c).toMatch(/tx\.financialCorrectionLeg\.createMany/);
    expect(c).not.toMatch(/this\.db\.financialCorrectionLeg/);
  });

  it('the correction rollup component carries no profit figure', () => {
    const block = rollup.slice(
      rollup.indexOf('FROM financial_corrections') - 700,
      rollup.indexOf('FROM financial_corrections') + 400,
    );
    expect(block).not.toMatch(/grossProfit|netProfit/);
  });

  it('expected cash ADDS corrected cash, and only once', () => {
    expect(closing).toMatch(/\+ correctedCash/);
    expect((closing.match(/\+ correctedCash/g) ?? []).length).toBe(1);
  });

  it('only the cash part reaches the till — an account transfer never did', () => {
    expect(closing).toMatch(/correctionsCash/);
  });
});

describe('concurrency and input handling', () => {
  it('approval is guarded on version AND status, so one owner wins', () => {
    const approve = service.slice(service.indexOf('async approve('), service.indexOf('async reject('));
    expect(approve).toMatch(/updateMany/);
    expect(approve).toMatch(/version: dto\.expectedVersion/);
    expect(approve).toMatch(/status: 'requested'/);
    expect(approve).toMatch(/refresh_required/);
  });

  it('a malformed id is a 404, not a 500', () => {
    // Shipped as a real defect twice already — sales (I1) and suppliers (J1).
    expect(code(service)).toMatch(/isUuid\(idStr\)/);
  });

  it('the amount is copied from the target, never taken from the caller', () => {
    const dto = readFileSync(join(SRC, 'dto', 'correction.dto.ts'), 'utf8');
    expect(dto).not.toMatch(/amount!?:/);
    expect(code(service)).toMatch(/amount: target!\.amount/);
  });

  it('the compensating movement posts to the branch that PAID', () => {
    // Not the caller's active branch: an owner may be standing elsewhere.
    expect(code(service)).toMatch(/branchId: target!\.branchId/);
  });
});
