import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReturnsController } from './returns.controller';
import { REQUIRE_PERMISSIONS_KEY } from '../rbac/require-permissions.decorator';

/**
 * What the shop owes, what it has paid, and when each happened (I3-CP4).
 *
 * Three timings must stay apart, because collapsing any two is how a refund
 * gets counted twice:
 *
 *   approval date      profit reverses, a liability appears
 *   report date        a workflow event only
 *   confirmation date  cash leaves, the liability settles
 */

const SRC = join(__dirname);
const service = readFileSync(join(SRC, 'returns.service.ts'), 'utf8');
const controller = readFileSync(join(SRC, 'returns.controller.ts'), 'utf8');
const closing = readFileSync(join(SRC, '..', 'closing', 'closing.service.ts'), 'utf8');
const rollup = readFileSync(join(SRC, '..', 'analytics', 'rollup.service.ts'), 'utf8');

const summary = service.slice(
  service.indexOf('async refundSummary('),
  service.indexOf('// ─────────────────────────────── reads'),
);

describe('outstanding liability is derived, never stored', () => {
  /**
   * The property that makes it trustworthy: it comes from immutable approved
   * reversals minus confirmed payouts, so nothing a workflow does in between —
   * a report, a correction, a retry — can move it.
   */
  it('is approved reversals minus CONFIRMED payouts', () => {
    expect(summary).toMatch(/FROM return_reversals rv/);
    expect(summary).toMatch(/LEFT JOIN refund_payouts p[\s\S]{0,120}status = 'confirmed'/);
    expect(summary).toMatch(/p\.id IS NULL/);
  });

  it('counts a merely REPORTED payout as still outstanding', () => {
    // Bounded to the outstanding query. Slicing to the end of the method ran
    // into the `awaiting` query, which legitimately mentions the pending
    // status — an assertion that reads the wrong statement proves nothing.
    const outstandingQuery = summary.slice(
      summary.indexOf('const [outstanding]'),
      summary.indexOf('const [awaiting]'),
    );
    // The join is on confirmed only, so a pending report leaves the liability
    // standing: nobody has agreed the money left.
    expect(outstandingQuery).toMatch(/LEFT JOIN refund_payouts/);
    expect(outstandingQuery).not.toMatch(/reported_pending_confirmation/);
  });

  it('ignores the reporting period, because a debt does not expire', () => {
    const outstanding = summary.slice(
      summary.indexOf('const [outstanding]'),
      summary.indexOf('const [awaiting]'),
    );
    expect(outstanding).not.toMatch(/approval_date >=|confirmation_date >=/);
  });
});

describe('the three timings stay separate', () => {
  it('approval figures come from the reversal and its approval date', () => {
    const approved = summary.slice(summary.indexOf('const [approved]'), summary.indexOf('const [outstanding]'));
    expect(approved).toMatch(/FROM return_reversals/);
    expect(approved).toMatch(/approval_date >=/);
  });

  it('confirmed cash is keyed on the confirmation date', () => {
    const conf = summary.slice(summary.indexOf('const [confirmed]'), summary.indexOf('const byAccount'));
    expect(conf).toMatch(/confirmation_date >=/);
    expect(conf).toMatch(/status = 'confirmed'/);
  });

  it('awaiting-confirmation is a workflow count with no date filter at all', () => {
    const awaiting = summary.slice(summary.indexOf('const [awaiting]'), summary.indexOf('const [confirmed]'));
    expect(awaiting).toMatch(/reported_pending_confirmation/);
    expect(awaiting).not.toMatch(/confirmation_date/);
  });

  it('reports the approval-date profit effect, and computes it the CP4.1 way', () => {
    expect(summary).toMatch(/gross - adjustments - cogs/);
  });

  /**
   * The whole point of I3's accounting: confirmation moves money, not profit.
   */
  it('the confirmation-day rollup still has no profit component', () => {
    const block = rollup.slice(rollup.indexOf('FROM refund_payouts') - 600, rollup.indexOf('FROM refund_payouts') + 300);
    expect(block).not.toMatch(/grossProfit|netProfit/);
  });
});

describe('reconciliation', () => {
  it('subtracts confirmed cash refunds from expected cash exactly once', () => {
    expect(closing).toMatch(/num\(cash\._sum\.amount\) - refundedCash/);
    // One subtraction, not two.
    expect(closing.match(/- refundedCash/g) ?? []).toHaveLength(1);
  });

  it('takes that figure from the rollup rather than from payments', () => {
    expect(closing).toMatch(/rollup\?\.refundsPaidCash/);
  });

  it('never treats a refund as an expense', () => {
    const cashBlock = closing.slice(closing.indexOf('const refundedCash'), closing.indexOf('const lines'));
    expect(cashBlock).not.toMatch(/expense/i);
  });

  it('groups confirmed outflow by the frozen account label', () => {
    expect(summary).toMatch(/GROUP BY account_label_snapshot/);
  });
});

describe('an account can be renamed or deactivated without stranding a refund', () => {
  /**
   * The label is snapshotted when the money moves, not when it is confirmed. If
   * the Owner renames the account in between, confirmation must not rewrite
   * history — and if they deactivate it, confirmation must still be possible.
   */
  it('snapshots the label at REPORT time', () => {
    const report = service.slice(service.indexOf('async reportRefund('), service.indexOf('async correctRefund('));
    expect(report).toMatch(/accountLabelSnapshot: account\?\.label \?\? null/);
  });

  it('re-snapshots on correction, because the account itself changed', () => {
    const correct = service.slice(service.indexOf('async correctRefund('), service.indexOf('async confirmRefund('));
    expect(correct).toMatch(/accountLabelSnapshot: method === 'cash' \? null : \(account\?\.label \?\? null\)/);
  });

  it('FREEZES rather than re-reads at confirmation', () => {
    const confirm = service.slice(service.indexOf('async confirmRefund('), service.indexOf('async refundReceipt('));
    // Re-reading the live account here would let a rename between report and
    // confirmation retitle a movement that already happened.
    expect(confirm).toMatch(/accountLabelSnapshot: payout\.accountLabelSnapshot \?\? payout\.receivingAccount\?\.label/);
  });

  it('requires an ACTIVE account to report or correct, but not to confirm', () => {
    const report = service.slice(service.indexOf('async reportRefund('), service.indexOf('async correctRefund('));
    const correct = service.slice(service.indexOf('async correctRefund('), service.indexOf('async confirmRefund('));
    const confirm = service.slice(service.indexOf('async confirmRefund('), service.indexOf('async refundReceipt('));
    expect(report).toMatch(/isActive: true/);
    expect(correct).toMatch(/isActive: true/);
    // Deactivating an account must not trap a refund that is already reported.
    expect(confirm).not.toMatch(/isActive: true/);
  });

  it('the receipt reads the frozen label, not the live one', () => {
    const receipt = service.slice(service.indexOf('async refundReceipt('));
    expect(receipt).toMatch(/accountLabel: payout\.accountLabelSnapshot/);
  });
});

describe('the summary route', () => {
  it('is declared before :id, or every request 404s', () => {
    // Nest matches in declaration order: `refunds/summary` after `:id` would be
    // read as a return whose id is "refunds".
    expect(controller.indexOf("@Get('refunds/summary')")).toBeLessThan(controller.indexOf("@Get(':id')"));
  });

  it('requires return.view', () => {
    expect(Reflect.getMetadata(REQUIRE_PERMISSIONS_KEY, ReturnsController.prototype.refundSummary)).toEqual([
      'return.view',
    ]);
  });

  it('names its cost field so the standard gating strips it', () => {
    // `cogsCredited` is cost. Without `cost.view` it must not survive.
    expect(summary).toMatch(/cogsCredited: cogs/);
  });
});
