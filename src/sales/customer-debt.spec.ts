import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { DEBT_DUE_MAX_DAYS, debtDueDays, dueDateFor, parseCustomerPhone } from './customer-debt';

/**
 * A sale's balance as a customer debt (the owner's brief of 2026-10-17).
 *
 * The rules are pure and tested directly; their wiring into the one long
 * `createSale` transaction is pinned against the source, as
 * `sale-receiving-account.spec.ts` explains. The behaviour end to end — full,
 * partial and zero payment, an existing and a new customer, a retry, a later
 * repayment, another company — is the real-HTTP run recorded in the session log.
 */

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof BadRequestException ? (e.getResponse() as { code?: string }).code : 'not a 400';
  }
};

describe('the days until a balance is due', () => {
  it('are required when money is owed', () => {
    expect(code(() => debtDueDays(100, undefined))).toBe('due_days_required');
    expect(debtDueDays(100, 7)).toBe(7);
    // Zero received: the whole total is owed, and still needs its due date.
    expect(debtDueDays(1000, 1)).toBe(1);
  });

  it('are ignored when nothing is owed — a fully paid sale has no due date', () => {
    expect(debtDueDays(0, undefined)).toBeNull();
    expect(debtDueDays(0, 30)).toBeNull();
    // A rounding crumb is not a debt.
    expect(debtDueDays(0.001, undefined)).toBeNull();
  });

  it('are whole days from 1 to a year', () => {
    expect(code(() => debtDueDays(100, 0))).toBe('due_days_invalid');
    expect(code(() => debtDueDays(100, -3))).toBe('due_days_invalid');
    expect(code(() => debtDueDays(100, 2.5))).toBe('due_days_invalid');
    expect(code(() => debtDueDays(100, DEBT_DUE_MAX_DAYS + 1))).toBe('due_days_invalid');
    expect(debtDueDays(100, DEBT_DUE_MAX_DAYS)).toBe(DEBT_DUE_MAX_DAYS);
  });
});

describe('the due date', () => {
  it('counts from the sale’s business day, across months and years', () => {
    expect(dueDateFor('2026-10-17', 7)).toBe('2026-10-24');
    expect(dueDateFor('2026-10-30', 3)).toBe('2026-11-02');
    expect(dueDateFor('2026-12-31', 1)).toBe('2027-01-01');
    expect(dueDateFor('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('a customer who owes has a phone number', () => {
  it('accepts a local or international number, as a person types it', () => {
    expect(parseCustomerPhone('22 33 44 55')).toEqual({ ok: true, value: '22334455' });
    expect(parseCustomerPhone('+222 22-33-44-55')).toEqual({ ok: true, value: '+22222334455' });
    // Arabic-Indic digits read as the same digits.
    expect(parseCustomerPhone('٢٢٣٣٤٤٥٥')).toEqual({ ok: true, value: '22334455' });
  });

  it('refuses a missing, short, long or lettered number — by its problem, never by echoing it', () => {
    expect(parseCustomerPhone('')).toEqual({ ok: false, reason: 'customer_phone_required' });
    expect(parseCustomerPhone(undefined)).toEqual({ ok: false, reason: 'customer_phone_required' });
    expect(parseCustomerPhone('1234567')).toEqual({ ok: false, reason: 'customer_phone_invalid' });
    expect(parseCustomerPhone('1234567890123456')).toEqual({ ok: false, reason: 'customer_phone_invalid' });
    expect(parseCustomerPhone('22 33 AB 55')).toEqual({ ok: false, reason: 'customer_phone_invalid' });
  });
});

describe('the wiring in createSale', () => {
  const service = readFileSync(join(__dirname, 'sales.service.ts'), 'utf8');
  const create = service.slice(service.indexOf('async createSale('), service.indexOf('private async resolveDebtor('));
  const resolve = service.slice(service.indexOf('private async resolveDebtor('), service.indexOf('async outstanding('));

  it('takes the due date from the sale’s own business day, never from the request', () => {
    expect(create).toMatch(/const dueDays = debtDueDays\(balanceDue, dto\.dueInDays\);/);
    expect(create).toMatch(/dueDate: dueDays === null \? null : dateValue\(dueDateFor\(businessDate, dueDays\)\)/);
    expect(create).not.toMatch(/dueDate: dto\./);
  });

  it('keeps the debt as the sale’s own receivable: no loan and no second ledger for the same money', () => {
    expect(create).not.toMatch(/tx\.loan\b|loanLedger|tx\.counterpartyLedger/);
    expect(create).toMatch(/balanceDue,/);
  });

  it('requires a phone for a customer who owes, and never changes a saved one from a sale', () => {
    expect(resolve).toMatch(/if \(debt\.owes && !found\.phone\?\.trim\(\)\)/);
    expect(resolve).toMatch(/data: \{ phone: phone\.value \}/);
    expect(resolve).toMatch(/if \(debt\.owes \|\| choice\.phone\)/);
  });

  it('a retry with another due date is a different sale, refused like any other difference', () => {
    const replay = service.slice(service.indexOf('private async assertReplayMatches('));
    expect(replay).toMatch(/dueDateFor\(dayKey\(existing\.businessDate\), dto\.dueInDays\) === dayKey\(existing\.dueDate\)/);
  });
});
