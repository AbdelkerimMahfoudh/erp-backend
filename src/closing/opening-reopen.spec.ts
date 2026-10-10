import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClosingService } from './closing.service';
import { dateValue } from '../common/business-day/business-day.service';

/**
 * The money a shop opens with, on the reopen and in the Owner's review (docs/63).
 * The service is driven with a mocked database, so what is asserted is exactly
 * what would be written — and, for a refusal, that nothing was.
 */

const branchId = Buffer.from('01a091c77f1e7f5db52a64ee21b95896', 'hex');
const companyId = Buffer.from('01a091c77eac76ada3384092cc1e12e4', 'hex');
const userId = Buffer.from('01a091c77f2b764da36774d37794e74f', 'hex');
const KEY = '0190a8c0-0000-7000-8000-0000000000bb';
const DAY = '2026-09-27';
const today = { businessDate: DAY, localDate: DAY, timezone: 'UTC', canStartEarly: false, startedEarly: false };
const locked = { id: Buffer.alloc(16, 4), status: 'locked', version: 3, reopenCount: 0, firstClosedAt: new Date('2026-09-27T20:00:00Z') };

interface Options {
  owner?: boolean;
  perform?: boolean;
  row?: typeof locked | { id: Buffer; status: string; version: number; reopenCount: number; firstClosedAt: Date | null } | null;
  opened?: boolean;
  won?: number;
  prior?: { businessDate: Date; clientRequestHash: string } | null;
  /** The day's latest opening, for the review. `cashAmount` null: the drawer was unknown when it was recorded. */
  opening?: { id: Buffer; decision: 'keep' | 'set' | 'carried'; cashAmount?: number | null; review: { id: Buffer } | null } | null;
  race?: boolean;
  /** The drawer as Money shows it now; null when unknown. */
  previous?: number | null;
  /** The day's row as the review's lock reads it (D159). */
  dayStatus?: string | null;
}

function build(opts: Options = {}) {
  const db = {
    dailyClosing: {
      findUnique: jest.fn().mockResolvedValue(opts.row === undefined ? locked : opts.row),
      updateMany: jest.fn().mockResolvedValue({ count: opts.won ?? 1 }),
    },
    closingEvent: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(opts.opened ? { id: Buffer.alloc(16, 8) } : null),
    },
    openingDecision: {
      // First the replay lookup by key, then — for a review — the day's opening.
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => ('clientUuid' in where ? (opts.prior ?? null) : (opts.opening ?? null))),
      create: jest.fn(async (_args: { data: Record<string, any> }) => {
        if (opts.race) throw new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' });
        return {};
      }),
    },
    // The day's lock and its money version (D159): what the lock reads, and every bump.
    $queryRaw: jest.fn(async (_sql: Prisma.Sql) => (opts.dayStatus === null ? [] : [{ status: opts.dayStatus ?? 'counting' }])),
    $executeRaw: jest.fn(async (_sql: Prisma.Sql) => 1),
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(db)),
  };
  const record = jest.fn().mockResolvedValue(undefined);
  const audit = { record, recordTx: jest.fn(async (_tx: unknown, entry: unknown) => record(entry)) };
  const permissions = new Set([
    'closing.count',
    ...(opts.perform !== false ? ['closing.perform'] : []),
    ...(opts.owner ? ['money.anchor.record'] : []),
  ]);
  const svc = Object.create(ClosingService.prototype) as ClosingService & Record<string, unknown>;
  const open = jest.fn(async () => ({ opened: true }));
  Object.assign(svc, {
    db,
    audit,
    tenant: { companyId: () => companyId, requireBranchId: () => branchId, userId: () => userId, requireUserId: () => userId },
    cls: { get: (key: string) => (key === 'permissions' ? permissions : undefined) },
    businessDay: { describe: jest.fn().mockResolvedValue(today), today: jest.fn().mockResolvedValue(DAY) },
    openView: jest.fn(async (day: string) => ({ view: day })),
    tellOwner: jest.fn(),
    open,
    // The drawer at the moment: a day closed with its drawer counted at 3 400; the day had moved 2 450.
    drawerNow: jest.fn(async () => ({
      tracked: 3450,
      dayNet: 2450,
      previous: opts.previous === undefined ? 3400 : opts.previous,
      known: opts.previous !== null,
      methods: [
        { key: 'cash', channel: 'cash', accountId: null, label: '', scope: 'branch', position: opts.previous === undefined ? 3400 : opts.previous },
        { key: 'account:a1', channel: 'account', accountId: 'a1', label: 'Bankily', scope: 'company', position: 3600 },
      ],
    })),
  });
  return { svc, db, audit, open };
}

const decided = (db: ReturnType<typeof build>['db']) => db.openingDecision.create.mock.calls.map((c) => c[0].data);

describe('the reopen carries the money the shop reopens with (docs/63)', () => {
  it('the Owner keeps: the day reopened and the decision recorded in one transaction — the count kept, not the expected', async () => {
    const { svc, db } = build({ owner: true });
    await svc.reopen({ openingMoney: { clientUuid: KEY, decision: 'keep' } });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.dailyClosing.updateMany).toHaveBeenCalledTimes(1);
    expect(db.closingEvent.create.mock.calls[0][0].data).toMatchObject({ kind: 'reopened', payload: { opening: { decision: 'keep', cash: 3400 } } });
    expect(decided(db)[0]).toMatchObject({
      kind: 'opening',
      decision: 'keep',
      businessDate: dateValue(DAY),
      cashAmount: 3400,
      cashTracked: 3450,
      cashDayNet: 2450,
      total: 7000,
    });
  });

  it('the Owner sets what is in the drawer now; the accounts carry forward', async () => {
    const { svc, db } = build({ owner: true });
    await svc.reopen({ openingMoney: { clientUuid: KEY, decision: 'set', cashAmount: 400 } });
    const [d] = decided(db);
    expect(d).toMatchObject({ decision: 'set', cashAmount: 400, total: 4000 });
    expect(d.methods[1]).toMatchObject({ key: 'account:a1', amount: 3600, set: false });
  });

  it('the Owner must decide: refused before the day changes', async () => {
    const { svc, db } = build({ owner: true });
    const refusal = await svc.reopen({}).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(BadRequestException);
    expect((refusal as BadRequestException).getResponse()).toMatchObject({ code: 'opening_amounts_required' });
    expect(db.dailyClosing.updateMany).not.toHaveBeenCalled();
    expect(db.closingEvent.create).not.toHaveBeenCalled();
  });

  it('the Owner keeping a drawer tracked below zero is refused on the reopen — opening_cash_negative — and nothing is written (2026-10-08)', async () => {
    const { svc, db } = build({ owner: true, previous: -1231250 });
    const refusal = await svc.reopen({ openingMoney: { clientUuid: KEY, decision: 'keep' } }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(BadRequestException);
    expect((refusal as BadRequestException).getResponse()).toMatchObject({ code: 'opening_cash_negative', trackedCash: -1231250 });
    expect(db.openingDecision.create).not.toHaveBeenCalled();
  });

  it('a named delegate reopens with the carried amounts, awaiting the Owner — and may not set one', async () => {
    const carried = build();
    await carried.svc.reopen({});
    expect(decided(carried.db)[0]).toMatchObject({ decision: 'carried', cashAmount: 3400 });
    const setting = build();
    const refusal = await setting.svc.reopen({ openingMoney: { decision: 'set', cashAmount: 1 } }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ForbiddenException);
    expect(setting.db.dailyClosing.updateMany).not.toHaveBeenCalled();
  });

  it('a day changed meanwhile: refused by name — refresh_required — and the decision is not written either', async () => {
    const { svc, db } = build({ owner: true, won: 0 });
    const refusal = await svc.reopen({ openingMoney: { clientUuid: KEY, decision: 'keep' } }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ConflictException);
    expect((refusal as ConflictException).getResponse()).toEqual({ code: 'refresh_required', message: 'This day changed while you were reopening it' });
    expect(db.openingDecision.create).not.toHaveBeenCalled();
  });

  it('a retry under the same key answers with the day, writing nothing', async () => {
    const first = build({ owner: true });
    await first.svc.reopen({ openingMoney: { clientUuid: KEY, decision: 'set', cashAmount: 400 } });
    const hash = decided(first.db)[0].clientRequestHash;
    const retry = build({ owner: true, row: { ...locked, status: 'reopened' }, prior: { businessDate: dateValue(DAY), clientRequestHash: hash } });
    expect(await retry.svc.reopen({ openingMoney: { clientUuid: KEY, decision: 'set', cashAmount: 400 } })).toEqual({ view: DAY });
    expect(retry.db.dailyClosing.updateMany).not.toHaveBeenCalled();
    expect(retry.db.openingDecision.create).not.toHaveBeenCalled();
  });

  it('an older phone’s reopen of a current day nobody closed or opened is answered as the opening', async () => {
    const { svc, db, open } = build({ row: null, opened: false });
    await svc.reopen({});
    expect(open).toHaveBeenCalledWith({ mode: 'continue' });
    expect(db.dailyClosing.updateMany).not.toHaveBeenCalled();
  });

  it('an opened day that is not closed is still no reopen', async () => {
    const { svc, open } = build({ row: null, opened: true });
    const refusal = await svc.reopen({}).catch((e: unknown) => e);
    expect((refusal as ConflictException).getResponse()).toMatchObject({ code: 'reopen_not_closed' });
    expect(open).not.toHaveBeenCalled();
  });

  it('starting the next day early opens it too, with the money decided', async () => {
    const { svc, open } = build({ owner: true });
    await svc.reopen({ mode: 'start_new', openingMoney: { clientUuid: KEY, decision: 'keep' } });
    expect(open).toHaveBeenCalledWith({ mode: 'start_new', openingMoney: { clientUuid: KEY, decision: 'keep' } });
  });
});

describe('the Owner’s review of a carried opening (docs/63)', () => {
  const carried = { id: Buffer.alloc(16, 6), decision: 'carried' as const, review: null };

  it('keep: recorded as the Owner’s review of that opening, true from now', async () => {
    const { svc, db } = build({ owner: true, opening: carried });
    await svc.reviewOpening({ clientUuid: KEY, decision: 'keep' });
    expect(decided(db)[0]).toMatchObject({ kind: 'owner_review', decision: 'keep', reviewOfId: carried.id, closingEventId: null, cashAmount: 3400 });
  });

  it('set: the drawer as it is now — never backdated to the opening', async () => {
    const { svc, db } = build({ owner: true, opening: carried });
    await svc.reviewOpening({ clientUuid: KEY, decision: 'set', cashAmount: 3000 });
    expect(decided(db)[0]).toMatchObject({ kind: 'owner_review', decision: 'set', cashAmount: 3000, cashDayNet: 2450 });
  });

  it.each([
    ['no opening today, on a day that is not open', null, false],
    ['no opening today while the drawer is known', null, true],
    ['an opening the Owner decided with a known amount', { id: Buffer.alloc(16, 6), decision: 'keep' as const, cashAmount: 3400, review: null }, true],
    ['an opening already reviewed', { ...carried, cashAmount: 3400, review: { id: Buffer.alloc(16, 7) } }, true],
  ])('%s has nothing to review', async (_label, opening, opened) => {
    const { svc, db } = build({ owner: true, opening, opened, previous: opening === null && !opened ? null : 3400 });
    const refusal = await svc.reviewOpening({ clientUuid: KEY, decision: 'keep' }).catch((e: unknown) => e);
    expect((refusal as ConflictException).getResponse()).toMatchObject({ code: 'no_opening_to_review' });
    expect(db.openingDecision.create).not.toHaveBeenCalled();
  });

  describe('an open day whose drawer is unknown is the Owner’s to set (2026-10-06)', () => {
    const keptUnknown = { id: Buffer.alloc(16, 9), decision: 'keep' as const, cashAmount: null, review: null };

    it('the Owner’s own keep from before the rule left the drawer unknown: the review sets it, as a review of that opening', async () => {
      const { svc, db } = build({ owner: true, opening: keptUnknown, previous: null });
      await svc.reviewOpening({ clientUuid: KEY, decision: 'set', cashAmount: 0 });
      expect(decided(db)[0]).toMatchObject({ kind: 'owner_review', decision: 'set', reviewOfId: keptUnknown.id, cashAmount: 0, cashKnown: false });
    });

    it('keeping an unknown drawer is refused in the review too — opening_cash_unknown — and nothing is written', async () => {
      for (const opening of [keptUnknown, { ...carried, cashAmount: null }]) {
        const { svc, db } = build({ owner: true, opening, previous: null });
        const refusal = await svc.reviewOpening({ clientUuid: KEY, decision: 'keep' }).catch((e: unknown) => e);
        expect(refusal).toBeInstanceOf(BadRequestException);
        expect((refusal as BadRequestException).getResponse()).toMatchObject({ code: 'opening_cash_unknown' });
        expect(db.openingDecision.create).not.toHaveBeenCalled();
      }
    });

    it('keeping a drawer tracked below zero is refused in the review too — opening_cash_negative — and nothing is written (2026-10-08)', async () => {
      const { svc, db } = build({ owner: true, opening: { ...carried, cashAmount: null }, previous: -1231250 });
      const refusal = await svc.reviewOpening({ clientUuid: KEY, decision: 'keep' }).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(BadRequestException);
      expect((refusal as BadRequestException).getResponse()).toMatchObject({ code: 'opening_cash_negative', trackedCash: -1231250 });
      expect(db.openingDecision.create).not.toHaveBeenCalled();
    });

    it('a day opened without any decision (an older phone) and still unknown: the Owner sets it, and the review stands on its own', async () => {
      const { svc, db } = build({ owner: true, opening: null, opened: true, previous: null });
      await svc.reviewOpening({ clientUuid: KEY, decision: 'set', cashAmount: 1500 });
      expect(decided(db)[0]).toMatchObject({ kind: 'owner_review', decision: 'set', reviewOfId: null, closingEventId: null, cashAmount: 1500 });
    });

    it('a carried opening whose drawer was known keeps both choices', async () => {
      const { svc, db } = build({ owner: true, opening: { ...carried, cashAmount: 3400 } });
      await svc.reviewOpening({ clientUuid: KEY, decision: 'keep' });
      expect(decided(db)[0]).toMatchObject({ kind: 'owner_review', decision: 'keep', cashAmount: 3400 });
    });
  });

  it('is the Owner’s alone', async () => {
    const { svc } = build({ opening: carried });
    await expect(svc.reviewOpening({ clientUuid: KEY, decision: 'keep' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('takes the day’s lock in its transaction and moves the day’s money version, before the decision is written (D159)', async () => {
    const { svc, db } = build({ owner: true, opening: carried });
    await svc.reviewOpening({ clientUuid: KEY, decision: 'set', cashAmount: 3000 });
    const lock = db.$queryRaw.mock.calls[0][0];
    expect(lock.sql).toMatch(/SELECT status FROM daily_closings\s+WHERE company_id = \? AND branch_id = \? AND closing_date = \?\s+FOR UPDATE/);
    expect(lock.values).toEqual([companyId, branchId, DAY]);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    expect(db.$executeRaw.mock.calls[0][0].sql).toMatch(/UPDATE daily_closings SET money_version = money_version \+ 1/);
    expect(db.$executeRaw.mock.calls[0][0].values).toEqual([companyId, branchId, DAY]);
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(db.openingDecision.create.mock.invocationCallOrder[0]);
  });

  it('on a day already closed is refused — day_already_closed — and nothing is written or moved (D159)', async () => {
    const { svc, db } = build({ owner: true, opening: carried, dayStatus: 'locked' });
    const refusal = await svc.reviewOpening({ clientUuid: KEY, decision: 'keep' }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ConflictException);
    expect((refusal as ConflictException).getResponse()).toEqual({
      code: 'day_already_closed',
      message: `${DAY} is already closed for this branch. Review the opening once the day is reopened.`,
    });
    expect(db.openingDecision.create).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it('a second review that lost the race stands down: the first one stands', async () => {
    const { svc } = build({ owner: true, opening: carried, race: true });
    const refusal = await svc.reviewOpening({ clientUuid: KEY, decision: 'set', cashAmount: 10 }).catch((e: unknown) => e);
    expect((refusal as ConflictException).getResponse()).toMatchObject({ code: 'no_opening_to_review' });
  });
});
