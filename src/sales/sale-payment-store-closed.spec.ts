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
const YESTERDAY = '2026-09-26';
type Status = 'counting' | 'counted' | 'locked' | 'reopened';

const dto = () => ({ clientUuid: '0190a8c0-0000-7000-8000-0000000000aa', amount: 500, method: 'cash' as const });

/** The real ClosingService refusal checks over a stubbed database: the early read, then the locked row. */
function closingWith(early: Status | null, locked: Status | null, opened = true) {
  const tenant: any = { companyId: () => COMPANY, requireBranchId: () => BRANCH, userId: () => USER };
  const db: any = {
    dailyClosing: { findUnique: jest.fn(async () => (early ? { status: early } : null)) },
    // Whether anybody opened the day (docs/63), as the plain read sees it.
    closingEvent: { findFirst: jest.fn(async () => (opened ? { id: Buffer.alloc(16, 7) } : null)) },
  };
  const businessDay: any = { today: jest.fn(async () => DAY) };
  const closing = new ClosingService(db, tenant, {} as never, {} as never, {} as never, businessDay, {} as never, {} as never, {} as never);
  const bumps: { sql: string; values: unknown[] }[] = [];
  const tx: any = {
    $queryRaw: jest.fn(async () => (locked ? [{ status: locked }] : [])),
    // The day's money version (D159): every bump the closing makes, in order.
    $executeRaw: jest.fn(async (query: { sql: string; values: unknown[] }) => {
      bumps.push(query);
      return 1;
    }),
    dailyClosing: { update: jest.fn(), findUnique: jest.fn() },
    closingEvent: { create: jest.fn() },
  };
  return { closing, tx, bumps };
}

function harness(opts: { early?: Status | null; locked?: Status | null; replayed?: boolean; unopened?: boolean; unopenedInside?: boolean; paidOn?: string } = {}) {
  const { closing, tx: closingTx, bumps } = closingWith(opts.early ?? null, opts.locked ?? null, !opts.unopened);
  const written = { payments: 0, sales: 0 };
  // Past the day check the transaction stops here: what matters is that it was, or was not, reached.
  const reached = new Error('reached the recording');
  const tx: any = {
    ...closingTx,
    $queryRaw: jest.fn(async (sql: { strings?: string[] }) => {
      const text = (sql.strings ?? []).join('?');
      if (/FROM daily_closings/.test(text)) return closingTx.$queryRaw();
      if (/FROM closing_events/.test(text)) return (opts.unopenedInside ?? opts.unopened) ? [] : [{ one: 1 }];
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
  const businessDay: any = { assign: jest.fn(async () => opts.paidOn ?? DAY), today: jest.fn(async () => DAY) };
  const service = new SalePaymentsService(db, tenant, { recordTx: jest.fn() } as never, businessDay, closing);
  return { service, db, tx, closingTx, written, reached, bumps };
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

  it('a day nobody opened is refused as not opened before the transaction: nothing written (docs/63)', async () => {
    const h = harness({ unopened: true });
    const e = await h.service.record(SALE, dto()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ConflictException);
    expect((e as ConflictException).getResponse()).toMatchObject({ code: 'store_closed', closedReason: 'not_opened', businessDate: DAY });
    expect(h.written.payments).toBe(0);
  });

  it('and inside the transaction when the day reads unopened there', async () => {
    const h = harness({ unopenedInside: true });
    const e = await h.service.record(SALE, dto()).catch((x: unknown) => x);
    expect((e as ConflictException).getResponse()).toMatchObject({ code: 'store_closed', closedReason: 'not_opened' });
    expect(h.written.payments).toBe(0);
  });

  it('a day never closed, or still being counted, is open once opened', async () => {
    for (const status of [null, 'counting', 'counted'] as const) {
      const h = harness({ early: status, locked: status });
      await expect(h.service.record(SALE, dto())).rejects.toBe(h.reached);
    }
  });

  it('on the current day, moves its money version under the lock the close takes (D159)', async () => {
    const h = harness({ early: 'counted', locked: 'counted' });
    await expect(h.service.record(SALE, dto())).rejects.toBe(h.reached);
    expect(h.bumps).toHaveLength(1);
    expect(h.bumps[0].sql).toMatch(/UPDATE daily_closings SET money_version = money_version \+ 1\s+WHERE company_id = \? AND branch_id = \? AND closing_date = \?/);
    expect(h.bumps[0].values).toEqual([COMPANY, BRANCH, DAY]);
  });
});

/**
 * A payment dated on an earlier day (D159): it never waited for that day's door, and still does not — but it takes
 * the day's row as the close locks it, is refused when that day is locked (by the rule it always followed), and
 * moves the money version of its own day and of every later day still open, whose opening it moved.
 */
describe('a later payment dated on an earlier day', () => {
  it('locks that day’s row, moves its money version, and moves every later day still open', async () => {
    const h = harness({ early: 'counting', locked: 'counted', paidOn: YESTERDAY });
    await expect(h.service.record(SALE, dto())).rejects.toBe(h.reached);
    const lock = h.tx.$queryRaw.mock.calls.map((c: [{ strings?: string[]; values?: unknown[] }]) => c[0]).find((q: { strings?: string[] }) => /FOR UPDATE/.test((q.strings ?? []).join('?')) && /FROM daily_closings/.test((q.strings ?? []).join('?')));
    expect(lock.values).toEqual([COMPANY, BRANCH, YESTERDAY]);
    expect(h.bumps.map((b) => b.values)).toEqual([
      [COMPANY, BRANCH, YESTERDAY],
      [COMPANY, BRANCH, YESTERDAY],
    ]);
    expect(h.bumps[1].sql).toMatch(/closing_date > \? AND status <> 'locked'/);
  });

  it('is refused on a locked day with the code and words it always had, nothing written and nothing moved', async () => {
    const h = harness({ early: 'counting', locked: 'locked', paidOn: YESTERDAY });
    const e = await refusal(h.service.record(SALE, dto()));
    expect(e.getResponse()).toEqual({
      code: 'day_already_closed',
      message: `${YESTERDAY} is already closed for this branch. Confirm this expense once the next day opens.`,
    });
    expect(h.written).toEqual({ payments: 0, sales: 0 });
    expect(h.bumps).toEqual([]);
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
    // D159: a back-dated payment takes its day's lock too, where it used to read the row plainly.
    expect(service).toMatch(/if \(day === today\) \{\s*await this\.closing\.assertCounterOpenTx\(tx, \{ branchId, businessDate: day, operation: 'payment' \}\);\s*\} else \{\s*await this\.closing\.lockDayForMoneyTx\(tx, \{ branchId, businessDate: day, operation: 'backdated_payment' \}\);/);
  });

  it('no path reopens a day any more', () => {
    for (const file of ['sale-payments.service.ts', 'sales.service.ts', '../purchasing/purchasing.service.ts', '../closing/closing.service.ts']) {
      expect(code(file)).not.toMatch(/autoReopenTx|afterReopenCommitted/);
    }
  });
});
