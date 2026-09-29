import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClosingService } from './closing.service';
import { dateValue } from '../common/business-day/business-day.service';

/**
 * "Open the boutique" before 06:00 (docs/56): the business date is still the
 * previous calendar day, so the opening says which day was chosen — `continue`
 * opens that day, `start_new` (the Owner alone) starts the next date and opens
 * it. Nothing already recorded moves; a plain opening after 06:00 claims no
 * choice. The service is driven with a mocked database, so what is asserted
 * is exactly what would be written.
 */

const branchId = Buffer.from('01a091c77f1e7f5db52a64ee21b95896', 'hex');
const companyId = Buffer.from('01a091c77eac76ada3384092cc1e12e4', 'hex');
const userId = Buffer.from('01a091c77f2b764da36774d37794e74f', 'hex');

/** 03:41 on the 26th: the calendar has moved on, the business date has not. */
const before6 = { businessDate: '2026-09-25', localDate: '2026-09-26', timezone: 'UTC', canStartEarly: true, startedEarly: false };
/** The same moment once the 26th was started early. */
const startedEarly = { ...before6, businessDate: '2026-09-26', canStartEarly: false, startedEarly: true };
/** 09:00 on the 26th: nothing to choose. */
const after6 = { businessDate: '2026-09-26', localDate: '2026-09-26', timezone: 'UTC', canStartEarly: false, startedEarly: false };

interface BuildOptions {
  mayStartEarly?: boolean;
  /** Holds `money.anchor.record`: decides the money a shop opens with (docs/63). */
  owner?: boolean;
  events?: { kind: string }[];
  row?: { id: Buffer; status: string } | null;
  /** The drawer as Money shows it now; null when unknown. */
  previous?: number | null;
  /** An earlier decision under the request's key. */
  prior?: { businessDate: Date; clientRequestHash: string } | null;
  /** The event's insert loses a race (P2002). */
  race?: boolean;
}

function build(descriptions: object[], opts: BuildOptions = {}) {
  const describe = jest.fn();
  for (const d of descriptions) describe.mockResolvedValueOnce(d);
  const previous = opts.previous === undefined ? 3400 : opts.previous;
  const db = {
    dailyClosing: { findUnique: jest.fn().mockResolvedValue(opts.row ?? null) },
    closingEvent: {
      findMany: jest.fn().mockResolvedValue(opts.events ?? []),
      create: jest.fn(async (_args: { data: Record<string, any> }) => {
        if (opts.race) throw new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' });
        return {};
      }),
    },
    openingDecision: { findFirst: jest.fn().mockResolvedValue(opts.prior ?? null), create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(db)),
  };
  const record = jest.fn().mockResolvedValue(undefined);
  // Inside the transaction, in the same order: one list of what was audited.
  const audit = { record, recordTx: jest.fn(async (_tx: unknown, entry: unknown) => record(entry)) };
  const permissions = new Set([
    'closing.count',
    ...(opts.mayStartEarly ? ['closing.start_early'] : []),
    ...(opts.owner ? ['money.anchor.record'] : []),
  ]);
  const svc = Object.create(ClosingService.prototype) as ClosingService & Record<string, unknown>;
  Object.assign(svc, {
    db,
    audit,
    tenant: { companyId: () => companyId, requireBranchId: () => branchId, userId: () => userId, requireUserId: () => userId },
    cls: { get: (key: string) => (key === 'permissions' ? permissions : undefined) },
    businessDay: { describe },
    openView: jest.fn(async (day: string) => ({ view: day })),
    // The drawer as the opening decides it; its own figures are tested with the closing's.
    drawerNow: jest.fn(async () => ({
      tracked: 3400,
      dayNet: 0,
      previous,
      known: previous !== null,
      methods: [
        { key: 'cash', channel: 'cash', accountId: null, label: '', scope: 'branch', position: previous },
        { key: 'account:a1', channel: 'account', accountId: 'a1', label: 'Bankily', scope: 'company', position: 2000 },
        { key: 'account:a2', channel: 'account', accountId: 'a2', label: 'Masrvi', scope: 'company', position: 1600 },
      ],
    })),
  });
  return { svc, db, audit, describe };
}

const decided = (db: ReturnType<typeof build>['db']) => db.openingDecision.create.mock.calls.map((c) => c[0].data);

const created = (db: ReturnType<typeof build>['db']) => db.closingEvent.create.mock.calls.map((c) => c[0].data);

describe('Open the boutique before 06:00 (docs/56)', () => {
  it('a start_new from somebody without closing.start_early is refused before anything is written', async () => {
    const { svc, db, audit } = build([before6]);
    await expect(svc.open({ mode: 'start_new' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.closingEvent.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('a start_new after 06:00 is refused by name: not_before_day_start', async () => {
    const { svc, db } = build([after6], { mayStartEarly: true });
    const refusal = await svc.open({ mode: 'start_new' }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ConflictException);
    expect((refusal as ConflictException).getResponse()).toMatchObject({ code: 'not_before_day_start' });
    expect(db.closingEvent.create).not.toHaveBeenCalled();
  });

  it('the Owner’s start_new at 03:41 starts the 26th and opens it: two events, two audit rows, the choice on record', async () => {
    const { svc, db, audit, describe } = build([before6], { mayStartEarly: true });
    const view = await svc.open({ mode: 'start_new' });
    const [early, opened] = created(db);
    expect(early).toMatchObject({ kind: 'day_started_early', businessDate: dateValue('2026-09-26'), actorId: userId, closingId: null });
    expect(early.payload).toMatchObject({ previousDate: '2026-09-25' });
    expect(opened).toMatchObject({ kind: 'opened', businessDate: dateValue('2026-09-26'), actorId: userId });
    expect(opened.payload).toMatchObject({ nth: 1, choice: 'start_new', calendarDate: '2026-09-26', localTime: expect.stringMatching(/^\d\d:\d\d$/) });
    expect(audit.record.mock.calls.map((c) => c[0].reason)).toEqual(['day_started_early', 'opening_money', 'opened']);
    expect(audit.record.mock.calls.find((c) => c[0].reason === 'opened')![0].after).toMatchObject({ businessDate: '2026-09-26', choice: 'start_new' });
    // The new day is computed, not read back from a start already written: it is written with the opening.
    expect(describe).toHaveBeenCalledTimes(1);
    expect(view).toEqual({ view: '2026-09-26' });
  });

  describe('the early start is part of the opening (the user’s brief of 2026-09-29)', () => {
    const KEY29 = '019fb000-0000-7000-8000-000000000029';
    /** The transaction's own client: every write it receives is undone if the transaction fails. */
    function inTransaction(built: ReturnType<typeof build>, failDecision = false) {
      const tx = {
        closingEvent: { create: jest.fn(async (_args: { data: Record<string, any> }) => ({})) },
        openingDecision: {
          create: jest.fn(async (_args: unknown) => {
            if (failDecision) throw new Error('connection lost');
            return {};
          }),
        },
      };
      built.db.$transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));
      return tx;
    }

    it('the next day started early, its opening and its money are written in one transaction — nothing outside it', async () => {
      const built = build([before6], { mayStartEarly: true, owner: true });
      const tx = inTransaction(built);
      await built.svc.open({ mode: 'start_new', openingMoney: { clientUuid: KEY29, decision: 'set', cashAmount: 250 } });
      expect(built.db.closingEvent.create).not.toHaveBeenCalled();
      expect(tx.closingEvent.create.mock.calls.map((c) => c[0].data.kind)).toEqual(['day_started_early', 'opened']);
      expect(tx.closingEvent.create.mock.calls.map((c) => c[0].data.businessDate)).toEqual([dateValue('2026-09-26'), dateValue('2026-09-26')]);
      // One instant for both: the day is started and opened by the same act.
      const [early, opened] = tx.closingEvent.create.mock.calls.map((c) => c[0].data);
      expect(early.at).toBe(opened.at);
      expect(tx.openingDecision.create).toHaveBeenCalledTimes(1);
      expect(built.audit.recordTx.mock.calls.map((c) => (c[1] as { reason: string }).reason)).toEqual(['day_started_early', 'opening_money', 'opened']);
    });

    it('a failed save before 06:00 moves nothing: the day is not started early, the store stays closed', async () => {
      const built = build([before6], { mayStartEarly: true, owner: true });
      inTransaction(built, true);
      await expect(built.svc.open({ mode: 'start_new', openingMoney: { clientUuid: KEY29, decision: 'set', cashAmount: 250 } })).rejects.toThrow('connection lost');
      // Nothing was written outside the transaction that failed — so its rollback leaves the 25th the business day.
      expect(built.db.closingEvent.create).not.toHaveBeenCalled();
      expect(built.audit.record.mock.calls.length).toBe(built.audit.recordTx.mock.calls.length);
    });

    it('a refused amounts step before 06:00 writes nothing at all', async () => {
      const built = build([before6], { mayStartEarly: true, owner: true });
      const tx = inTransaction(built);
      const refusal = await built.svc.open({ mode: 'start_new', openingMoney: { clientUuid: KEY29, decision: 'set', cashAmount: -1 } }).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(BadRequestException);
      expect(built.db.closingEvent.create).not.toHaveBeenCalled();
      expect(tx.closingEvent.create).not.toHaveBeenCalled();
      expect(built.db.$transaction).not.toHaveBeenCalled();
    });
  });

  it('continue at 03:41 opens the 25th — the previous business day — and records that it was chosen', async () => {
    const { svc, db, audit } = build([before6], { mayStartEarly: true });
    const view = await svc.open({ mode: 'continue' });
    const events = created(db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'opened', businessDate: dateValue('2026-09-25') });
    expect(events[0].payload).toMatchObject({ nth: 1, choice: 'continue', calendarDate: '2026-09-26' });
    // The opening and its money, audited in the one transaction.
    expect(audit.record.mock.calls.map((c) => c[0].reason)).toEqual(['opening_money', 'opened']);
    expect(view).toEqual({ view: '2026-09-25' });
  });

  it('an opening with no mode before 06:00 — a staff member’s — is the previous day, and says so', async () => {
    const { svc, db } = build([before6]);
    await svc.open({});
    expect(created(db)[0]).toMatchObject({ kind: 'opened', businessDate: dateValue('2026-09-25') });
    expect(created(db)[0].payload).toMatchObject({ choice: 'continue', calendarDate: '2026-09-26' });
  });

  it('after 06:00 an opening claims no choice at all', async () => {
    const { svc, db } = build([after6]);
    await svc.open({});
    const [opened] = created(db);
    expect(opened).toMatchObject({ kind: 'opened', businessDate: dateValue('2026-09-26') });
    expect(opened.payload).not.toHaveProperty('choice');
    expect(opened.payload).not.toHaveProperty('calendarDate');
  });

  it('a second start_new once the day was started early starts nothing twice and opens the new day', async () => {
    const { svc, db, describe } = build([startedEarly], { mayStartEarly: true });
    await svc.open({ mode: 'start_new' });
    const events = created(db);
    expect(events.map((e) => e.kind)).toEqual(['opened']);
    expect(events[0]).toMatchObject({ businessDate: dateValue('2026-09-26') });
    expect(describe).toHaveBeenCalledTimes(1);
  });

  it('a repeat tap on an open day is refused as open_already_open and writes nothing', async () => {
    const { svc, db } = build([before6], { mayStartEarly: true, events: [{ kind: 'opened' }] });
    const refusal = await svc.open({ mode: 'continue' }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ConflictException);
    expect((refusal as ConflictException).getResponse()).toMatchObject({ code: 'open_already_open' });
    expect(db.closingEvent.create).not.toHaveBeenCalled();
  });

  it('a closed previous day is not opened but reopened — refused by name, with the choice left to the reopen', async () => {
    const { svc, db } = build([before6], { mayStartEarly: true, row: { id: Buffer.alloc(16), status: 'locked' } });
    const refusal = await svc.open({ mode: 'continue' }).catch((e: unknown) => e);
    expect((refusal as ConflictException).getResponse()).toMatchObject({ code: 'open_day_closed' });
    expect(db.closingEvent.create).not.toHaveBeenCalled();
  });
});

describe('the money a shop opens with (docs/63)', () => {
  const KEY = '0190a8c0-0000-7000-8000-0000000000aa';

  it('the Owner must decide: no decision is refused before anything is written', async () => {
    const { svc, db } = build([after6], { owner: true });
    const refusal = await svc.open({}).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(BadRequestException);
    expect((refusal as BadRequestException).getResponse()).toMatchObject({ code: 'opening_amounts_required' });
    expect(db.closingEvent.create).not.toHaveBeenCalled();
    expect(db.openingDecision.create).not.toHaveBeenCalled();
  });

  it('keep: the opening and its decision in one transaction — the drawer as shown, the accounts carried', async () => {
    const { svc, db } = build([after6], { owner: true });
    await svc.open({ openingMoney: { clientUuid: KEY, decision: 'keep' } });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    const [d] = decided(db);
    expect(d).toMatchObject({ kind: 'opening', decision: 'keep', cashAmount: 3400, cashTracked: 3400, cashDayNet: 0, cashKnown: true, total: 7000 });
    expect(d.methods).toEqual([
      expect.objectContaining({ key: 'cash', previous: 3400, amount: 3400, set: false }),
      expect.objectContaining({ key: 'account:a1', scope: 'company', previous: 2000, amount: 2000, set: false }),
      expect.objectContaining({ key: 'account:a2', scope: 'company', previous: 1600, amount: 1600, set: false }),
    ]);
    expect(created(db)[0].payload).toMatchObject({ opening: { decision: 'keep', cash: 3400 } });
  });

  it('set: the Owner’s amount for the cash only, true from now; 0 is a value when chosen', async () => {
    const { svc, db } = build([after6], { owner: true });
    await svc.open({ openingMoney: { clientUuid: KEY, decision: 'set', cashAmount: 0 } });
    const [d] = decided(db);
    expect(d).toMatchObject({ decision: 'set', cashAmount: 0, cashTracked: 3400, total: 3600 });
    expect(d.methods[0]).toMatchObject({ key: 'cash', previous: 3400, amount: 0, set: true });
    expect(d.methods.slice(1).every((m: { set: boolean }) => !m.set)).toBe(true);
  });

  it('keep leaves an unknown drawer unknown: no amount, no total', async () => {
    const { svc, db } = build([after6], { owner: true, previous: null });
    await svc.open({ openingMoney: { clientUuid: KEY, decision: 'keep' } });
    expect(decided(db)[0]).toMatchObject({ decision: 'keep', cashAmount: null, cashKnown: false, total: null });
  });

  it.each([[-1], [1.234], [Number.NaN]])('an invalid amount (%s) is refused by name, nothing written', async (amount) => {
    const { svc, db } = build([after6], { owner: true });
    const refusal = await svc.open({ openingMoney: { clientUuid: KEY, decision: 'set', cashAmount: amount } }).catch((e: unknown) => e);
    expect((refusal as BadRequestException).getResponse()).toMatchObject({ code: 'amount_invalid' });
    expect(db.closingEvent.create).not.toHaveBeenCalled();
  });

  it('keep takes no amount', async () => {
    const { svc } = build([after6], { owner: true });
    const refusal = await svc.open({ openingMoney: { decision: 'keep', cashAmount: 100 } }).catch((e: unknown) => e);
    expect((refusal as BadRequestException).getResponse()).toMatchObject({ code: 'amount_not_expected' });
  });

  it('somebody else opens with the tracked amounts — carried, awaiting the Owner — and may not set any', async () => {
    const carried = build([after6]);
    await carried.svc.open({});
    expect(decided(carried.db)[0]).toMatchObject({ kind: 'opening', decision: 'carried', cashAmount: 3400 });
    const setting = build([after6]);
    const refusal = await setting.svc.open({ openingMoney: { decision: 'set', cashAmount: 100 } }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ForbiddenException);
    expect((refusal as ForbiddenException).getResponse()).toMatchObject({ code: 'opening_amounts_owner_only' });
    expect(setting.db.closingEvent.create).not.toHaveBeenCalled();
  });

  it('a retry under the same key answers with the day it opened, writing nothing — even once the day is open', async () => {
    const first = build([after6], { owner: true });
    await first.svc.open({ openingMoney: { clientUuid: KEY, decision: 'set', cashAmount: 2500 } });
    const hash = decided(first.db)[0].clientRequestHash;
    const retry = build([after6], { owner: true, events: [{ kind: 'opened' }], prior: { businessDate: dateValue('2026-09-26'), clientRequestHash: hash } });
    const view = await retry.svc.open({ openingMoney: { clientUuid: KEY, decision: 'set', cashAmount: 2500 } });
    expect(view).toEqual({ view: '2026-09-26' });
    expect(retry.db.closingEvent.create).not.toHaveBeenCalled();
    expect(retry.db.openingDecision.create).not.toHaveBeenCalled();
  });

  it('the same key with another amount is refused as a conflict', async () => {
    const { svc, db } = build([after6], { owner: true, prior: { businessDate: dateValue('2026-09-26'), clientRequestHash: 'another' } });
    const refusal = await svc.open({ openingMoney: { clientUuid: KEY, decision: 'set', cashAmount: 2600 } }).catch((e: unknown) => e);
    expect((refusal as ConflictException).getResponse()).toMatchObject({ code: 'idempotency_conflict' });
    expect(db.closingEvent.create).not.toHaveBeenCalled();
  });

  it('losing the race to somebody else’s opening never drops the Owner’s amount silently', async () => {
    const { svc } = build([after6], { owner: true, race: true });
    const refusal = await svc.open({ openingMoney: { clientUuid: KEY, decision: 'set', cashAmount: 2500 } }).catch((e: unknown) => e);
    expect((refusal as ConflictException).getResponse()).toMatchObject({ code: 'open_already_open' });
  });

  it('before 06:00 the day is chosen first, and the money goes with the day chosen', async () => {
    const { svc, db } = build([before6, startedEarly], { owner: true, mayStartEarly: true });
    await svc.open({ mode: 'start_new', openingMoney: { clientUuid: KEY, decision: 'set', cashAmount: 1000 } });
    expect(created(db).map((e) => e.kind)).toEqual(['day_started_early', 'opened']);
    expect(decided(db)[0]).toMatchObject({ businessDate: dateValue('2026-09-26'), decision: 'set', cashAmount: 1000 });
  });
});
