import { BadRequestException, ConflictException } from '@nestjs/common';
import { SalePaymentsService } from './sale-payments.service';
import { resolvePaidAt, sameMinute } from './sale-payment-rules';
import { ClosingService } from '../closing/closing.service';
import { businessDateOf } from '../common/business-day';

/**
 * A later payment in the same displayed minute as its sale (docs/61 §9).
 *
 * The phone sends a minute (10:15 → 10:15:00); the sale is an instant inside a
 * minute (10:15:47). A payment in the sale's own minute is valid and is stored
 * at the sale's instant — never before it, still in its minute and its
 * business day. A payment in an earlier minute is still refused.
 */

const at = (iso: string) => new Date(iso);
const NOW = at('2026-09-28T12:00:00.000Z');
const paid = (requested: string, soldAt: string) => resolvePaidAt(requested, at(soldAt), NOW);
const refusedCode = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return ((e as BadRequestException).getResponse() as { code: string }).code;
  }
  throw new Error('expected a refusal');
};

describe('a payment in the same displayed minute as its sale', () => {
  it('sale at 10:15:00, payment at 10:15 — accepted as sent', () => {
    expect(paid('2026-09-27T10:15:00.000Z', '2026-09-27T10:15:00.000Z').toISOString()).toBe('2026-09-27T10:15:00.000Z');
  });

  it('sale at 10:15:47, payment at 10:15 — accepted, stored at the sale’s instant, never before it', () => {
    const p = paid('2026-09-27T10:15:00.000Z', '2026-09-27T10:15:47.000Z');
    expect(p.toISOString()).toBe('2026-09-27T10:15:47.000Z');
    expect(sameMinute(p, at('2026-09-27T10:15:00.000Z'))).toBe(true);
  });

  it('sale at 10:15:59.999, payment at 10:15 — accepted at 10:15:59.999', () => {
    expect(paid('2026-09-27T10:15:00.000Z', '2026-09-27T10:15:59.999Z').toISOString()).toBe('2026-09-27T10:15:59.999Z');
  });

  it('payment at 10:14 — refused, whatever second the sale fell on', () => {
    for (const sold of ['2026-09-27T10:15:00.000Z', '2026-09-27T10:15:47.000Z', '2026-09-27T10:15:59.999Z']) {
      expect(refusedCode(() => paid('2026-09-27T10:14:00.000Z', sold))).toBe('paid_at_before_sale');
    }
    // One millisecond into the earlier minute is the earlier minute.
    expect(refusedCode(() => paid('2026-09-27T10:14:59.999Z', '2026-09-27T10:15:00.000Z'))).toBe('paid_at_before_sale');
  });

  it('payment at 10:16 — accepted as sent', () => {
    expect(paid('2026-09-27T10:16:00.000Z', '2026-09-27T10:15:47.000Z').toISOString()).toBe('2026-09-27T10:16:00.000Z');
  });

  it('the future is still refused', () => {
    expect(refusedCode(() => paid('2026-09-28T12:05:00.000Z', '2026-09-27T10:15:47.000Z'))).toBe('paid_at_future');
  });

  it('midnight: a sale at 23:59:40 and a payment at 23:59 stay on the sale’s business day', () => {
    const tz = 'UTC';
    const p = paid('2026-09-27T23:59:00.000Z', '2026-09-27T23:59:40.000Z');
    expect(p.toISOString()).toBe('2026-09-27T23:59:40.000Z');
    expect(businessDateOf(p, tz)).toBe(businessDateOf(at('2026-09-27T23:59:40.000Z'), tz));
    // 00:00 is the next calendar minute: accepted as sent; before 06:00 it is still the 27th's business day.
    const next = paid('2026-09-28T00:00:00.000Z', '2026-09-27T23:59:40.000Z');
    expect(next.toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect(businessDateOf(next, tz)).toBe('2026-09-27');
  });

  it('before 06:00: a payment in the sale’s minute keeps the sale’s business day; 06:00 is the next day’s, as sent', () => {
    const tz = 'UTC';
    const sold = '2026-09-28T05:59:30.000Z';
    const same = paid('2026-09-28T05:59:00.000Z', sold);
    expect(same.toISOString()).toBe(sold);
    expect(businessDateOf(same, tz)).toBe('2026-09-27');
    expect(businessDateOf(same, tz)).toBe(businessDateOf(at(sold), tz));
    const six = paid('2026-09-28T06:00:00.000Z', sold);
    expect(six.toISOString()).toBe('2026-09-28T06:00:00.000Z');
    expect(businessDateOf(six, tz)).toBe('2026-09-28');
    expect(refusedCode(() => paid('2026-09-28T05:58:00.000Z', sold))).toBe('paid_at_before_sale');
  });

  it('the store’s time zone differs from the phone’s and the server’s: the same minute is the same minute', () => {
    // Store in India (+05:30): the sale at 10:15:47 in the store is 04:45:47Z.
    const soldIndia = '2026-09-27T04:45:47.000Z';
    for (const phone of ['2026-09-27T10:15:00+05:30', '2026-09-27T04:45:00Z', '2026-09-27T05:45:00+01:00']) {
      const p = paid(phone, soldIndia);
      expect(p.toISOString()).toBe(soldIndia);
      expect(businessDateOf(p, 'Asia/Kolkata')).toBe(businessDateOf(at(soldIndia), 'Asia/Kolkata'));
    }
    expect(refusedCode(() => paid('2026-09-27T10:14:00+05:30', soldIndia))).toBe('paid_at_before_sale');
    // Nepal (+05:45): still whole minutes.
    const soldNepal = '2026-09-27T04:30:47.000Z';
    expect(paid('2026-09-27T10:15:00+05:45', soldNepal).toISOString()).toBe(soldNepal);
    expect(refusedCode(() => paid('2026-09-27T10:14:00+05:45', soldNepal))).toBe('paid_at_before_sale');
  });
});

// ── through the service: replay, a changed payload, the closed store, the opening ──

const COMPANY = Buffer.alloc(16, 1);
const BRANCH = Buffer.alloc(16, 2);
const USER = Buffer.alloc(16, 3);
const SALE_ID = '0190a8c0-0000-7000-8000-000000000001';
const SALE_BIN = Buffer.from(SALE_ID.replace(/-/g, ''), 'hex');
const SOLD_AT = at('2026-09-27T10:15:47.000Z');
const KEY = '0190a8c0-0000-7000-8000-0000000000aa';
const body = (over: Partial<{ amount: number; paidAt: string }> = {}) => ({
  clientUuid: KEY,
  amount: 500,
  method: 'cash' as const,
  paidAt: '2026-09-27T10:15:00.000Z',
  ...over,
});

/** A small in-memory shop: one sale owing 1 000, its payments, and a day that may be closed. */
function shop() {
  const state = { closed: false, payments: [] as { id: Buffer; clientUuid: Buffer; clientRequestHash: string; paidAt: Date; amount: number; businessDate: Date }[], paid: 500, audits: [] as unknown[] };
  const tenant: any = { companyId: () => COMPANY, requireBranchId: () => BRANCH, userId: () => USER };
  const businessDay: any = {
    assign: jest.fn(async (_b: Buffer, instant: Date) => businessDateOf(instant, 'UTC')),
    today: jest.fn(async () => '2026-09-27'),
  };
  const closingDb: any = { dailyClosing: { findUnique: jest.fn(async () => (state.closed ? { status: 'locked' } : { status: 'reopened' })) } };
  const closing = new ClosingService(closingDb, tenant, {} as never, {} as never, {} as never, businessDay, {} as never, {} as never, {} as never);
  const tx: any = {
    $queryRaw: jest.fn(async (sql: { strings?: string[] }) => {
      const text = (sql.strings ?? []).join('?');
      if (/FROM daily_closings/.test(text)) return [{ status: state.closed ? 'locked' : 'reopened' }];
      return [{ id: SALE_BIN, total: 1500, amount_paid: state.paid, balance_due: 1500 - state.paid, sold_at: SOLD_AT, is_reversed: 0, customer_id: null, branch_id: BRANCH }];
    }),
    financialCorrection: { findFirst: jest.fn(async () => null) },
    dailyClosing: { findUnique: jest.fn(async () => null) },
    receivingAccount: { findFirst: jest.fn() },
    payment: {
      create: jest.fn(async ({ data }: { data: any }) => {
        state.payments.push({ id: data.id, clientUuid: data.clientUuid, clientRequestHash: data.clientRequestHash, paidAt: data.paidAt, amount: data.amount, businessDate: data.businessDate });
      }),
    },
    sale: { update: jest.fn(async ({ data }: { data: { amountPaid: number } }) => { state.paid = data.amountPaid; }) },
    customer: { update: jest.fn() },
  };
  const db: any = {
    payment: {
      findFirst: jest.fn(async ({ where }: { where: { clientUuid: Buffer } }) => {
        const p = state.payments.find((x) => x.clientUuid.equals(where.clientUuid));
        return p ? { saleId: SALE_BIN, clientRequestHash: p.clientRequestHash } : null;
      }),
    },
    sale: {
      findFirst: jest.fn(async () => ({
        id: SALE_BIN,
        invoiceNo: '00042',
        total: 1500,
        amountPaid: state.paid,
        balanceDue: 1500 - state.paid,
        payStatus: state.paid >= 1500 ? 'paid' : 'partial',
        payments: [...state.payments]
          .sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime())
          .map((p) => ({ id: p.id, kind: 'collection', method: 'cash', amount: p.amount, paidAt: p.paidAt, reference: null, note: null, accountLabelSnapshot: null, accountProviderSnapshot: null, recordedBy: { name: 'Owner' } })),
      })),
    },
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  };
  const audit = { recordTx: jest.fn(async (_tx: unknown, entry: unknown) => { state.audits.push(entry); }) };
  const service = new SalePaymentsService(db, tenant, audit as never, businessDay, closing);
  return { service, state, tx };
}

const thrown = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ConflictException;
  }
  throw new Error('expected a refusal');
};

describe('the same-minute payment through the service', () => {
  it('is recorded once, at the sale’s instant, on the sale’s business day; the chosen minute is audited', async () => {
    const s = shop();
    const answer = await s.service.record(SALE_ID, body());
    expect(s.state.payments).toHaveLength(1);
    expect(s.state.payments[0].paidAt.toISOString()).toBe(SOLD_AT.toISOString());
    expect(s.state.payments[0].businessDate.toISOString().slice(0, 10)).toBe('2026-09-27');
    expect(answer.received).toBe(1000);
    expect(answer.payments[0].paidAt.getTime()).toBeGreaterThanOrEqual(SOLD_AT.getTime());
    expect(s.state.audits[0]).toMatchObject({ after: { paidAt: SOLD_AT, paidAtRequested: '2026-09-27T10:15:00.000Z' } });
  });

  it('a duplicate retry returns the same payment and writes nothing more', async () => {
    const s = shop();
    const first = await s.service.record(SALE_ID, body());
    const again = await s.service.record(SALE_ID, body());
    expect(s.state.payments).toHaveLength(1);
    expect(again).toEqual(first);
    // The fingerprint keeps the minute: a retry a few seconds into it is the same payment.
    const later = await s.service.record(SALE_ID, body({ paidAt: '2026-09-27T10:15:30.000Z' }));
    expect(s.state.payments).toHaveLength(1);
    expect(later).toEqual(first);
  });

  it('the same key with a changed payload is refused, nothing written', async () => {
    const s = shop();
    await s.service.record(SALE_ID, body());
    const e = await thrown(s.service.record(SALE_ID, body({ amount: 600 })));
    expect(e).toBeInstanceOf(ConflictException);
    expect((e.getResponse() as { code: string }).code).toBe('idempotency_key_reused');
    expect(s.state.payments).toHaveLength(1);
  });

  it('an earlier minute is refused through the service too, nothing written', async () => {
    const s = shop();
    const e = await thrown(s.service.record(SALE_ID, body({ paidAt: '2026-09-27T10:14:00.000Z' })));
    expect((e as unknown as BadRequestException).getResponse()).toMatchObject({ code: 'paid_at_before_sale' });
    expect(s.state.payments).toHaveLength(0);
    expect(s.state.paid).toBe(500);
  });

  it('a closed store refuses it first — store_closed, nothing written — and after the opening it records once', async () => {
    const s = shop();
    s.state.closed = true;
    const e = await thrown(s.service.record(SALE_ID, body()));
    expect((e.getResponse() as { code: string }).code).toBe('store_closed');
    expect(s.state.payments).toHaveLength(0);
    expect(s.state.paid).toBe(500);
    expect(s.tx.payment.create).not.toHaveBeenCalled();
    // Refused again while still closed: never a replayed success.
    expect(((await thrown(s.service.record(SALE_ID, body()))).getResponse() as { code: string }).code).toBe('store_closed');
    s.state.closed = false;
    const answer = await s.service.record(SALE_ID, body());
    expect(s.state.payments).toHaveLength(1);
    expect(s.state.payments[0].paidAt.toISOString()).toBe(SOLD_AT.toISOString());
    expect(answer.received).toBe(1000);
    await s.service.record(SALE_ID, body());
    expect(s.state.payments).toHaveLength(1);
  });
});
