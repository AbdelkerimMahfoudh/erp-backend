import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ExpensesService } from './expenses.service';

/**
 * Confirming an expense takes the day it lands on as the close locks it (D159, docs/73 §11.2): inside the
 * confirmation's own transaction, after the expense's compare-and-swap, before the recompute is requested. A
 * variable expense lands on today; a fixed one on its due date — on an earlier day, the closing's lock also moves
 * every later day still open (its own tests). The lock's refusal of a closed day rolls the confirmation back.
 */

const COMPANY = Buffer.alloc(16, 1);
const BRANCH = Buffer.alloc(16, 2);
const USER = Buffer.alloc(16, 3);
const EXPENSE = Buffer.alloc(16, 4);
const TODAY = '2026-10-10';
const ID = '01a0b1c2-0000-7000-8000-0000000000e1';

function harness(opts: { fixedDue?: string; won?: number; dayClosed?: boolean } = {}) {
  const order: string[] = [];
  const tx = {
    expense: {
      updateMany: jest.fn(async () => {
        order.push('expense');
        return { count: opts.won ?? 1 };
      }),
    },
    rollupRequest: { createMany: jest.fn(async () => void order.push('rollup')) },
  };
  const db = { $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)) };
  const closing = {
    lockDayForMoneyTx: jest.fn(async () => {
      order.push('day');
      if (opts.dayClosed) throw new ConflictException({ code: 'day_already_closed', message: 'closed' });
    }),
  };
  const audit = { record: jest.fn(async () => undefined) };
  const rollups = { processNow: jest.fn(async () => undefined) };
  const svc = new ExpensesService(
    db as never,
    { companyId: () => COMPANY, userId: () => USER } as never,
    audit as never,
    {} as never,
    rollups as never,
    {} as never,
    { today: jest.fn(async () => TODAY) } as never,
    closing as never,
  );
  const expense = {
    id: EXPENSE,
    branchId: BRANCH,
    status: 'reported',
    amount: new Prisma.Decimal(800),
    note: 'transport',
    expenseClass: opts.fixedDue ? 'fixed' : 'variable',
    dueDate: opts.fixedDue ? new Date(`${opts.fixedDue}T00:00:00.000Z`) : null,
  };
  Object.assign(svc, { load: jest.fn(async () => expense), detail: jest.fn(async () => ({ id: ID })) });
  return { svc, tx, closing, audit, order };
}

describe('POST expenses/:id/confirm — the day it lands on, locked as the close locks it (D159)', () => {
  it('a variable expense: today’s row, after the expense’s own and before the recompute, in the one transaction', async () => {
    const h = harness();
    await h.svc.confirm(ID, { expectedVersion: 0 });
    expect(h.closing.lockDayForMoneyTx).toHaveBeenCalledWith(h.tx, { branchId: BRANCH, businessDate: TODAY, operation: 'expense_confirmation' });
    expect(h.order).toEqual(['expense', 'day', 'rollup']);
  });

  it('a fixed expense: the row of its due date — an earlier day too, whose later days the lock moves', async () => {
    const h = harness({ fixedDue: '2026-10-07' });
    await h.svc.confirm(ID, { expectedVersion: 0 });
    expect(h.closing.lockDayForMoneyTx).toHaveBeenCalledWith(h.tx, { branchId: BRANCH, businessDate: '2026-10-07', operation: 'expense_confirmation' });
  });

  it('a closed day refuses it under the lock: the refusal is the answer, nothing requested, nothing audited', async () => {
    const h = harness({ dayClosed: true });
    const e = await h.svc.confirm(ID, { expectedVersion: 0 }).catch((x: unknown) => x);
    expect((e as ConflictException).getResponse()).toMatchObject({ code: 'day_already_closed' });
    expect(h.tx.rollupRequest.createMany).not.toHaveBeenCalled();
    expect(h.audit.record).not.toHaveBeenCalled();
  });

  it('a stale version moves nothing: no day is locked, and the person is sent back to the expense', async () => {
    const h = harness({ won: 0 });
    const e = await h.svc.confirm(ID, { expectedVersion: 0 }).catch((x: unknown) => x);
    expect((e as ConflictException).getResponse()).toMatchObject({ code: 'refresh_required' });
    expect(h.closing.lockDayForMoneyTx).not.toHaveBeenCalled();
  });
});
