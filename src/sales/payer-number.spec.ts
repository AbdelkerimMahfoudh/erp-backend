import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { SalesService } from './sales.service';
import { SalesPolicyService } from './sales-policy.service';
import { SalePaymentsService, paymentSelect, toPaymentView } from './sale-payments.service';
import { SalesController } from './sales.controller';
import { ClosingService } from '../closing/closing.service';
import { REQUIRE_PERMISSIONS_KEY } from '../rbac/require-permissions.decorator';
import { binToUuid, uuidToBin } from '../common/utils/uuid.util';
import { collectionFingerprint } from './sale-payment-rules';
import { assertPayerNumbers, parsePayerNumber, payerNumberFor, PAYER_NUMBER_MAX_DIGITS } from './payer-number';

/**
 * The payer number (docs/21 D151, migration 0087): the phone or account number
 * a bank or wallet payment came FROM. Optional, non-cash only, attached to its
 * own payment part, bound into the idempotency payload, preserved by money
 * corrections, correctable on its own, audited — and nowhere a customer, a
 * report or the server log would show it. Nothing about it may move money.
 */

const COMPANY = Buffer.alloc(16, 1);
const BRANCH = Buffer.alloc(16, 2);
const OTHER_BRANCH = Buffer.alloc(16, 9);
const USER = Buffer.alloc(16, 3);
const SALE = Buffer.alloc(16, 4);
const UNIT = Buffer.alloc(16, 5);
const PRODUCT = Buffer.alloc(16, 6);
const PAYMENT = Buffer.alloc(16, 8);
const KEY = '11111111-2222-4333-8444-555555555555';
const IMEI = '490154203237518';
const DAY = '2026-10-07';
const ACCT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACCT_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ACCOUNTS = new Map<string, { label: string; provider: string; providerName: string | null; isActive: boolean }>([
  [uuidToBin(ACCT_A).toString('hex'), { label: 'Bankily', provider: 'bankily', providerName: null, isActive: true }],
  [uuidToBin(ACCT_B).toString('hex'), { label: 'Masrvi', provider: 'other', providerName: 'Masrvi', isActive: true }],
  [uuidToBin(ACCT_C).toString('hex'), { label: 'Sedad', provider: 'sedad', providerName: null, isActive: true }],
]);

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
};
const asyncRefusal = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return undefined;
};

describe('the rule (the same cases as the app’s lib/payer-number.test.ts)', () => {
  it('optional: blank, invisible or missing is no payer number at all', () => {
    for (const raw of ['', '   ', ' ', '‎', null, undefined]) expect(parsePayerNumber(raw)).toEqual({ ok: true, value: null });
  });
  it('kept exactly; spaces and hyphens of any kind are presentation', () => {
    expect(parsePayerNumber('36123456')).toEqual({ ok: true, value: '36123456' });
    expect(parsePayerNumber(' +222 36 12-34-56 ')).toEqual({ ok: true, value: '+22236123456' });
    expect(parsePayerNumber('36 12 34 56')).toEqual({ ok: true, value: '36123456' });
    expect(parsePayerNumber('36–12−34')).toEqual({ ok: true, value: '361234' });
  });
  it('no digit is guessed, added or removed: 00 stays 00', () => {
    expect(parsePayerNumber('00222 36 12 34 56')).toEqual({ ok: true, value: '0022236123456' });
  });
  it('Arabic-Indic and Extended Arabic-Indic digits read as the same digits; direction marks vanish', () => {
    expect(parsePayerNumber('٣٦١٢٣٤٥٦')).toEqual({ ok: true, value: '36123456' });
    expect(parsePayerNumber('۳۶ ۱۲')).toEqual({ ok: true, value: '3612' });
    expect(parsePayerNumber('‎+222‏ 36')).toEqual({ ok: true, value: '+22236' });
  });
  it('refused: a letter, a dot, a bracket, a misplaced +, visible text with no digit', () => {
    for (const raw of ['36A12345', 'MR13 0002', '36.12.34', '(222) 36', '36+12', '++36', '+', '-', ' - ']) {
      expect(parsePayerNumber(raw)).toEqual({ ok: false, reason: 'invalid' });
    }
  });
  it(`at most ${PAYER_NUMBER_MAX_DIGITS} digits; a leading + does not count`, () => {
    const max = '1'.repeat(PAYER_NUMBER_MAX_DIGITS);
    expect(parsePayerNumber(`+${max}`)).toEqual({ ok: true, value: `+${max}` });
    expect(parsePayerNumber(`${max}1`)).toEqual({ ok: false, reason: 'too_long' });
  });
  it('normalising twice changes nothing', () => {
    const once = parsePayerNumber(' +222 36-12 34 56');
    expect(once.ok && parsePayerNumber(once.value)).toEqual(once);
  });
});

describe('refusals name the problem, never the number (messages reach the server log)', () => {
  it('a malformed number: 400 payer_number_invalid', () => {
    const e = refusal(() => payerNumberFor('mobile', '36A12345'));
    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as BadRequestException).getResponse()).toMatchObject({ code: 'payer_number_invalid' });
    expect(JSON.stringify((e as BadRequestException).getResponse())).not.toContain('36A12345');
  });
  it('too many digits: the same code, the limit named', () => {
    const e = refusal(() => payerNumberFor('bank', '9'.repeat(PAYER_NUMBER_MAX_DIGITS + 1)));
    expect((e as BadRequestException).getResponse()).toMatchObject({ code: 'payer_number_invalid' });
    expect(JSON.stringify((e as BadRequestException).getResponse())).not.toContain('9'.repeat(PAYER_NUMBER_MAX_DIGITS));
  });
  it('cash: a number is refused (payer_number_cash), nothing is fine', () => {
    const e = refusal(() => payerNumberFor('cash', '36123456'));
    expect((e as BadRequestException).getResponse()).toMatchObject({ code: 'payer_number_cash' });
    expect(payerNumberFor('cash', '')).toBeNull();
    expect(payerNumberFor('cash', undefined)).toBeNull();
    expect(() => assertPayerNumbers([{ method: 'cash' }, { method: 'mobile', payerNumber: '36 12' }])).not.toThrow();
  });
});

// ── the sale, through the real createSale and a fake transaction ─────────────

function saleHarness() {
  const created: Record<string, unknown>[] = [];
  const audits: Record<string, any>[] = [];
  const saleRows: Record<string, unknown>[] = [];
  const tx: any = {
    unit: {
      findFirst: async () => ({ id: UNIT, productId: PRODUCT, branchId: BRANCH, status: 'in_stock', imeiPrimary: IMEI, serialNo: null, cost: 700, product: { defaultPrice: 899 } }),
      updateMany: async () => ({ count: 1 }),
    },
    companySettings: { findUnique: async () => ({ returnWindowHours: 0 }) },
    sale: { create: jest.fn(async (args: any) => { saleRows.push(args.data); return {}; }) },
    saleItem: { create: async () => ({}) },
    payment: { create: jest.fn(async (args: any) => { created.push(args.data); return {}; }) },
    receivingAccount: { findFirst: async ({ where }: any) => ACCOUNTS.get((where.id as Buffer).toString('hex')) ?? null },
    notification: { create: async () => ({}) },
    rollupRequest: { createMany: async () => ({}) },
    dailyClosing: { update: jest.fn(), updateMany: jest.fn() },
    closingEvent: { create: jest.fn() },
    $queryRaw: jest.fn(async (query: { sql: string }) => (/FROM closing_events/.test(query.sql) ? [{ one: 1 }] : [])),
    // The day's money version (D159), moved by the counter's check.
    $executeRaw: jest.fn(async () => 1),
  };
  const db: any = {
    closingEvent: { findFirst: jest.fn(async () => ({ id: Buffer.alloc(16, 7) })) },
    sale: { findFirst: jest.fn(async () => null), findUnique: async () => null },
    dailyClosing: { findUnique: jest.fn(async () => null) },
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  };
  const tenant: any = { companyId: () => COMPANY, requireBranchId: () => BRANCH, userId: () => USER };
  const businessDay: any = { today: jest.fn(async () => DAY), assign: jest.fn(async () => DAY) };
  const audit: any = { recordTx: jest.fn(async (_tx: unknown, p: Record<string, any>) => { audits.push(p); }) };
  const closing = new ClosingService(db, tenant, audit, {} as never, {} as never, businessDay, {} as never, {} as never, {} as never);
  const service = new SalesService(
    db,
    tenant,
    audit,
    new SalesPolicyService(),
    { resolveForSaleTx: jest.fn(async () => ({ price: 899 })) } as never,
    { next: jest.fn(async () => '00043') } as never,
    { emit: jest.fn() } as never,
    { get: () => new Set() } as never,
    { consume: jest.fn(async () => null) } as never,
    { configuredPrice: jest.fn(() => null), medianSalePrice: jest.fn(async () => null) } as never,
    { check: jest.fn(() => ({ ok: true })) } as never,
    businessDay,
    closing,
  );
  const saleAudit = () => audits.find((a) => a.entityType === 'Sale' && a.action === 'create');
  const byAccount = (acct: string | null) =>
    created.find((d) => (acct === null ? d.receivingAccountId === null : (d.receivingAccountId as Buffer | null)?.equals(uuidToBin(acct))));
  return { service, tx, db, created, audits, saleRows, saleAudit, byAccount };
}

const sell = (payments: Record<string, unknown>[]) => ({ clientUuid: KEY, lines: [{ identifier: IMEI, price: 899 }], payments });

describe('a sale stores each part’s own payer number', () => {
  it('a single Bankily payment: the number normalised, on that payment, and in the audit', async () => {
    const h = saleHarness();
    await h.service.createSale(sell([{ method: 'mobile', amount: 899, receivingAccountId: ACCT_A, payerNumber: ' +222 36 12-34-56 ' }]) as never);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ method: 'mobile', payerNumber: '+22236123456' });
    expect(h.saleAudit()!.after.payerNumbers).toEqual([{ method: 'mobile', amount: 899, payerNumber: '+22236123456' }]);
  });

  it('blank is optional: nothing stored, nothing audited', async () => {
    const h = saleHarness();
    await h.service.createSale(sell([{ method: 'mobile', amount: 899, receivingAccountId: ACCT_A, payerNumber: '   ' }]) as never);
    expect(h.created[0].payerNumber).toBeNull();
    expect(h.saleAudit()!.after).not.toHaveProperty('payerNumbers');
  });

  it('cash stores none and sends none', async () => {
    const h = saleHarness();
    await h.service.createSale(sell([{ method: 'cash', amount: 899 }]) as never);
    expect(h.created[0]).toMatchObject({ method: 'cash', receivingAccountId: null, payerNumber: null });
  });

  it('a four-way split: each non-cash part keeps its own number, cash none — whatever order the parts arrive in', async () => {
    const parts = [
      { method: 'cash', amount: 200 },
      { method: 'mobile', amount: 300, receivingAccountId: ACCT_A, payerNumber: '36 11 11 11' },
      { method: 'mobile', amount: 199, receivingAccountId: ACCT_B, payerNumber: '+222-36-22-22-22' },
      { method: 'mobile', amount: 200, receivingAccountId: ACCT_C },
    ];
    for (const order of [parts, [...parts].reverse(), [parts[2], parts[0], parts[3], parts[1]]]) {
      const h = saleHarness();
      await h.service.createSale(sell(order) as never);
      expect(h.created).toHaveLength(4);
      expect(h.byAccount(ACCT_A)).toMatchObject({ amount: 300, payerNumber: '36111111' });
      expect(h.byAccount(ACCT_B)).toMatchObject({ amount: 199, payerNumber: '+22236222222' });
      expect(h.byAccount(ACCT_C)).toMatchObject({ amount: 200, payerNumber: null });
      expect(h.byAccount(null)).toMatchObject({ method: 'cash', amount: 200, payerNumber: null });
    }
  });

  it('a fifth method is still refused, payer numbers or not; nothing is written', async () => {
    const h = saleHarness();
    const e = await asyncRefusal(() =>
      h.service.createSale(
        sell([
          { method: 'cash', amount: 100 },
          { method: 'mobile', amount: 100, receivingAccountId: ACCT_A, payerNumber: '1' },
          { method: 'mobile', amount: 100, receivingAccountId: ACCT_B, payerNumber: '2' },
          { method: 'mobile', amount: 100, receivingAccountId: ACCT_C, payerNumber: '3' },
          { method: 'bank', amount: 100, receivingAccountId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', payerNumber: '4' },
        ]) as never,
      ),
    );
    expect((e as BadRequestException).getResponse()).toMatchObject({ code: 'too_many_payment_methods' });
    expect(h.created).toHaveLength(0);
  });

  it('a number on cash, or a malformed one, refuses the sale before anything is written', async () => {
    for (const [payments, code] of [
      [[{ method: 'cash', amount: 899, payerNumber: '36123456' }], 'payer_number_cash'],
      [[{ method: 'mobile', amount: 899, receivingAccountId: ACCT_A, payerNumber: 'MR13 0002' }], 'payer_number_invalid'],
    ] as const) {
      const h = saleHarness();
      const e = await asyncRefusal(() => h.service.createSale(sell(payments as never) as never));
      expect((e as BadRequestException).getResponse()).toMatchObject({ code });
      expect(h.created).toHaveLength(0);
      expect(h.saleRows).toHaveLength(0);
    }
  });

  it('changes no figure: total, paid, owed and status are the same with or without payer numbers', async () => {
    const pick = (d: Record<string, unknown>) => ({ total: d.total, amountPaid: d.amountPaid, balanceDue: d.balanceDue, payStatus: d.payStatus, margin: d.margin, discount: d.discount });
    const without = saleHarness();
    await without.service.createSale(sell([{ method: 'cash', amount: 400 }, { method: 'mobile', amount: 499, receivingAccountId: ACCT_A }]) as never);
    const withNumbers = saleHarness();
    await withNumbers.service.createSale(sell([{ method: 'cash', amount: 400 }, { method: 'mobile', amount: 499, receivingAccountId: ACCT_A, payerNumber: '36123456' }]) as never);
    expect(pick(withNumbers.saleRows[0])).toEqual(pick(without.saleRows[0]));
    expect(withNumbers.created.map((d) => [d.method, d.amount])).toEqual(without.created.map((d) => [d.method, d.amount]));
  });
});

// ── one key, one sale: the payer number is part of what the key recorded ─────

function replayHarness(stored: Record<string, unknown>[]) {
  const db: any = {
    sale: { findFirst: jest.fn(async () => ({ id: SALE, invoiceNo: '00042', total: 899, margin: 199, balanceDue: 0, payStatus: 'paid', soldAt: new Date('2026-10-07T03:00:00Z'), returnWindowHours: 0, returnDeadlineAt: null, discount: 0 })) },
    saleItem: { findMany: jest.fn(async () => [{ unitId: UNIT, productId: null, quantity: 1, price: 899 }]) },
    payment: { findMany: jest.fn(async () => stored) },
    unit: { findFirst: jest.fn(async () => ({ id: UNIT })) },
    $transaction: jest.fn(async () => { throw new Error('the transaction must not run on a replay'); }),
  };
  const tenant: any = { companyId: () => COMPANY, requireBranchId: () => BRANCH, userId: () => USER };
  const policy: any = { round: (n: number) => Math.round(n * 100) / 100 };
  const service = new SalesService(
    db, tenant, {} as never, policy, {} as never, {} as never, {} as never, { get: () => new Set() } as never, {} as never, {} as never, {} as never,
    { assign: async () => DAY, today: async () => DAY } as never,
    { assertCounterOpen: async () => undefined, assertCounterOpenTx: async () => undefined, afterSaleCommitted: async () => undefined } as never,
  );
  return { service, db };
}

const stored = [
  { method: 'mobile', amount: 500, receivingAccountId: uuidToBin(ACCT_A), payerNumber: '36111111' },
  { method: 'mobile', amount: 399, receivingAccountId: uuidToBin(ACCT_B), payerNumber: '36222222' },
];
const replayOf = (payments: Record<string, unknown>[]) => ({ clientUuid: KEY, lines: [{ identifier: IMEI, price: 899 }], payments });

describe('a retry under the same key', () => {
  it('replays the same body — in any order, however the numbers were spaced', async () => {
    for (const payments of [
      [{ method: 'mobile', amount: 500, receivingAccountId: ACCT_A, payerNumber: '36111111' }, { method: 'mobile', amount: 399, receivingAccountId: ACCT_B, payerNumber: '36222222' }],
      [{ method: 'mobile', amount: 399, receivingAccountId: ACCT_B, payerNumber: '36 22-22-22' }, { method: 'mobile', amount: 500, receivingAccountId: ACCT_A, payerNumber: '36 11 11 11' }],
    ]) {
      const { service, db } = replayHarness(stored);
      const r = (await service.createSale(replayOf(payments) as never)) as { invoiceNo: string };
      expect(r.invoiceNo).toBe('00042');
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  });

  it('refuses a different number, a dropped number, and two parts swapping their numbers', async () => {
    for (const payments of [
      [{ method: 'mobile', amount: 500, receivingAccountId: ACCT_A, payerNumber: '36111112' }, { method: 'mobile', amount: 399, receivingAccountId: ACCT_B, payerNumber: '36222222' }],
      [{ method: 'mobile', amount: 500, receivingAccountId: ACCT_A }, { method: 'mobile', amount: 399, receivingAccountId: ACCT_B, payerNumber: '36222222' }],
      [{ method: 'mobile', amount: 500, receivingAccountId: ACCT_A, payerNumber: '36222222' }, { method: 'mobile', amount: 399, receivingAccountId: ACCT_B, payerNumber: '36111111' }],
    ]) {
      const { service, db } = replayHarness(stored);
      const e = await asyncRefusal(() => service.createSale(replayOf(payments) as never));
      expect(e).toBeInstanceOf(ConflictException);
      expect((e as ConflictException).getResponse()).toMatchObject({ code: 'idempotency_conflict' });
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  });

  it('a sale from before payer numbers still replays its old body', async () => {
    const { service } = replayHarness([{ method: 'cash', amount: 899 }]);
    const r = (await service.createSale(replayOf([{ method: 'cash', amount: 899 }]) as never)) as { invoiceNo: string };
    expect(r.invoiceNo).toBe('00042');
  });
});

describe('a later payment’s key', () => {
  const saleId = '018f0000-0000-7000-8000-000000000001';
  it('without a payer number, hashes exactly as before 0087 — a retry across the deploy is still itself', () => {
    const before = createHash('sha256')
      .update(JSON.stringify({ saleId, amount: '500.00', method: 'mobile', account: ACCT_A, paidAt: null, reference: null, note: null }))
      .digest('hex');
    expect(collectionFingerprint({ saleId, amount: 500, method: 'mobile', receivingAccountId: ACCT_A })).toBe(before);
    expect(collectionFingerprint({ saleId, amount: 500, method: 'mobile', receivingAccountId: ACCT_A, payerNumber: null })).toBe(before);
  });
  it('with one, is bound to it: another number is another payment', () => {
    const a = collectionFingerprint({ saleId, amount: 500, method: 'mobile', receivingAccountId: ACCT_A, payerNumber: '36111111' });
    expect(a).toBe(collectionFingerprint({ saleId, amount: 500, method: 'mobile', receivingAccountId: ACCT_A, payerNumber: '36111111' }));
    expect(a).not.toBe(collectionFingerprint({ saleId, amount: 500, method: 'mobile', receivingAccountId: ACCT_A, payerNumber: '36111112' }));
    expect(a).not.toBe(collectionFingerprint({ saleId, amount: 500, method: 'mobile', receivingAccountId: ACCT_A }));
  });
});

// ── correcting the number: a record correction that moves no money ───────────

function correctionHarness(payment: Record<string, unknown> | null, branch: Buffer = BRANCH) {
  const updates: Record<string, any>[] = [];
  const audits: Record<string, any>[] = [];
  const tx: any = { payment: { update: jest.fn(async (args: any) => { updates.push(args); return {}; }) } };
  const db: any = {
    payment: { findFirst: jest.fn(async ({ where }: any) => (payment && (where.sale.branchId as Buffer).equals(BRANCH) ? payment : null)) },
    sale: {
      findFirst: jest.fn(async () => ({ id: SALE, invoiceNo: '00042', total: 899, amountPaid: 899, balanceDue: 0, payStatus: 'paid', payments: [] })),
    },
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  };
  const tenant: any = { companyId: () => COMPANY, requireBranchId: () => branch, userId: () => USER };
  const audit: any = { recordTx: jest.fn(async (_tx: unknown, p: Record<string, any>) => { audits.push(p); }) };
  const service = new SalePaymentsService(db, tenant, audit, {} as never, {} as never);
  return { service, db, updates, audits };
}

const saleUuid = binToUuid(SALE);
const paymentUuid = binToUuid(PAYMENT);

describe('correcting the payer number', () => {
  it('changes the number and nothing else, audited with before and after', async () => {
    const h = correctionHarness({ id: PAYMENT, method: 'mobile', payerNumber: '36111111' });
    const state = await h.service.correctPayerNumber(saleUuid, paymentUuid, { payerNumber: '+222 36 11 11 12', reason: 'typo' });
    expect(state.invoiceNo).toBe('00042');
    expect(h.updates).toEqual([{ where: { id: PAYMENT }, data: { payerNumber: '+22236111112' } }]);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      entityType: 'Payment',
      action: 'update',
      reason: 'payer_number_corrected',
      before: { saleId: saleUuid, payerNumber: '36111111' },
      after: { saleId: saleUuid, payerNumber: '+22236111112', note: 'typo' },
    });
  });

  it('the same number again — however it is spaced — writes and audits nothing', async () => {
    const h = correctionHarness({ id: PAYMENT, method: 'mobile', payerNumber: '36111111' });
    await h.service.correctPayerNumber(saleUuid, paymentUuid, { payerNumber: '36 11-11-11' });
    expect(h.updates).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it('removing it is a change, audited', async () => {
    const h = correctionHarness({ id: PAYMENT, method: 'bank', payerNumber: '36111111' });
    await h.service.correctPayerNumber(saleUuid, paymentUuid, { payerNumber: null });
    expect(h.updates[0].data).toEqual({ payerNumber: null });
    expect(h.audits[0].after).toEqual({ saleId: saleUuid, payerNumber: null });
  });

  it('cash has no payer number to correct', async () => {
    const h = correctionHarness({ id: PAYMENT, method: 'cash', payerNumber: null });
    const e = await asyncRefusal(() => h.service.correctPayerNumber(saleUuid, paymentUuid, { payerNumber: '36111111' }));
    expect((e as BadRequestException).getResponse()).toMatchObject({ code: 'payer_number_cash' });
    expect(h.updates).toHaveLength(0);
  });

  it('another branch’s payment is not found — as an unknown one is', async () => {
    for (const h of [
      correctionHarness({ id: PAYMENT, method: 'mobile', payerNumber: '36111111' }, OTHER_BRANCH),
      correctionHarness(null),
    ]) {
      const e = await asyncRefusal(() => h.service.correctPayerNumber(saleUuid, paymentUuid, { payerNumber: '36111112' }));
      expect(e).toBeInstanceOf(NotFoundException);
      expect(h.updates).toHaveLength(0);
    }
  });

  it('writes ONLY the payer number onto the payment — never an amount, method, account or day', () => {
    const src = readFileSync(join(__dirname, 'sale-payments.service.ts'), 'utf8').replace(/\r\n/g, '\n');
    const method = src.slice(src.indexOf('async correctPayerNumber'), src.indexOf('private async replay'));
    const writes = method.match(/tx\.payment\.\w+\([^)]*\)/g) ?? [];
    expect(writes).toEqual(['tx.payment.update({ where: { id: paymentId }, data: { payerNumber: next } })']);
  });

  it('is held by whoever may request a money correction: Owner and Store Manager', () => {
    const perms: string[] = Reflect.getMetadata(REQUIRE_PERMISSIONS_KEY, SalesController.prototype.correctPayerNumber) ?? [];
    expect(perms).toEqual(['financial.correction.request']);
  });
});

describe('reading it back', () => {
  it('sale detail returns it beside the reference — and still never the key or its hash', () => {
    expect(paymentSelect).toMatchObject({ payerNumber: true, reference: true });
    expect(paymentSelect).not.toHaveProperty('clientUuid');
    expect(paymentSelect).not.toHaveProperty('clientRequestHash');
    const view = toPaymentView({
      id: PAYMENT,
      kind: 'at_sale',
      method: 'mobile',
      amount: 300 as never,
      paidAt: new Date('2026-10-07T03:00:00Z'),
      reference: 'TX-1',
      note: null,
      accountLabelSnapshot: 'Bankily',
      accountProviderSnapshot: 'bankily',
      payerNumber: '36111111',
      recordedBy: { name: 'Owner' },
    });
    expect(view).toMatchObject({ reference: 'TX-1', payerNumber: '36111111', accountLabel: 'Bankily' });
  });

  it('a money correction keeps the payer number in what it recorded about the payment', () => {
    const src = readFileSync(join(__dirname, '..', 'corrections', 'correction-targets.ts'), 'utf8');
    const plan = src.slice(src.indexOf('export async function planSalePayment'), src.indexOf('const saleState = openOrApproved'));
    expect(plan).toMatch(/payerNumber: true,/);
    expect(plan).toMatch(/payerNumber: p\.payerNumber,/);
  });
});

describe('nowhere a customer, a report or a notification would show it', () => {
  /**
   * Every file outside the tests that names the payer number. A new one — a
   * report, an export, a notification, a WhatsApp template, a closing digest —
   * fails here until somebody decides it belongs there (docs/21 D151).
   */
  const ALLOWED = [
    'account/account-deletion.service.ts',
    'corrections/correction-targets.ts',
    'sales/dto/correct-payer-number.dto.ts',
    'sales/dto/create-sale.dto.ts',
    'sales/dto/record-payment.dto.ts',
    'sales/payer-number.ts',
    'sales/sale-payment-rules.ts',
    'sales/sale-payments.service.ts',
    'sales/sales.controller.ts',
    'sales/sales.service.ts',
  ];
  it('is named only where it is taken, stored, compared, corrected, read on the sale, or erased', () => {
    const root = join(__dirname, '..');
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && /payerNumber|payer_number/.test(readFileSync(path, 'utf8'))) {
          found.push(relative(root, path).split(sep).join('/'));
        }
      }
    };
    walk(root);
    expect(found.sort()).toEqual(ALLOWED);
  });
});
