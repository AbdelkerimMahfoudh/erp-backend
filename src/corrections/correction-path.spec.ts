import { BadRequestException, ConflictException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  actionOf,
  afterReversal,
  ALLOWED_ACTIONS,
  assertDebtorFor,
  assertExpenseReversible,
  assertPurchaseCancellable,
  assertReversible,
  assertSaleCancellable,
  averageAfterRemoval,
  cancellationLegs,
  fingerprintCorrection,
  positionsOf,
  type Leg,
  type PurchaseCancellationState,
} from './correction-rules';
import { refusalOf } from './correction-targets';
import { canTransition } from '../inventory/unit-state-machine';

/**
 * The correction path for sales, payments, expenses and purchases (0079, docs/51 §15).
 *
 * Every rule that decides whether confirmed money or goods are un-done, asserted for
 * what it refuses as much as for what it allows — the refusals are the safety
 * property.
 */

const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const migration = readFileSync(join(__dirname, '..', '..', 'prisma', 'migrations', '0079_correction_path', 'migration.sql'), 'utf8');
const targets = code(readFileSync(join(__dirname, 'correction-targets.ts'), 'utf8'));
const service = code(readFileSync(join(__dirname, 'corrections.service.ts'), 'utf8'));

const CASH = { method: 'cash' as const, accountId: null, label: null };
const BANKILY = { method: 'account' as const, accountId: 'acc-1', label: 'Bankily' };

describe('what each record may have done to it', () => {
  it('matches the database table of kinds and actions', () => {
    expect(ALLOWED_ACTIONS).toEqual({
      refund_payout: ['reverse'],
      supplier_settlement: ['reverse'],
      sale_payment: ['reverse', 'reclassify'],
      sale: ['cancel'],
      expense: ['reverse'],
      supplier_payment: ['reclassify'],
      purchase: ['cancel'],
    });
    expect(migration).toMatch(/`target_kind` = 'sale_payment'\s+AND `action` IN \('reverse', 'reclassify'\)/);
    expect(migration).toMatch(/`target_kind` IN \('sale', 'purchase'\) AND `action` = 'cancel'/);
  });

  it('a kind with one action needs no word for it; a sale payment says which', () => {
    expect(actionOf('sale', undefined, false)).toBe('cancel');
    expect(actionOf('expense', undefined, false)).toBe('reverse');
    expect(actionOf('sale_payment', undefined, true)).toBe('reclassify'); // a 0078 client, unchanged
    expect(actionOf('sale_payment', 'reverse', false)).toBe('reverse');
    expect(() => actionOf('sale_payment', undefined, false)).toThrow(BadRequestException);
  });

  it('refuses an action a record cannot take, and a destination on anything but a move', () => {
    expect(() => actionOf('expense', 'cancel', false)).toThrow(BadRequestException);
    expect(() => actionOf('sale', 'reverse', false)).toThrow(BadRequestException);
    expect(() => actionOf('sale_payment', 'reverse', true)).toThrow(BadRequestException);
  });
});

describe('idempotency', () => {
  const base = { targetId: 't-1', reason: 'Wrong' };
  it('the three earlier kinds keep their fingerprints, so their replays still match', () => {
    const payout = fingerprintCorrection({ ...base, targetKind: 'refund_payout' });
    expect(fingerprintCorrection({ ...base, targetKind: 'refund_payout', action: 'reverse' })).toBe(payout);
    const move = fingerprintCorrection({ ...base, targetKind: 'sale_payment', toMethod: 'cash', amount: 100 });
    expect(fingerprintCorrection({ ...base, targetKind: 'sale_payment', action: 'reclassify', toMethod: 'cash', amount: 100 })).toBe(move);
  });

  it('what is done and how much of it are part of the request', () => {
    const half = fingerprintCorrection({ ...base, targetKind: 'expense', action: 'reverse', amount: 500 });
    expect(fingerprintCorrection({ ...base, targetKind: 'expense', action: 'reverse', amount: 1000 })).not.toBe(half);
    expect(fingerprintCorrection({ ...base, targetKind: 'sale_payment', action: 'reverse', amount: 100 })).not.toBe(
      fingerprintCorrection({ ...base, targetKind: 'sale_payment', action: 'reclassify', toMethod: 'cash', amount: 100 }),
    );
  });
});

describe('where money is now', () => {
  it('a payment still sits in the channel it was recorded in', () => {
    expect(positionsOf({ ...CASH, amount: 6000 }, [])).toEqual([{ ...CASH, amount: 6000 }]);
  });

  it('money moved to another channel is given back from where it went', () => {
    const moved: Leg[] = [
      { ...CASH, direction: 'out', amount: 1000 },
      { ...BANKILY, direction: 'in', amount: 1000 },
    ];
    expect(positionsOf({ ...CASH, amount: 6000 }, moved)).toEqual([
      { ...CASH, amount: 5000 },
      { ...BANKILY, amount: 1000 },
    ]);
  });

  it('money never received is held nowhere; all of it gone leaves nothing', () => {
    expect(positionsOf({ ...CASH, amount: 3000 }, [{ ...CASH, direction: 'out', amount: 1000 }])).toEqual([{ ...CASH, amount: 2000 }]);
    expect(positionsOf({ ...CASH, amount: 3000 }, [{ ...CASH, direction: 'out', amount: 3000 }])).toEqual([]);
  });

  it('a cancellation gives back every position, each leg still naming the payment it came from', () => {
    const legs = cancellationLegs(
      [
        { sourceId: 'p1', positions: [{ ...CASH, amount: 5000 }, { ...BANKILY, amount: 1000 }] },
        { sourceId: 'p2', positions: [{ ...BANKILY, amount: 4000 }] },
      ],
      'out',
    );
    expect(legs.map((l) => [l.sourceId, l.method, l.direction, l.amount])).toEqual([
      ['p1', 'cash', 'out', 5000],
      ['p1', 'account', 'out', 1000],
      ['p2', 'account', 'out', 4000],
    ]);
  });
});

describe('a payment never received (D13)', () => {
  it('all or part, never nothing and never more than recorded', () => {
    expect(() => assertReversible(3000, 1000)).not.toThrow();
    expect(() => assertReversible(3000, 3000)).not.toThrow();
    expect(() => assertReversible(3000, 0)).toThrow(BadRequestException);
    expect(() => assertReversible(3000, 3000.01)).toThrow(BadRequestException);
  });

  it('the sale is owed it again, and its status follows what was really received', () => {
    expect(afterReversal({ total: 10000, received: 3000 }, 1000)).toEqual({ received: 2000, remaining: 8000, payStatus: 'partial' });
    expect(afterReversal({ total: 10000, received: 3000 }, 3000)).toEqual({ received: 0, remaining: 10000, payStatus: 'credit' });
    expect(afterReversal({ total: 10000, received: 10000 }, 500)).toEqual({ received: 9500, remaining: 500, payStatus: 'partial' });
  });

  it('refuses a sale with nobody to owe it — the sale itself was wrong', () => {
    expect(() => assertDebtorFor({ customerId: null, counterpartyId: null })).toThrow(ConflictException);
    expect(refusalOf(() => assertDebtorFor({ customerId: null, counterpartyId: null }))?.code).toBe('no_debtor');
    expect(() => assertDebtorFor({ customerId: Buffer.from('c'), counterpartyId: null })).not.toThrow();
    expect(() => assertDebtorFor({ customerId: null, counterpartyId: Buffer.from('s') })).not.toThrow();
  });
});

describe('a sale that should not exist (D14)', () => {
  const clean = { alreadyCancelled: false, requestPending: false, paymentRequestPending: false, hasReturn: false, unitStatuses: ['sold'] };
  const why = (over: Partial<typeof clean>) => refusalOf(() => assertSaleCancellable({ ...clean, ...over }))?.code ?? null;

  it('may be cancelled while every phone on it is still sold and nothing else corrects it', () => {
    expect(why({})).toBeNull();
    expect(why({ unitStatuses: [] })).toBeNull(); // an accessory-only sale
  });

  it('refuses, by name: twice, while asked, while a payment correction waits, with a return, a phone that moved', () => {
    expect(why({ alreadyCancelled: true })).toBe('already_cancelled');
    expect(why({ requestPending: true })).toBe('request_pending');
    expect(why({ paymentRequestPending: true })).toBe('payment_correction_pending');
    expect(why({ hasReturn: true })).toBe('sale_has_return');
    expect(why({ unitStatuses: ['sold', 'returned'] })).toBe('unit_not_sold');
  });

  it('a phone comes back to stock only from sold, and a return is never this', () => {
    expect(canTransition('sold', 'in_stock')).toBe(true);
    expect(canTransition('returned', 'in_stock')).toBe(true); // the inspection path, unchanged
    expect(canTransition('faulty', 'voided')).toBe(false);
  });
});

describe('a confirmed expense that was wrong (D15)', () => {
  const e = { status: 'confirmed', amount: 1000, accountingDay: '2026-09-26' };
  it('all or part of a confirmed expense, from the day it counts on', () => {
    expect(() => assertExpenseReversible(e, 400, '2026-09-26')).not.toThrow();
    expect(() => assertExpenseReversible(e, 1000, '2026-09-27')).not.toThrow();
  });

  it('refuses a reported one, nothing, more than recorded, and one that has not left the drawer yet', () => {
    expect(refusalOf(() => assertExpenseReversible({ ...e, status: 'reported' }, 400, '2026-09-26'))?.code).toBe('not_confirmed');
    expect(() => assertExpenseReversible(e, 0, '2026-09-26')).toThrow(BadRequestException);
    expect(() => assertExpenseReversible(e, 1000.5, '2026-09-26')).toThrow(BadRequestException);
    expect(refusalOf(() => assertExpenseReversible({ ...e, accountingDay: '2026-09-27' }, 400, '2026-09-26'))?.code).toBe('expense_not_yet_due');
  });
});

describe('a purchase that should not exist (D17)', () => {
  it('undoes the average the purchase raised', () => {
    // 90 at 5.00, then 10 at 6.00 → 100 at 5.10; taking the 10 back → 90 at 5.00.
    expect(averageAfterRemoval(100, 5.1, 10, 6)).toEqual({ quantity: 90, cost: 5 });
  });

  it('refuses goods no longer held, and a remaining stock worth less than nothing', () => {
    expect(averageAfterRemoval(5, 5, 10, 6)).toBeNull();
    expect(averageAfterRemoval(11, 18.18, 10, 100)).toBeNull();
    expect(averageAfterRemoval(10, 6, 10, 6)).toEqual({ quantity: 0, cost: 6 });
  });

  const clean: PurchaseCancellationState = { alreadyCancelled: false, requestPending: false, paymentRequestPending: false, units: [{ status: 'in_stock', atBranch: true }], stock: [] };
  const why = (over: Partial<PurchaseCancellationState>) => refusalOf(() => assertPurchaseCancellable({ ...clean, ...over }))?.code ?? null;
  it('may be cancelled while everything it brought is still here', () => {
    expect(why({})).toBeNull();
  });

  it('refuses goods that moved, stock that is short, and an average that would fall below zero', () => {
    expect(why({ units: [{ status: 'sold', atBranch: true }] })).toBe('goods_moved');
    expect(why({ units: [{ status: 'in_stock', atBranch: false }] })).toBe('goods_moved');
    expect(why({ units: [{ status: 'reserved', atBranch: true }] })).toBe('goods_moved');
    expect(why({ stock: [{ onHand: 12, reserved: 5, bought: 10, averageCost: 5, unitCost: 5 }] })).toBe('stock_short');
    expect(why({ stock: [{ onHand: 11, reserved: 0, bought: 10, averageCost: 18.18, unitCost: 100 }] })).toBe('cost_conflict');
  });

  it('a phone leaves the books only from stock, and comes back only by being received again', () => {
    expect(canTransition('in_stock', 'voided')).toBe(true);
    expect(canTransition('voided', 'in_stock')).toBe(true);
    for (const s of ['sold', 'reserved', 'in_transit', 'faulty', 'returned', 'transferred_out', 'consigned_out'] as const) {
      expect(canTransition(s, 'voided')).toBe(false);
    }
  });
});

describe('the approval decides on the record as it is now', () => {
  it('re-plans inside its transaction after locking the rows it changes', () => {
    const approve = service.slice(service.indexOf('async approve('), service.indexOf('async reject('));
    expect(approve).toMatch(/FOR UPDATE[\s\S]*lockAndPlan[\s\S]*if \(plan\?\.refusal\) throw new ConflictException\(plan\.refusal\)[\s\S]*financialCorrection\.updateMany/);
    expect(service).toMatch(/ignoreCorrectionId: c\.id/);
  });

  it('another open request never blocks a decision — only an approved one does', () => {
    expect(targets).toMatch(/requested: !ignore && others\.some/);
    expect(targets).toMatch(/paymentRequestPending: \w+\.payments\.some\(\(p\) => !ctx\.ignoreCorrectionId/);
  });

  it('what the request carried is what is done: its amount and destination, re-read from the request', () => {
    expect(service).toMatch(/amount: c\.targetKind === 'sale' \|\| c\.targetKind === 'purchase' \? undefined : num\(c\.amount\)/);
    expect(service).toMatch(/toAccountId: c\.toReceivingAccountId \? binToUuid\(c\.toReceivingAccountId\) : undefined/);
  });

  it('a second approved correction of one record is the database\'s refusal, answered by name', () => {
    expect(service).toMatch(/code === 'P2002'\)\s*\{\s*throw new ConflictException\(\{ code: 'already_corrected'/);
    for (const key of ['uq_fc_active_sale', 'uq_fc_active_expense', 'uq_fc_active_supplier_payment', 'uq_fc_active_purchase']) {
      expect(migration).toContain(key);
    }
  });
});

describe('the schema (0079)', () => {
  it('a sale line leaves sold-once only when an approved cancellation released it', () => {
    expect(migration).toMatch(/GENERATED ALWAYS AS \(IF\(`voided` = 0 AND `released_by_correction_id` IS NULL, `unit_id`, NULL\)\) VIRTUAL/);
    expect(migration).toMatch(/ADD UNIQUE KEY `ux_saleitem_active_unit` \(`active_unit_id`\)/);
  });

  it('IMEI uniqueness is not touched: no identifier index is dropped or redefined', () => {
    expect(migration).not.toMatch(/ux_units_identifier|units_imei_secondary_key|units_identifier_unique/);
  });

  it('the legs are append-only, positive, and cash names no account', () => {
    expect(migration).toMatch(/BEFORE UPDATE ON `financial_correction_legs`/);
    expect(migration).toMatch(/BEFORE DELETE ON `financial_correction_legs`/);
    expect(migration).toMatch(/`ck_fcl_amount_positive`\s+CHECK \(`amount` > 0\)/);
    expect(migration).toMatch(/`ck_fcl_cash_no_account`\s+CHECK \(`method` = 'account' OR `receiving_account_id` IS NULL\)/);
  });

  it('exactly one target per correction, of its own kind', () => {
    expect(migration).toMatch(/\+ \(`target_purchase_id` IS NOT NULL\) = 1/);
  });

  it('every statement can run twice', () => {
    for (const check of ['ck_fc_one_target', 'ck_fc_destination', 'ck_fc_amount_positive', 'ck_fc_action', 'ck_fc_method']) {
      expect(migration).toMatch(new RegExp(`constraint_name = '${check}'\\) = 1,\\s+'ALTER TABLE \`financial_corrections\` DROP CHECK \`${check}\`'`));
    }
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS `financial_correction_legs`/);
  });
});
