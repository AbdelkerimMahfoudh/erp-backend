import { ConflictException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SalePaymentsService } from './sale-payments.service';
import { ClosingService } from '../closing/closing.service';

/**
 * A later payment on a debt while the business day is closed (docs/61): refused
 * like a sale or a receipt — 409 `store_closed`, nothing written, nothing
 * reopened — for any client, an older app build or a direct call alike. The
 * refused key leaves no trace, so after the store is opened the same key records
 * the payment for real instead of replaying a success that never happened.
 */

const COMPANY = Buffer.alloc(16, 1);
const BRANCH = Buffer.alloc(16, 2);
const USER = Buffer.alloc(16, 3);
const SALE = '0190a8c0-0000-7000-8000-000000000001';
const DAY = '2026-09-27';
type Status = 'counting' | 'counted' | 'locked' | 'reopened';

const dto = () => ({ clientUuid: '0190a8c0-0000-7000-8000-0000000000aa', amount: 500, method: 'cash' as const });

/** The real ClosingService refusal checks over a stubbed database: the early read, then the locked row. */
function closingWith(early: Status | null, locked: Status | null) {
  const tenant: any = { companyId: () => COMPANY, requireBranchId: () => BRANCH, userId: () => USER };
  const db: any = { dailyClosing: { findUnique: jest.fn(async () => (early ? { status: early } : null)) } };
  const businessDay: any = { today: jest.fn(async () => DAY) };
  const closing = new ClosingService(db, tenant, {} as never, {} as never, {} as never, businessDay, {} as never, {} as never, {} as never);
  const tx: any = {
    $queryRaw: jest.fn(async () => (locked ? [{ status: locked }] : [])),
    dailyClosing: { update: jest.fn(), findUnique: jest.fn() },
    closingEvent: { create: jest.fn() },
  };
  return { closing, tx };
}

function harness(opts: { early?: Status | null; locked?: Status | null; replayed?: boolean } = {}) {
  const { closing, tx: closingTx } = closingWith(opts.early ?? null, opts.locked ?? null);
  const written = { payments: 0, sales: 0 };
  // Past the day check the transaction stops here: what matters is that it was, or was not, reached.
  const reached = new Error('reached the recording');
  const tx: any = {
    ...closingTx,
    $queryRaw: jest.fn(async (sql: { strings?: string[] }) => {
      const text = (sql.strings ?? []).join('?');
      if (/FROM daily_closings/.test(text)) return closingTx.$queryRaw();
      return [{ id: Buffer.alloc(16, 9), total: 1500, amount_paid: 500, balance_due: 1000, sold_at: new Date('2026-09-20T10:00:00Z'), is_reversed: 0, customer_id: null, branch_id: BRANCH }];
    }),
    financialCorrection: { findFirst: jest.fn(async () => null) },
    receivingAccount: { findFirst: jest.fn() },
    payment: { create: jest.fn(async () => { written.payments += 1; throw reached; }) },
    sale: { update: jest.fn(async () => { written.sales += 1; }) },
  };
  const db: any = {
    payment: { findFirst: jest.fn(async () => (opts.replayed ? { id: Buffer.alloc(16, 5), saleId: Buffer.alloc(16, 9), clientRequestHash: 'x' } : null)) },
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  };
  const tenant: any = { companyId: () => COMPANY, requireBranchId: () => BRANCH, userId: () => USER };
  const businessDay: any = { assign: jest.fn(async () => DAY), today: jest.fn(async () => DAY) };
  const service = new SalePaymentsService(db, tenant, { recordTx: jest.fn() } as never, businessDay, closing);
  return { service, db, tx, closingTx, written, reached };
}

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ConflictException;
  }
  throw new Error('expected a refusal');
};

describe('a later payment on a debt while the business day is closed', () => {
  it('is refused with store_closed before any transaction: nothing written, nothing reopened', async () => {
    const h = harness({ early: 'locked' });
    const e = await refusal(h.service.record(SALE, dto()));
    expect(e).toBeInstanceOf(ConflictException);
    expect((e.getResponse() as { code: string; message: string }).code).toBe('store_closed');
    expect((e.getResponse() as { message: string }).message).toBe(
      `The store is closed for business day ${DAY}. Nothing was recorded: the Owner or a named delegate must open the store first.`,
    );
    expect(h.db.$transaction).not.toHaveBeenCalled();
    expect(h.written).toEqual({ payments: 0, sales: 0 });
  });

  it('is refused on the locked row when the day closed after the first check — and nothing reopens', async () => {
    const h = harness({ early: 'reopened', locked: 'locked' });
    const e = await refusal(h.service.record(SALE, dto()));
    expect((e.getResponse() as { code: string }).code).toBe('store_closed');
    expect(h.written).toEqual({ payments: 0, sales: 0 });
    expect(h.closingTx.dailyClosing.update).not.toHaveBeenCalled();
    expect(h.closingTx.closingEvent.create).not.toHaveBeenCalled();
  });

  it('goes on to record once the store is open — the same key, nothing replayed', async () => {
    const closed = harness({ early: 'locked' });
    await refusal(closed.service.record(SALE, dto()));
    // Opened: the same request key now reaches the recording, because the refusal stored nothing under it.
    const open = harness({ early: 'reopened', locked: 'reopened' });
    await expect(open.service.record(SALE, dto())).rejects.toBe(open.reached);
    expect(open.written.payments).toBe(1);
  });

  it('a day never closed, or still being counted, is open', async () => {
    for (const status of [null, 'counting', 'counted'] as const) {
      const h = harness({ early: status, locked: status });
      await expect(h.service.record(SALE, dto())).rejects.toBe(h.reached);
    }
  });
});

describe('the open-first rule for payments, in the source', () => {
  const code = (file: string) =>
    readFileSync(join(__dirname, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  const service = code('sale-payments.service.ts');

  it('checks after the replay and before the transaction, then again on the locked row', () => {
    const replay = service.indexOf('if (replay) return replay;');
    const early = service.indexOf("await this.closing.assertCounterOpen(branchId, 'payment');");
    expect(early).toBeGreaterThan(replay);
    expect(early).toBeLessThan(service.indexOf('this.db.$transaction('));
    expect(service).toMatch(/if \(day === today\) \{\s*await this\.closing\.assertCounterOpenTx\(tx, \{ branchId, businessDate: day, operation: 'payment' \}\);\s*\} else \{\s*assertDayOpen\(closing, day\);/);
  });

  it('no path reopens a day any more', () => {
    for (const file of ['sale-payments.service.ts', 'sales.service.ts', '../purchasing/purchasing.service.ts', '../closing/closing.service.ts']) {
      expect(code(file)).not.toMatch(/autoReopenTx|afterReopenCommitted/);
    }
  });
});
