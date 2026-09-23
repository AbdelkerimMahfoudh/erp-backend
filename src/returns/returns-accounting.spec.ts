import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * How an approved return reaches the books (I2-CP4).
 *
 * The approval path is one long transaction over six collaborators, and a
 * double for it proves mostly that the double agrees with itself. What is
 * pinned here are the decisions a future edit could quietly undo — each of
 * which corresponds to a way the deleted legacy endpoint got it wrong.
 *
 * The arithmetic itself is exhaustively covered in `return-workflow.spec.ts`,
 * and the whole flow is exercised over real HTTP against real MySQL.
 */

const SRC = join(__dirname);
const service = readFileSync(join(SRC, 'returns.service.ts'), 'utf8');
const rollup = readFileSync(join(SRC, '..', 'analytics', 'rollup.service.ts'), 'utf8');
const closing = readFileSync(join(SRC, '..', 'closing', 'closing.service.ts'), 'utf8');
const migration = readFileSync(
  join(SRC, '..', '..', 'prisma', 'migrations', '0036_returns_workflow', 'migration.sql'),
  'utf8',
);

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const code = stripComments(service);
const rollupCode = stripComments(rollup);

describe('the original sale is never touched', () => {
  /**
   * The legacy endpoint set `voided = true` on the sale line. Because the
   * rollup filters `si.voided = 0`, that silently rewrote a past — possibly
   * closed — day's revenue and profit. Nothing in the return path may write to
   * a sale, a sale line or a payment.
   */
  it('writes to no sale, sale line or payment', () => {
    expect(code).not.toMatch(/\btx\.sale\.(update|updateMany|delete|create)/);
    expect(code).not.toMatch(/\btx\.saleItem\.(update|updateMany|delete|create)/);
    expect(code).not.toMatch(/\btx\.payment\.(update|updateMany|delete|create)/);
    expect(code).not.toMatch(/voided:\s*true/);
  });

  it('never writes a closing', () => {
    // A locked day is refused, never rewritten.
    expect(code).not.toMatch(/dailyClosing\.(update|updateMany|create|delete)/);
  });

  it('refuses to approve on a day that is already closed', () => {
    expect(code).toMatch(/day_already_closed/);
    expect(code).toMatch(/closing\?\.isLocked/);
  });
});

describe('the reversal is dated, immutable and singular', () => {
  it('is dated the approval day, taken from the server', () => {
    // 0076: the branch's business date, from the one service every writer uses.
    expect(code).toMatch(/const approvalDay = await this\.businessDay\.today\(branchId\)/);
    expect(code).toMatch(/approvalDate,/);
    // Never the sale's day — that is what keeps the original day recomputable.
    expect(code).not.toMatch(/approvalDate:\s*\w*\.?soldAt/);
  });

  it('snapshots the line, so later price or cost changes cannot alter it', () => {
    expect(code).toMatch(/lineRevenue: gross/);
    expect(code).toMatch(/lineCost: num\(request\.saleItem\.cost\)/);
  });

  it('is unique per sale line and per request, in the database', () => {
    expect(migration).toMatch(/UNIQUE KEY `ux_return_reversals_sale_item` \(`sale_item_id`\)/);
    expect(migration).toMatch(/UNIQUE KEY `ux_return_reversals_request` \(`return_request_id`\)/);
  });

  it('is append-only for the application account', () => {
    expect(migration).toMatch(/CREATE TRIGGER `return_reversals_block_update`/);
    expect(migration).toMatch(/CREATE TRIGGER `return_reversals_block_delete`/);
    // The guard must exempt the migrator, or docs/22's restore path breaks.
    expect(migration).toMatch(/USER\(\) LIKE 'phonestore\\_app@%'/);
  });

  it('enforces the refund arithmetic as a constraint, not a convention', () => {
    expect(migration).toMatch(/`net_refund_due` = `gross_refund` - `adjustment_total`/);
    expect(migration).toMatch(/`net_refund_due` >= 0/);
  });
});

describe('money is the server’s', () => {
  it('takes gross from the sale line, never from the request', () => {
    expect(code).toMatch(/grossRefundOf\(\{\s*price: num\(request\.saleItem\.price\)/);
    expect(code).not.toMatch(/dto\.(grossRefund|netRefundDue|refundAmount|adjustmentTotal)/);
  });

  it('sums adjustments itself and re-checks the ceiling at approval', () => {
    // Drafts were validated as they were added, but the set is validated again
    // at the moment it becomes immutable.
    const approve = code.slice(code.indexOf('async approve('));
    expect(approve).toMatch(/settleRefund\(/);
  });
});

describe('custody and authority', () => {
  it('refuses to approve a phone the shop does not hold', () => {
    expect(code).toMatch(/custody_required/);
    expect(code).toMatch(/request\.custody !== 'store_holds'/);
  });

  it('asks the caller’s resolved permissions, not the request', () => {
    expect(code).toMatch(/permissions: this\.cls\.get\('permissions'\)/);
    expect(code).not.toMatch(/dto\.(isOwner|canOverride|permissions)/);
  });

  it('moves the approved phone to faulty and leaves it there', () => {
    const approve = code.slice(code.indexOf('async approve('));
    expect(approve).toMatch(/moveUnitForCustody\(tx, request\.unitId, 'returned', 'faulty'\)/);
    // Never back to sellable stock.
    expect(approve).not.toMatch(/'in_stock'/);
  });

  /**
   * `returned → sold` is reachable ONLY here, and only together with a recorded
   * hand-back. A general-purpose route to that transition would be a way to
   * make a sold phone sellable again.
   */
  it('restores the phone to sold only when a rejection hands it back', () => {
    const reject = code.slice(code.indexOf('async reject('));
    expect(reject).toMatch(/handingBack/);
    expect(reject).toMatch(/moveUnitForCustody\(tx, request\.unitId, 'returned', 'sold'\)/);
    expect(reject).toMatch(/custody: handingBack \? 'handed_back'/);
  });

  it('demands a reason to reject', () => {
    expect(code).toMatch(/Say why this return is being refused/);
  });
});

describe('exactly one winner', () => {
  it('approves and rejects through a compare-and-swap on version AND status', () => {
    for (const method of ['approve', 'reject']) {
      const body = code.slice(code.indexOf(`async ${method}(`));
      expect(body).toMatch(/version: dto\.expectedVersion, status: request\.status/);
      expect(body).toMatch(/if \(moved\.count === 0\) throw this\.staleWrite\(\)/);
    }
  });
});

describe('reporting', () => {
  it('keys the returns component on the approval date', () => {
    expect(rollupCode).toMatch(/FROM return_reversals/);
    expect(rollupCode).toMatch(/approval_date = \$\{day\}/);
  });

  /**
   * Positive magnitudes, subtracted explicitly. A negative stored revenue
   * leaves every consumer guessing whether the sign was already applied.
   */
  it('subtracts returns from net profit explicitly', () => {
    expect(rollupCode).toMatch(/grossProfit - returnsGrossProfit - expenses/);
  });

  /**
   * CP4.1 replaced the CP4 treatment. The rollup now reads the components —
   * gross, adjustments and the COGS credit — rather than the single net figure,
   * so each can be reported separately and the formula can be checked by a
   * reader rather than trusted.
   */
  it('reads gross, adjustments and the COGS credit as separate components', () => {
    expect(rollupCode).toMatch(/SUM\(gross_refund\)/);
    expect(rollupCode).toMatch(/SUM\(adjustment_total\)/);
    expect(rollupCode).toMatch(/SUM\(line_cost\)/);
  });

  /**
   * CP4.1: the cost IS credited back, and the same amount is reinstated as
   * faulty/return-held inventory value. CP4 credited nothing while the asset
   * was excluded from every inventory figure, which is a full write-off of a
   * phone nobody has inspected — never an approved decision.
   */
  it('credits the original cost back rather than writing the asset off', () => {
    expect(rollupCode).not.toMatch(/const returnsCogs = 0;/);
    expect(rollupCode).toMatch(/returnsRevenue - returnsAdjustments - returnsCogs/);
  });

  it('snapshots the day’s returns into the locked closing', () => {
    expect(closing).toMatch(/totalReturns,/);
    expect(closing).toMatch(/totalReturnsProfitImpact,/);
  });

  it('recomputes only the approval day, after the transaction commits', () => {
    const approve = code.slice(code.indexOf('async approve('));
    expect(approve).toMatch(/await this\.rollups\.recomputeDaily\(companyId, branchId, approvalDay\)/);
    // After the commit: a rolled-back approval must not leave a rollup claiming
    // a refund that never happened.
    expect(approve.indexOf('recomputeDaily')).toBeGreaterThan(approve.indexOf('await this.db.$transaction'));
  });
});
