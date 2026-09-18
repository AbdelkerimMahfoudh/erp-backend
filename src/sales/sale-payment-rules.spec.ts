import { BadRequestException, ConflictException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  afterPayment,
  assertCollectable,
  assertDebtorForBalance,
  chooseDebtor,
  collectionFingerprint,
  payStatusOf,
  resolvePaidAt,
} from './sale-payment-rules';

/**
 * A sale paid over time (0074). Every rule here is a money rule, so each is
 * pinned on its own — and the service's shape is pinned beside them, because
 * "a later payment is not a second sale" is a property of what the code does
 * NOT touch.
 */

describe('payment status comes from money received, never from a request succeeding', () => {
  it('nothing received is unpaid', () => {
    expect(payStatusOf(25_000, 0)).toBe('credit');
  });
  it('some received is partially paid', () => {
    expect(payStatusOf(25_000, 15_000)).toBe('partial');
  });
  it('everything received is paid in full', () => {
    expect(payStatusOf(25_000, 25_000)).toBe('paid');
  });
  it('a rounding hair short of the total is still paid in full', () => {
    expect(payStatusOf(100, 99.999)).toBe('paid');
  });
});

describe('the 25 000 lifecycle, as arithmetic', () => {
  const sale = { total: 25_000, received: 15_000 };

  it('15 000 now leaves 10 000 owed, partially paid', () => {
    expect(payStatusOf(sale.total, sale.received)).toBe('partial');
    expect(sale.total - sale.received).toBe(10_000);
  });

  it('a later 4 000 leaves 6 000, still partially paid', () => {
    expect(afterPayment(sale, 4_000)).toEqual({ received: 19_000, remaining: 6_000, payStatus: 'partial' });
  });

  it('the final 6 000 settles it exactly', () => {
    expect(afterPayment({ total: 25_000, received: 19_000 }, 6_000)).toEqual({
      received: 25_000,
      remaining: 0,
      payStatus: 'paid',
    });
  });

  it('several later payments add up, and each is checked against what is left', () => {
    let state = { total: 25_000, received: 0 };
    for (const amount of [5_000, 5_000, 5_000, 10_000]) {
      assertCollectable(state, amount);
      const next = afterPayment(state, amount);
      state = { total: 25_000, received: next.received };
    }
    expect(state.received).toBe(25_000);
    expect(() => assertCollectable(state, 1)).toThrow(ConflictException);
  });
});

describe('what may be recorded', () => {
  const owing = { total: 25_000, received: 19_000 };

  it('refuses zero', () => {
    expect(() => assertCollectable(owing, 0)).toThrow(BadRequestException);
  });
  it('refuses a negative amount', () => {
    expect(() => assertCollectable(owing, -500)).toThrow(BadRequestException);
  });
  it('refuses more than is still owed', () => {
    expect(() => assertCollectable(owing, 6_000.01)).toThrow(BadRequestException);
    try {
      assertCollectable(owing, 7_000);
    } catch (e) {
      expect((e as BadRequestException).getResponse()).toMatchObject({ code: 'overpayment' });
    }
  });
  it('accepts exactly what is owed', () => {
    expect(() => assertCollectable(owing, 6_000)).not.toThrow();
  });
  it('refuses anything at all on a sale already paid in full', () => {
    expect(() => assertCollectable({ total: 25_000, received: 25_000 }, 1)).toThrow(ConflictException);
  });
});

describe('who owes the balance', () => {
  it('a selected customer is used as-is, so no duplicate is created', () => {
    expect(chooseDebtor({ customerId: 'c-1' })).toEqual({ kind: 'customer_existing', customerId: 'c-1' });
  });
  it('a typed customer needs a name; the phone is optional', () => {
    expect(chooseDebtor({ customer: { name: '  Mariam ' } })).toEqual({ kind: 'customer_new', name: 'Mariam', phone: null });
    expect(chooseDebtor({ customer: { name: 'Mariam', phone: ' 22 11 ' } })).toEqual({
      kind: 'customer_new',
      name: 'Mariam',
      phone: '22 11',
    });
    expect(() => chooseDebtor({ customer: { name: '   ' } })).toThrow(BadRequestException);
  });
  it('a partner store may owe it', () => {
    expect(chooseDebtor({ counterpartyId: 's-1' })).toEqual({ kind: 'store', counterpartyId: 's-1' });
  });
  it('one balance has one debtor — a customer and a store together are refused', () => {
    expect(() => chooseDebtor({ customerId: 'c-1', counterpartyId: 's-1' })).toThrow(BadRequestException);
    expect(() => chooseDebtor({ customer: { name: 'A' }, customerId: 'c-1' })).toThrow(BadRequestException);
  });
  it('a sale leaving money owing must name who owes it', () => {
    expect(() => assertDebtorForBalance(10_000, { kind: 'none' })).toThrow(BadRequestException);
    expect(() => assertDebtorForBalance(0, { kind: 'none' })).not.toThrow();
    expect(() => assertDebtorForBalance(25_000, { kind: 'store', counterpartyId: 's' })).not.toThrow();
  });
});

describe('when the money arrived', () => {
  const soldAt = new Date('2026-09-18T10:00:00Z');
  const now = new Date('2026-09-19T15:00:00Z');

  it('defaults to now', () => {
    expect(resolvePaidAt(undefined, soldAt, now)).toBe(now);
  });
  it('may be earlier, back to the sale', () => {
    expect(resolvePaidAt('2026-09-18T18:00:00Z', soldAt, now).toISOString()).toBe('2026-09-18T18:00:00.000Z');
  });
  it('is never in the future', () => {
    expect(() => resolvePaidAt('2026-09-20T09:00:00Z', soldAt, now)).toThrow(BadRequestException);
  });
  it('is never before the sale it pays for', () => {
    expect(() => resolvePaidAt('2026-09-17T09:00:00Z', soldAt, now)).toThrow(BadRequestException);
  });
});

describe('a retry is the same payment; a changed payload is not', () => {
  const base = { saleId: 's', amount: 4_000, method: 'mobile', receivingAccountId: 'a', paidAt: '2026-09-19T10:00:05Z' };

  it('the same payload hashes the same, seconds apart', () => {
    expect(collectionFingerprint(base)).toBe(collectionFingerprint({ ...base, paidAt: '2026-09-19T10:00:40Z' }));
  });
  it('a different amount, account, method or sale hashes differently', () => {
    const h = collectionFingerprint(base);
    expect(collectionFingerprint({ ...base, amount: 4_001 })).not.toBe(h);
    expect(collectionFingerprint({ ...base, receivingAccountId: 'b' })).not.toBe(h);
    expect(collectionFingerprint({ ...base, method: 'cash', receivingAccountId: null })).not.toBe(h);
    expect(collectionFingerprint({ ...base, saleId: 't' })).not.toBe(h);
  });
});

// ── the service, by what it does and does not touch ────────────────────────

const SRC = join(__dirname);
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const service = code(readFileSync(join(SRC, 'sale-payments.service.ts'), 'utf8'));

describe('a later collection is a movement of money, not a second sale', () => {
  it('writes a payment and the sale balance — and never a sale item', () => {
    expect(service).toContain('tx.payment.create');
    expect(service).toContain("kind: 'collection'");
    expect(service).not.toMatch(/saleItem\.(create|update|upsert)/);
    expect(service).not.toMatch(/sale\.create\(/);
  });

  it('never touches revenue, cost or profit on the sale', () => {
    const update = service.slice(service.indexOf('tx.sale.update'), service.indexOf('tx.sale.update') + 200);
    expect(update).toContain('amountPaid');
    expect(update).toContain('balanceDue');
    expect(update).not.toMatch(/total|margin|totalCost|subtotal/);
  });

  it('emits nothing the rollup recomputes revenue from', () => {
    expect(service).not.toContain('sale.recorded');
    expect(service).not.toContain('events.emit');
  });

  it('is dated by when the money arrived', () => {
    expect(service).toContain('paidAt,');
    expect(service).toContain('resolvePaidAt(dto.paidAt');
  });

  it('holds the sale row while it decides, so two payments cannot overpay together', () => {
    expect(service).toMatch(/FOR UPDATE/);
    const lock = service.indexOf('FOR UPDATE');
    // The CALL, not the import at the top of the file.
    expect(service.indexOf('assertCollectable(balance')).toBeGreaterThan(lock);
    expect(service.indexOf('tx.payment.create')).toBeGreaterThan(lock);
  });

  it('refuses a signed-off day, like an expense and a correction', () => {
    expect(service).toContain('assertDayOpen(closing, day)');
  });

  it('refuses an inactive account, and freezes the label of an active one', () => {
    expect(service).toContain('account_inactive');
    expect(service).toContain('accountLabelSnapshot: account?.label');
  });

  it('is scoped to the company and the active branch', () => {
    expect(service).toMatch(/company_id = \$\{companyId\}/);
    expect(service).toContain('requireBranchId()');
    expect(service).toContain('No such sale at this branch');
  });

  it('answers a retry, arbitrates a race by the unique key, and refuses a reused key', () => {
    expect(service).toContain('this.replay(companyId, clientUuid, hash)');
    expect(service).toContain("e.code === 'P2002'");
    expect(service).toContain('idempotency_key_reused');
  });

  it('never exposes the key or its hash in a payment view', () => {
    const view = service.slice(service.indexOf('export const paymentSelect'));
    expect(view).not.toMatch(/clientUuid|clientRequestHash/);
  });
});
