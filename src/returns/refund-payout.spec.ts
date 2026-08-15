import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ROLE_PERMISSIONS } from '../../prisma/seed-data/permissions';
import { ReturnsController } from './returns.controller';
import { REQUIRE_PERMISSIONS_KEY } from '../rbac/require-permissions.decorator';
import { isCompanyPermission } from '../rbac/permission-scope';
import {
  assertAmountMatchesDue,
  assertCorrectable,
  assertMethodAndAccount,
  assertReportable,
  assertWorthSettling,
  fingerprintPayout,
} from './refund-payout';

/**
 * Settling a refund (I3).
 *
 * The distinction this file exists to protect: the REPORT is a claim by whoever
 * handed the money over, and the CONFIRMATION by a manager or owner is the
 * record. Anything that lets the first be mistaken for the second is the defect.
 */

const SRC = join(__dirname);
const service = readFileSync(join(SRC, 'returns.service.ts'), 'utf8');
const rollup = readFileSync(join(SRC, '..', 'analytics', 'rollup.service.ts'), 'utf8');
const closing = readFileSync(join(SRC, '..', 'closing', 'closing.service.ts'), 'utf8');
const migration = readFileSync(
  join(SRC, '..', '..', 'prisma', 'migrations', '0038_refund_payout', 'migration.sql'),
  'utf8',
);
const permissionsOn = (h: unknown): string[] =>
  Reflect.getMetadata(REQUIRE_PERMISSIONS_KEY, h as object) ?? [];

describe('the amount is the shop’s, not the client’s', () => {
  it('accepts exactly the net refund due', () => {
    expect(() => assertAmountMatchesDue(970, 970)).not.toThrow();
  });

  /**
   * No partial payout in I3. Reporting less would leave an unsettled remainder
   * nothing models, and reporting more would invent money the shop never owed.
   */
  it('refuses anything else, in either direction', () => {
    expect(() => assertAmountMatchesDue(969.99, 970)).toThrow(BadRequestException);
    expect(() => assertAmountMatchesDue(970.01, 970)).toThrow(/exactly 970.00/);
    expect(() => assertAmountMatchesDue(0, 970)).toThrow(BadRequestException);
  });

  it('compares in cents, so float noise cannot slip through', () => {
    expect(() => assertAmountMatchesDue(0.1 + 0.2, 0.3)).not.toThrow();
  });

  /**
   * Adjustments can consume the entire refund. That is a real outcome — but
   * there is nothing to hand over, so recording a payment would assert
   * something that never happened.
   */
  it('refuses to settle a refund of zero at all', () => {
    expect(() => assertWorthSettling(0)).toThrow(/nothing is owed/);
    expect(() => assertWorthSettling(970)).not.toThrow();
  });
});

describe('cash and accounts are different things', () => {
  it('refuses cash carrying an account id', () => {
    expect(() => assertMethodAndAccount('cash', 'some-account')).toThrow(/cash refund has no account/);
  });

  it('refuses a configured channel with no account', () => {
    expect(() => assertMethodAndAccount('account', null)).toThrow(/which account/);
  });

  it('accepts each in its correct shape', () => {
    expect(() => assertMethodAndAccount('cash', null)).not.toThrow();
    expect(() => assertMethodAndAccount('account', 'acct')).not.toThrow();
  });
});

describe('a refund cannot be reported before it is owed', () => {
  it('refuses a return that has not been approved', () => {
    expect(() => assertReportable('under_review', true)).toThrow(/not been approved/);
    expect(() => assertReportable('pending_investigation', true)).toThrow(ConflictException);
  });

  it('says plainly that a rejected return owes nothing', () => {
    expect(() => assertReportable('rejected', true)).toThrow(/was rejected/);
  });

  it('refuses when no immutable reversal exists', () => {
    // Without it there is no figure the payout could be measured against.
    expect(() => assertReportable('approved_refund_due', false)).toThrow(/no approved refund record/);
  });

  it('allows exactly the approved-and-unsettled case', () => {
    expect(() => assertReportable('approved_refund_due', true)).not.toThrow();
  });
});

describe('idempotency', () => {
  const base = {
    returnRequestId: '019FB400-3034-7BFA-88AC-C4BD3754CF4A',
    method: 'cash' as const,
    reportedAmount: 970,
    note: 'handed over at the counter',
  };

  it('is stable for the same report', () => {
    expect(fingerprintPayout(base)).toBe(fingerprintPayout({ ...base }));
  });

  it('changes when the money or the channel changes', () => {
    expect(fingerprintPayout({ ...base, reportedAmount: 960 })).not.toBe(fingerprintPayout(base));
    expect(fingerprintPayout({ ...base, method: 'account', receivingAccountId: 'a' })).not.toBe(
      fingerprintPayout(base),
    );
  });

  it('compares amounts in cents rather than by formatting', () => {
    expect(fingerprintPayout({ ...base, reportedAmount: 970.0 })).toBe(fingerprintPayout(base));
  });
});

describe('a confirmed refund is finished', () => {
  it('can be corrected while it waits', () => {
    expect(() => assertCorrectable('reported_pending_confirmation')).not.toThrow();
  });

  it('cannot be changed afterwards', () => {
    expect(() => assertCorrectable('confirmed')).toThrow(/no longer be changed/);
  });
});

describe('who may report, and who may confirm', () => {
  it('every store role may report — whoever hands the money over records it', () => {
    for (const role of ['owner', 'store_manager', 'store_employee'] as const) {
      expect(ROLE_PERMISSIONS[role]).toContain('refund.report');
    }
  });

  /**
   * The separation IS the control. If the person who says money left the till
   * could also certify it, the second step would be decoration.
   */
  it('only the owner and store manager may confirm', () => {
    expect(ROLE_PERMISSIONS.owner).toContain('refund.confirm');
    expect(ROLE_PERMISSIONS.store_manager).toContain('refund.confirm');
    expect(ROLE_PERMISSIONS.store_employee).not.toContain('refund.confirm');
  });

  it('the routes demand exactly those keys', () => {
    expect(permissionsOn(ReturnsController.prototype.reportRefund)).toEqual(['refund.report']);
    expect(permissionsOn(ReturnsController.prototype.correctRefund)).toEqual(['refund.confirm']);
    expect(permissionsOn(ReturnsController.prototype.confirmRefund)).toEqual(['refund.confirm']);
    expect(permissionsOn(ReturnsController.prototype.refundReceipt)).toEqual(['return.view']);
  });

  it('both keys are branch-scoped', () => {
    expect(isCompanyPermission('refund.report')).toBe(false);
    expect(isCompanyPermission('refund.confirm')).toBe(false);
  });
});

describe('the database guarantees, not conventions', () => {
  it('allows one payout per return and per reversal', () => {
    expect(migration).toMatch(/UNIQUE KEY `ux_refund_payouts_request` \(`return_request_id`\)/);
    expect(migration).toMatch(/UNIQUE KEY `ux_refund_payouts_reversal` \(`return_reversal_id`\)/);
  });

  it('requires the reported amount to equal what was owed', () => {
    expect(migration).toMatch(/`reported_amount` = `net_amount_due`/);
  });

  it('ties confirmation fields to the confirmed status, both ways', () => {
    expect(migration).toMatch(/refund_payouts_confirmation_chk/);
    expect(migration).toMatch(/`status` = 'confirmed' AND `confirmed_at` IS NOT NULL/);
  });

  /**
   * DELETE only. A payout is legitimately corrected while it awaits
   * confirmation — but deleting a settlement is never a correction, it is the
   * disappearance of a record that money left the till.
   */
  it('blocks deletion by the application, and not update', () => {
    expect(migration).toMatch(/CREATE TRIGGER `refund_payouts_block_delete`/);
    expect(migration).not.toMatch(/refund_payouts_block_update/);
  });

  it('never touches the payments table', () => {
    expect(migration).not.toMatch(/INSERT INTO `payments`/);
    expect(migration).not.toMatch(/ALTER TABLE `payments`/);
  });
});

describe('confirmation moves cash, and only cash', () => {
  it('settles on the confirmation day, taken from the server', () => {
    expect(service).toMatch(/const confirmationDay = dayKey\(new Date\(\)\)/);
  });

  it('refuses a locked day rather than reopening it', () => {
    const confirm = service.slice(service.indexOf('async confirmRefund('));
    expect(confirm).toMatch(/day_already_closed/);
  });

  it('snapshots the account label so a later rename cannot rewrite a receipt', () => {
    expect(service).toMatch(/accountLabelSnapshot: payout\.receivingAccount\?\.label/);
  });

  it('replays a successful confirmation safely instead of refusing', () => {
    // Somebody who simply lost the response must not be told they failed.
    expect(service).toMatch(/if \(payout\.status === 'confirmed'\) return this\.detail\(idStr\)/);
  });

  /**
   * The heart of I3. Profit was reversed at approval; taking it again at payout
   * would count the same loss twice.
   */
  it('records NO profit component on the confirmation day', () => {
    const block = rollup.slice(rollup.indexOf('FROM refund_payouts') - 900, rollup.indexOf('FROM refund_payouts') + 400);
    expect(block).toMatch(/reported_amount/);
    expect(block).not.toMatch(/grossProfit|netProfit/);
    expect(rollup).toMatch(/NO profit component here/);
  });

  it('keys the cash movement on the confirmation date, not the approval date', () => {
    expect(rollup).toMatch(/confirmation_date = \$\{day\}/);
    expect(rollup).toMatch(/status = 'confirmed'/);
  });

  it('reduces expected cash in the closing, so a paid refund is not a shortage', () => {
    expect(closing).toMatch(/num\(cash\._sum\.amount\) - refundedCash/);
  });

  it('never writes a sale, sale line, payment or reversal', () => {
    // Scoped to the refund methods. Slicing to end-of-file caught the
    // DEFINITION of moveUnitForCustody in the internals section — an
    // assertion that fails on a declaration is one somebody eventually
    // weakens rather than reads.
    const refunds = service.slice(
      service.indexOf('async reportRefund('),
      service.indexOf('// ─────────────────────────────── reads'),
    );
    expect(refunds).not.toMatch(/\btx\.payment\./);
    expect(refunds).not.toMatch(/\btx\.sale\./);
    expect(refunds).not.toMatch(/\btx\.saleItem\./);
    expect(refunds).not.toMatch(/\btx\.returnReversal\.(update|delete)/);
    // The phone stays held: settling money does not move inventory.
    expect(refunds).not.toMatch(/moveUnitForCustody/);
  });
});

describe('the receipt', () => {
  it('exists only once the refund is confirmed', () => {
    const receipt = service.slice(service.indexOf('async refundReceipt('));
    expect(receipt).toMatch(/status: 'confirmed'/);
    expect(receipt).toMatch(/not_confirmed/);
  });

  it('carries no cost, margin or internal id', () => {
    const receipt = service.slice(
      service.indexOf('async refundReceipt('),
      service.indexOf('// ─────────────────────────────── reads'),
    );
    expect(receipt).not.toMatch(/lineCost|margin|totalCost/);
    expect(receipt).not.toMatch(/unitId:/);
  });

  it('references the customer’s own invoice', () => {
    expect(service).toMatch(/originalInvoiceNo: request\.sale\.invoiceNo/);
  });
});
