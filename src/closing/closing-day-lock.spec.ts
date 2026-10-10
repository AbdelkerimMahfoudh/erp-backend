import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { buildChannels } from './channels';
import { closeRequestHash } from './closing-lifecycle';
import { assembleReport, reportVersion, type ChannelCountState, type ReportFloatInput, type ReportInputs } from './closing-report';
import { ClosingService, type CounterOperation, type MoneyOperation } from './closing.service';

/**
 * The closing refuses a stale confirmation (D159, docs/73 §11.2), driven through the real service over a mocked
 * database: what the day's lock reads, what it refuses and what it moves; what the close compares under its own lock
 * and what it answers with; how its idempotency key is bound to what it asked; and how a count waits behind the same
 * lock. The figures themselves are the report's tests (`money-moved.spec.ts`, `closing-report.spec.ts`).
 */

const COMPANY = Buffer.alloc(16, 1);
const BRANCH = Buffer.alloc(16, 2);
const USER = Buffer.alloc(16, 3);
const CLOSING = Buffer.alloc(16, 9);
const DAY = '2026-10-10';
const YESTERDAY = '2026-10-09';
const KEY = '019fb000-0000-7000-8000-0000000000c1';

type Row = Record<string, any>;
type Raw = { sql: string; values: unknown[] };

const refusal = async (p: Promise<unknown>) => {
  const e = await p.catch((err: unknown) => err);
  return { error: e, body: (e as { getResponse?: () => unknown }).getResponse?.() as Record<string, any> | undefined };
};

function service(over: Row = {}) {
  const svc = Object.create(ClosingService.prototype) as ClosingService & Record<string, any>;
  Object.assign(svc, {
    tenant: { companyId: () => COMPANY, requireBranchId: () => BRANCH, userId: () => USER, requireUserId: () => USER },
    businessDay: { today: jest.fn(async () => DAY) },
    ...over,
  });
  return svc;
}

/** A transaction's client: the day's row as its lock reads it, and every bump of a money version. */
function dayTx(status: string | null) {
  const bumps: Raw[] = [];
  const tx = {
    $queryRaw: jest.fn(async (_q: Prisma.Sql) => (status === null ? [] : [{ status }])),
    $executeRaw: jest.fn(async (q: Prisma.Sql) => {
      bumps.push({ sql: q.sql, values: q.values });
      return 1;
    }),
  };
  return { tx, bumps };
}

const BUMP_DAY = /^\s*UPDATE daily_closings SET money_version = money_version \+ 1\s+WHERE company_id = \? AND branch_id = \? AND closing_date = \?\s*$/;
const BUMP_LATER = /^\s*UPDATE daily_closings SET money_version = money_version \+ 1\s+WHERE company_id = \? AND branch_id = \? AND closing_date > \? AND status <> 'locked'\s*$/;

describe('every money write moves its day’s money version under the lock the close takes (D159)', () => {
  it.each<CounterOperation>(['sale', 'receipt', 'payment', 'agent_exchange', 'agent_reversal', 'agent_rebalancing'])(
    'through the counter’s check — %s — once the day is found open, on the row it locked',
    async (operation) => {
      const { tx, bumps } = dayTx('counting');
      tx.$queryRaw.mockImplementation((async (q: Prisma.Sql) => (/FROM closing_events/.test(q.sql) ? [{ one: 1 }] : [{ status: 'counting' }])) as never);
      await service().assertCounterOpenTx(tx as never, { branchId: BRANCH, businessDate: DAY, operation });
      expect(bumps).toHaveLength(1);
      expect(bumps[0].sql).toMatch(BUMP_DAY);
      expect(bumps[0].values).toEqual([COMPANY, BRANCH, DAY]);
    },
  );

  it('the counter’s refusal moves nothing', async () => {
    const { tx, bumps } = dayTx('locked');
    const { body } = await refusal(service().assertCounterOpenTx(tx as never, { branchId: BRANCH, businessDate: DAY, operation: 'sale' }));
    expect(body).toMatchObject({ code: 'store_closed', closedReason: 'closed' });
    expect(bumps).toEqual([]);
  });

  describe('lockDayForMoneyTx — the writers that do not pass the counter', () => {
    const operations: MoneyOperation[] = ['expense_confirmation', 'refund_confirmation', 'return_approval', 'backdated_payment', 'opening_review', 'float_set'];

    it.each(operations)('%s on an open day: the row locked by the reading statement, its version moved — and no door asked for', async (operation) => {
      for (const status of [null, 'counting', 'counted', 'reopened']) {
        const { tx, bumps } = dayTx(status);
        await service().lockDayForMoneyTx(tx as never, { branchId: BRANCH, businessDate: DAY, operation });
        expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
        const lock = tx.$queryRaw.mock.calls[0][0];
        expect(lock.sql).toMatch(/SELECT status FROM daily_closings\s+WHERE company_id = \? AND branch_id = \? AND closing_date = \?\s+FOR UPDATE/);
        expect(lock.values).toEqual([COMPANY, BRANCH, DAY]);
        // Today's money moves today alone; a day with no row yet has nothing to bump, and the statement touches nothing.
        expect(bumps).toHaveLength(1);
        expect(bumps[0].sql).toMatch(BUMP_DAY);
        expect(bumps[0].values).toEqual([COMPANY, BRANCH, DAY]);
      }
    });

    it('money dated on an earlier day moves that day and every later day still open, whose opening it moved', async () => {
      for (const operation of ['backdated_payment', 'expense_confirmation'] as const) {
        const { tx, bumps } = dayTx('counting');
        await service().lockDayForMoneyTx(tx as never, { branchId: BRANCH, businessDate: YESTERDAY, operation });
        expect(bumps.map((b) => b.values)).toEqual([
          [COMPANY, BRANCH, YESTERDAY],
          [COMPANY, BRANCH, YESTERDAY],
        ]);
        expect(bumps[0].sql).toMatch(BUMP_DAY);
        expect(bumps[1].sql).toMatch(BUMP_LATER);
      }
    });

    it.each([
      ['expense_confirmation', `${DAY} is already closed for this branch. Confirm this expense once the next day opens.`],
      ['backdated_payment', `${DAY} is already closed for this branch. Confirm this expense once the next day opens.`],
      ['refund_confirmation', `${DAY} is already closed for this branch. Confirm this refund tomorrow, or ask the owner to review the closing.`],
      ['return_approval', `${DAY} is already closed for this branch. Approve this return tomorrow, or ask the owner to review the closing.`],
      ['opening_review', `${DAY} is already closed for this branch. Review the opening once the day is reopened.`],
    ] as const)('%s on a locked day is refused with the code and the words it has always had, and nothing moves', async (operation, message) => {
      const { tx, bumps } = dayTx('locked');
      const { error, body } = await refusal(service().lockDayForMoneyTx(tx as never, { branchId: BRANCH, businessDate: DAY, operation }));
      expect(error).toBeInstanceOf(ConflictException);
      expect(body).toEqual({ code: 'day_already_closed', message });
      expect(bumps).toEqual([]);
    });

    it('the Owner’s float set is never refused by a closed day, and moves nothing on it: its floats were counted before it locked', async () => {
      const { tx, bumps } = dayTx('locked');
      await expect(service().lockDayForMoneyTx(tx as never, { branchId: BRANCH, businessDate: DAY, operation: 'float_set' })).resolves.toBeUndefined();
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(bumps).toEqual([]);
    });
  });
});

// ── The close ────────────────────────────────────────────────────────────────

const CASH_IN = 5_000;

/** The day's report: 5 000 taken in cash, the drawer counted against `drawerAtCount`, a float when given. */
function built(opts: { drawerAtCount?: number; float?: ReportFloatInput; moneyVersion?: number; extraCash?: number } = {}) {
  const channels = buildChannels([{ channel: 'cash', accountId: null, component: 'salesIn', amount: CASH_IN + (opts.extraCash ?? 0) }], [], 0);
  const counts = new Map<string, ChannelCountState>(
    opts.drawerAtCount === undefined ? [] : [['cash:NONE', { verification: 'counted', counted: opts.drawerAtCount, countedAt: new Date(`${DAY}T18:00:00Z`), skipReason: null, expectedAtCount: opts.drawerAtCount }]],
  );
  const inputs: ReportInputs = {
    date: DAY,
    today: DAY,
    timezone: 'UTC',
    window: { startsAt: `${DAY}T06:00:00.000Z`, endsAt: '2026-10-11T06:00:00.000Z' },
    standing: 'counting',
    sales: { count: 1, value: CASH_IN, itemsSold: 1, cost: 4_000, missingCostLines: 0 },
    returns: { count: 0, grossRefund: 0, adjustments: 0, netRefundDue: 0, costCredited: 0, missingCostLines: 0 },
    cancellations: { count: 0, value: 0, items: 0, cost: 0, missingCostLines: 0, ofTheseSales: 0 },
    collected: { atCheckout: CASH_IN, laterSameDay: 0, corrections: 0 },
    channels,
    splits: new Map(),
    expenses: [],
    expenseReversals: [],
    counts,
    opening: { amount: 0, anchorDate: null, anchorVerified: false, carriedDays: 0 },
    floats: opts.float ? [opts.float] : [],
    pending: null,
    openDiscrepancies: 0,
    previousDay: null,
    closeKind: 'first',
  };
  const report = assembleReport(inputs);
  const moneyVersion = opts.moneyVersion ?? 0;
  const providers = opts.float ? [{ providerId: opts.float.providerId, label: opts.float.label, isActive: true }] : [];
  const floatCounts = new Map(opts.float ? [[opts.float.providerId, { providerId: opts.float.providerId, counted: opts.float.counted, isSkipped: opts.float.isSkipped }]] : []);
  return {
    report,
    version: reportVersion(report, moneyVersion),
    moneyVersion,
    invariantFailures: [],
    channels,
    closing: null,
    opening: report.expected.cash.opening,
    cashAdjustment: 0,
    floats: { providers, counts: floatCounts, rows: opts.float ? [opts.float] : [], counted: [] },
  };
}

interface Closer {
  /** What `buildReport` returns, call after call: the report read before the close, then the one read after a refusal. */
  reports: ReturnType<typeof built>[];
  /** The day's money version as the close's lock reads it. */
  lockedVersion?: number;
  /** The movements' fingerprint inside the transaction, when something else landed. */
  fingerprintInside?: string;
  /** The CAS on the day's row: 0 when somebody else changed it first. */
  won?: number;
  /** The day's row as the replay reads it, and the latest close event. */
  row?: Row;
  replayRow?: Row | null;
  event?: Row | null;
}

function closer(c: Closer) {
  const events: Row[] = [];
  const tx = {
    $queryRaw: jest.fn(async (q: Prisma.Sql) =>
      /money_version/.test(q.sql) ? [{ money_version: c.lockedVersion ?? c.reports[0].moneyVersion }] : [c.fingerprintInside ? { a: c.fingerprintInside } : {}],
    ),
    dailyClosing: { updateMany: jest.fn(async () => ({ count: c.won ?? 1 })) },
    closingChannelCount: { create: jest.fn(async () => ({})), update: jest.fn(async () => ({})) },
    closingDiscrepancy: { findMany: jest.fn(async () => []), create: jest.fn(), update: jest.fn() },
    dailyDigest: { findUnique: jest.fn(async () => null), create: jest.fn(async () => ({})), update: jest.fn() },
    digestLine: { deleteMany: jest.fn(), createMany: jest.fn() },
    closingEvent: { create: jest.fn(async (args: { data: Row }) => void events.push(args.data)) },
  };
  const row = c.row ?? { id: CLOSING, status: 'counting', version: 0, channelCounts: [], reopenedAt: null, reopenCount: 0, firstClosedAt: null };
  const db = {
    dailyClosing: {
      findUnique: jest.fn(async (args: { select?: Row; include?: Row }) => (args.select ? (c.replayRow === undefined ? row : c.replayRow) : row)),
    },
    closingEvent: { findFirst: jest.fn(async () => c.event ?? null) },
    dailyRollup: { findUnique: jest.fn(async () => null) },
    payment: { aggregate: jest.fn(async () => ({ _sum: { amount: new Prisma.Decimal(CASH_IN) } })) },
    // The movements' fingerprint before the report is read.
    $queryRaw: jest.fn(async () => [{}]),
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>): Promise<unknown> => fn(tx)),
  };
  const buildReport = jest.fn();
  for (const r of c.reports) buildReport.mockResolvedValueOnce(r);
  buildReport.mockResolvedValue(c.reports[c.reports.length - 1]);
  const audit = { recordTx: jest.fn(async () => undefined) };
  const svc = service({
    db,
    audit,
    businessDay: { describe: jest.fn(async () => ({ businessDate: DAY, localDate: DAY, timezone: 'UTC', canStartEarly: false, startedEarly: false })), today: jest.fn(async () => DAY) },
    cls: { get: () => new Set(['closing.count', 'closing.perform', 'report.view']) },
    rollups: { recomputeDaily: jest.fn(async () => undefined) },
    notifications: { emit: jest.fn(async () => undefined) },
    buildReport,
    stockPaidOn: jest.fn(async () => ({ total: 0, cash: 0 })),
    agentCashOn: jest.fn(async () => ({ in: 0, out: 0 })),
    buildDigestLines: jest.fn(async () => []),
  });
  return { svc, db, tx, events, buildReport };
}

describe('POST closings — the close compares the day’s money version under its own lock (D159)', () => {
  it('money moved between the report and the lock: 409 report_changed with the report as it stands now, rebuilt after the rollback', async () => {
    const before = built({ moneyVersion: 3 });
    const now = built({ moneyVersion: 4, extraCash: 1_500 });
    const h = closer({ reports: [before, now], lockedVersion: 4 });
    const { error, body } = await refusal(h.svc.close({ clientUuid: KEY, attestChecked: true, reportVersion: before.version }));
    expect(error).toBeInstanceOf(ConflictException);
    expect(body).toMatchObject({ code: 'report_changed', message: 'Something was recorded on this day while you were closing it. Review the new report before closing.' });
    // The fresh report, gated for the caller, carrying the version to confirm next — never the one that was refused.
    expect(body!.report).toMatchObject({ reportVersion: now.version, expected: { cash: { expected: CASH_IN + 1_500 } }, sections: { close: true } });
    expect(h.buildReport).toHaveBeenCalledTimes(2);
    expect(h.buildReport.mock.invocationCallOrder[1]).toBeGreaterThan(h.db.$transaction.mock.invocationCallOrder[0]);
    // Read BY the locking statement, then nothing written: no snapshot, no event.
    expect(h.tx.$queryRaw.mock.calls[0][0].sql).toMatch(/SELECT money_version FROM daily_closings WHERE id = \? FOR UPDATE/);
    expect(h.tx.dailyClosing.updateMany).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it('a movement the fingerprint sees is refused the same way, with the report too', async () => {
    const h = closer({ reports: [built({ moneyVersion: 2 }), built({ moneyVersion: 2, extraCash: 300 })], fingerprintInside: '1/300' });
    const { body } = await refusal(h.svc.close({ attestChecked: true }));
    expect(body).toMatchObject({ code: 'report_changed', report: { expected: { cash: { expected: CASH_IN + 300 } } } });
    expect(h.events).toEqual([]);
  });

  it('the same money version and the same movements: the close goes on to its own guard', async () => {
    const h = closer({ reports: [built({ moneyVersion: 5 })], lockedVersion: 5, won: 0 });
    const { body } = await refusal(h.svc.close({ attestChecked: true }));
    // Past the lock's comparison: the version guard on the row is what refused it.
    expect(body).toEqual({ code: 'refresh_required', message: 'This day was changed while you were closing it' });
    expect(h.tx.dailyClosing.updateMany).toHaveBeenCalledTimes(1);
  });

  it('a phone that confirmed an older version is refused before the transaction, with the report', async () => {
    const h = closer({ reports: [built({ moneyVersion: 4 })] });
    const { body } = await refusal(h.svc.close({ attestChecked: true, reportVersion: built({ moneyVersion: 3 }).version }));
    expect(body).toMatchObject({ code: 'report_changed', report: { reportVersion: built({ moneyVersion: 4 }).version } });
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });
});

describe('POST closings — money moved after a count (D159)', () => {
  it('a drawer counted before a cash sale: 409 money_moved_after_count naming it, with the report, before anything is locked', async () => {
    const stale = built({ drawerAtCount: CASH_IN, extraCash: 1_500 });
    const h = closer({ reports: [stale] });
    const { error, body } = await refusal(h.svc.close({ clientUuid: KEY, attestChecked: true, reportVersion: stale.version }));
    expect(error).toBeInstanceOf(ConflictException);
    expect(body).toMatchObject({
      code: 'money_moved_after_count',
      message: 'Money moved after counting began. Count again what changed before closing.',
      channels: [{ key: 'cash:NONE', label: stale.report.money.channels[0].label }],
      floats: [],
      report: { reportVersion: stale.version, expected: { cash: { movedSinceCount: true, expectedAtCount: CASH_IN } } },
    });
    expect(body!.report.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'money_moved_after_count' })]));
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });

  it('a float that moved after its count is named too; a recount — the figure now — lets the close go on', async () => {
    const float: ReportFloatInput = { providerId: 'p1', label: 'Bankily', expected: 30_700, counted: 30_200, explanation: null, isSkipped: false, skipReason: null, countedAt: `${DAY}T18:00:00.000Z`, countedByName: 'Aicha', expectedAtCount: 30_200 };
    const moved = closer({ reports: [built({ float })] });
    expect((await refusal(moved.svc.close({ attestChecked: true }))).body).toMatchObject({ code: 'money_moved_after_count', channels: [], floats: [{ providerId: 'p1', label: 'Bankily' }] });
    const recounted = closer({ reports: [built({ float: { ...float, counted: 30_700, expectedAtCount: 30_700 } })] });
    await recounted.svc.close({ attestChecked: true });
    expect(recounted.events).toHaveLength(1);
  });
});

describe('POST closings — an idempotent retry is bound to what it asked (D159)', () => {
  const asked = { clientUuid: KEY, attestChecked: true };

  it('the close stores the request’s hash beside its key; the same key and the same request on the closed day replays it — one closing, one event', async () => {
    const first = closer({ reports: [built({ moneyVersion: 1 })] });
    const result = await first.svc.close(asked);
    expect(result).toMatchObject({ kind: 'first', replayed: false });
    expect(first.events).toHaveLength(1);
    const payload = first.events[0].payload as Row;
    expect(payload).toMatchObject({ clientUuid: KEY, requestHash: closeRequestHash({ date: DAY, attestChecked: true }) });
    // The version it closed on carries the day's money version.
    expect(payload.reportVersion).toBe(reportVersion(payload.report, 1));

    const locked = { id: CLOSING, status: 'locked' };
    const retry = closer({ reports: [built({ moneyVersion: 1 })], replayRow: locked, event: { kind: 'closed', payload } });
    // A retry after the phone refreshed the report sends another version: still the same close.
    const again = await retry.svc.close({ ...asked, reportVersion: 'ffffffffffffffff', date: DAY });
    expect(again).toMatchObject({ kind: 'first', replayed: true, closingId: expect.any(String) });
    expect(retry.db.$transaction).not.toHaveBeenCalled();
    expect(retry.events).toEqual([]);
  });

  it('the same key asking something else on the closed day: 409 idempotency_conflict, nothing replayed', async () => {
    const payload = { clientUuid: KEY, requestHash: closeRequestHash({ date: DAY, attestChecked: true }), reportVersion: 'x'.repeat(16), report: built().report, verification: {} };
    const h = closer({ reports: [built()], replayRow: { id: CLOSING, status: 'locked' }, event: { kind: 'closed', payload } });
    const { error, body } = await refusal(h.svc.close({ clientUuid: KEY, acknowledgeUnverified: true, reason: 'Drawer key with the Owner' }));
    expect(error).toBeInstanceOf(ConflictException);
    expect(body).toEqual({ code: 'idempotency_conflict', message: 'That request id was already used for a different close.' });
    expect(h.buildReport).not.toHaveBeenCalled();
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });

  it('a close stored before the key was bound to its request replays on the key alone, as it always did', async () => {
    const payload = { clientUuid: KEY, reportVersion: 'x'.repeat(16), report: built().report, verification: { verified: [], unverified: [], attested: ['cash:NONE'], acknowledged: false, reason: null } };
    const h = closer({ reports: [built()], replayRow: { id: CLOSING, status: 'locked' }, event: { kind: 'closed', payload } });
    expect(await h.svc.close({ clientUuid: KEY, acknowledgeUnverified: true, reason: 'other words' })).toMatchObject({ replayed: true });
  });

  it('two taps at once: the second loses the row’s guard to the first, and is answered with the first’s close — never a second event', async () => {
    const payload = { clientUuid: KEY, requestHash: closeRequestHash({ date: DAY, attestChecked: true }), reportVersion: 'x'.repeat(16), report: built().report, verification: {} };
    const findUnique = jest.fn();
    const h = closer({ reports: [built()], won: 0, event: { kind: 'closed', payload } });
    // Before the transaction the day is still being counted; by the time the loser asks again, the winner has locked it.
    findUnique.mockResolvedValueOnce({ id: CLOSING, status: 'counting' });
    findUnique.mockResolvedValueOnce({ id: CLOSING, status: 'counting', version: 0, channelCounts: [], reopenedAt: null, reopenCount: 0, firstClosedAt: null });
    findUnique.mockResolvedValue({ id: CLOSING, status: 'locked' });
    h.db.dailyClosing.findUnique = findUnique as never;
    expect(await h.svc.close(asked)).toMatchObject({ replayed: true });
    expect(h.events).toEqual([]);
  });
});

// ── Counts behind the day's lock ─────────────────────────────────────────────

function counter(opts: { plain?: string; locked?: string; complete?: boolean } = {}) {
  const writes: { table: string; op: string; args: Row }[] = [];
  const write = (table: string, op: string) =>
    jest.fn(async (args: Row) => {
      writes.push({ table, op, args });
      return { id: Buffer.alloc(16, 7), ...(args?.data ?? {}) };
    });
  const channels = buildChannels([{ channel: 'cash', accountId: null, component: 'salesIn', amount: CASH_IN }], [], 0);
  const db = {
    dailyClosing: {
      findUnique: jest.fn(async () => ({ id: CLOSING, status: opts.plain ?? 'counting' })),
      create: write('dailyClosing', 'create'),
      updateMany: write('dailyClosing', 'updateMany'),
    },
    closingChannelCount: { findFirst: jest.fn(async () => null), create: write('closingChannelCount', 'create'), update: write('closingChannelCount', 'update') },
    closingEvent: { create: write('closingEvent', 'create') },
    $queryRaw: jest.fn(async (_q: Prisma.Sql) => [{ status: opts.locked ?? opts.plain ?? 'counting', reopened_at: null }]),
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>): Promise<unknown> => fn(db)),
  };
  const svc = service({
    db,
    audit: { recordTx: jest.fn(async () => undefined) },
    dayChannels: jest.fn(async () => ({ channels })),
    countingDone: jest.fn(async () => opts.complete ?? true),
    openView: jest.fn(async (day: string) => ({ date: day })),
  });
  return { svc, db, writes };
}

describe('POST closings/count — a count cannot race a close (D159)', () => {
  it('in one transaction behind the day’s lock: the row, its figure read under the lock, a conditional status, the event', async () => {
    const h = counter();
    const result = await h.svc.recordCount({ channel: 'cash', counted: CASH_IN });
    expect(h.db.$queryRaw.mock.calls[0][0].sql).toMatch(/SELECT status, reopened_at FROM daily_closings WHERE id = \? FOR UPDATE/);
    expect(h.db.$queryRaw.mock.calls[0][0].values).toEqual([CLOSING]);
    const [row] = h.writes.filter((w) => w.table === 'closingChannelCount');
    expect(row.args.data).toMatchObject({ expected: CASH_IN, counted: CASH_IN, difference: 0 });
    // Never onto a locked row: the condition says so, whatever the lock read.
    expect(h.writes.find((w) => w.table === 'dailyClosing' && w.op === 'updateMany')!.args).toMatchObject({ where: { id: CLOSING, status: { not: 'locked' } }, data: { status: 'counted' } });
    expect(h.writes.map((w) => w.table)).toEqual(['closingChannelCount', 'dailyClosing', 'closingEvent']);
    // Its answer is the day as it stands, with the status it moved to — as before.
    expect(result).toEqual({ date: DAY, status: 'counted' });
  });

  it('a day closed before the count reached the lock: 409 already_closed, nothing written', async () => {
    const h = counter({ plain: 'counted', locked: 'locked' });
    const { error, body } = await refusal(h.svc.recordCount({ channel: 'cash', counted: CASH_IN }));
    expect(error).toBeInstanceOf(ConflictException);
    expect(body).toEqual({ code: 'already_closed', message: `Day ${DAY} is already closed for this branch` });
    expect(h.writes).toEqual([]);
  });

  it('a day already locked is refused by name before anything is read', async () => {
    const h = counter({ plain: 'locked' });
    expect((await refusal(h.svc.recordCount({ channel: 'cash', counted: CASH_IN }))).body).toMatchObject({ code: 'already_closed' });
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });

  it('a reopened day stays reopened, whatever is left to count', async () => {
    const h = counter({ plain: 'reopened' });
    await h.svc.recordCount({ channel: 'cash', counted: CASH_IN });
    expect(h.writes.find((w) => w.op === 'updateMany')!.args.data).toMatchObject({ status: 'reopened' });
  });
});
