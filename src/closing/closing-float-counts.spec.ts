import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { uuidToBin } from '../common/utils/uuid.util';
import { dateValue } from '../common/business-day/business-day.service';
import { buildChannels } from './channels';
import { assembleReport, floatSinceCount, reportVersion, type ReportInputs } from './closing-report';
import { ClosingService } from './closing.service';

/**
 * A provider float at the closing of an agent branch (D154, docs/73 §4.5),
 * driven through the real service over a mocked database: what a count writes
 * — the row, its difference as a question, the day's event and audit — what a
 * refusal leaves untouched, where the lock stops, and the anchor a locked
 * close leaves on a counted float. The drawer's own rules are tested with the
 * closing; this file is the floats'.
 */

const COMPANY = Buffer.alloc(16, 1);
const BRANCH = Buffer.alloc(16, 2);
const USER = Buffer.alloc(16, 3);
const BANKILY = '01a0b1c2-0000-7000-8000-00000000000b';
const SEDAD = '01a0b1c2-0000-7000-8000-00000000000c';
const CLOSING = Buffer.alloc(16, 9);
const DAY = '2026-10-08';
const t = (hhmm: string) => new Date(`${DAY}T${hhmm}:00Z`);

type Row = Record<string, any>;

interface Options {
  activity?: string;
  /** The float's anchor and legs: expected = anchor + legs after it. Absent: unknown. */
  anchor?: { amount: number; at: Date; source?: string } | null;
  /** The closing's float count rows, as the report and the live view read them. */
  saved?: Row[];
  legs?: { direction: 'inflow' | 'outflow'; amount: number; at: Date }[];
  closing?: Row | null;
  prior?: Row | null;
  questions?: Row[];
  complete?: boolean;
  today?: string;
  /** The day's row as the count's lock reads it (D159); the plain read before it is `closing`. */
  lockedStatus?: string;
}

function harness(opts: Options = {}) {
  const writes: { table: string; op: string; args: Row }[] = [];
  const write = (table: string, op: string) =>
    jest.fn(async (args: Row) => {
      writes.push({ table, op, args });
      return { id: args?.data?.id ?? Buffer.alloc(16, 7), ...(args?.data ?? {}) };
    });
  const legs = opts.legs ?? [];
  const db = {
    branch: { findFirst: jest.fn(async () => ({ activity: opts.activity ?? 'money_agent' })) },
    agentProvider: {
      findFirst: jest.fn(async ({ where }: { where: { id: Buffer } }) => (where.id.equals(uuidToBin(BANKILY)) ? { id: where.id, label: 'Bankily' } : null)),
      findMany: jest.fn(async () => [{ id: uuidToBin(BANKILY), label: 'Bankily', isActive: true }]),
    },
    dailyClosing: {
      findUnique: jest.fn(async () => opts.closing === undefined ? { id: CLOSING, status: 'counting', version: 0, channelCounts: [] } : opts.closing),
      create: write('dailyClosing', 'create'),
      updateMany: write('dailyClosing', 'updateMany'),
    },
    agentPosition: {
      findFirst: jest.fn(async ({ where }: { where: Row }) => {
        if (where.clientUuid) return null;
        const a = opts.anchor ?? null;
        if (!a || (where.at?.lte && a.at.getTime() > where.at.lte.getTime())) return null;
        return { amount: new Prisma.Decimal(a.amount), at: a.at, businessDate: dateValue(DAY), source: a.source ?? 'set', recordedByName: 'Owner' };
      }),
      create: write('agentPosition', 'create'),
    },
    agentMovement: {
      groupBy: jest.fn(async ({ where }: { where: Row }) => {
        const after = where.recordedAt?.gt as Date | undefined;
        const upTo = where.recordedAt?.lte as Date | undefined;
        const rows = legs.filter((l) => (!after || l.at.getTime() > after.getTime()) && (!upTo || l.at.getTime() <= upTo.getTime()));
        return (['inflow', 'outflow'] as const).map((direction) => ({ direction, _sum: { amount: new Prisma.Decimal(rows.filter((l) => l.direction === direction).reduce((n, l) => n + l.amount, 0)) } }));
      }),
    },
    agentFloatCount: {
      findFirst: jest.fn(async () => opts.prior ?? null),
      findMany: jest.fn(async () => opts.saved ?? []),
      create: write('agentFloatCount', 'create'),
      update: write('agentFloatCount', 'update'),
    },
    closingDiscrepancy: {
      findMany: jest.fn(async () => opts.questions ?? []),
      create: write('closingDiscrepancy', 'create'),
      update: write('closingDiscrepancy', 'update'),
    },
    closingEvent: { create: write('closingEvent', 'create') },
    user: { findFirst: jest.fn(async () => ({ name: 'Owner' })) },
    // The count's lock on the day's row (D159), read by the locking statement.
    $queryRaw: jest.fn(async (_sql: Prisma.Sql) => [{ status: opts.lockedStatus ?? opts.closing?.status ?? 'counting', reopened_at: null }]),
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(db)),
  };
  // Inside the count's transaction, in order: one list of what was audited.
  const record = jest.fn(async (_entry: Row) => undefined);
  const audit = { record, recordTx: jest.fn(async (_tx: unknown, entry: Row) => record(entry)) };
  const today = opts.today ?? DAY;
  const businessDay = { today: jest.fn(async () => today), windowOf: jest.fn(async (day: string) => ({ start: new Date(`${day}T06:00:00Z`), end: new Date(new Date(`${day}T06:00:00Z`).getTime() + 86_400_000) })) };
  const openView = jest.fn(async (day: string) => ({
    date: day,
    complete: opts.complete ?? false,
    floats: [{ providerId: BANKILY, label: 'Bankily', expected: 30_200, counted: 30_100, difference: -100, explanation: null, isSkipped: false, skipReason: null, countedAt: null, countedByName: 'Owner' }],
  }));
  const svc = Object.create(ClosingService.prototype) as ClosingService & Record<string, unknown>;
  Object.assign(svc, {
    db,
    audit,
    businessDay,
    openView,
    // Whether nothing countable is left, and the day's channels it is read against: the channels' own tests are the closing's.
    countingDone: jest.fn(async () => opts.complete ?? false),
    dayChannels: jest.fn(async () => ({ channels: [] })),
    tenant: { companyId: () => COMPANY, requireBranchId: () => BRANCH, userId: () => USER, requireUserId: () => USER },
  });
  return { svc, db, audit, writes, openView, businessDay };
}

const refusal = async (p: Promise<unknown>) => {
  const e = await p.catch((err: unknown) => err);
  return { error: e, body: (e as { getResponse?: () => unknown }).getResponse?.() as Record<string, unknown> | undefined };
};

const of = (writes: { table: string; op: string; args: Row }[], table: string, op?: string) => writes.filter((w) => w.table === table && (!op || w.op === op));

describe('POST closings/:date/float-counts — counting a provider float', () => {
  it('writes the row with the float as the app tracked it at this instant, the difference, the person and the time; opens the question; records the event and the audit', async () => {
    const h = harness({ anchor: { amount: 50_000, at: t('08:00') }, legs: [{ direction: 'outflow', amount: 20_000, at: t('09:00') }, { direction: 'inflow', amount: 200, at: t('09:00') }], complete: true });
    const before = Date.now();
    const result = await h.svc.recordFloatCount(DAY, { providerId: BANKILY, counted: 30_100, explanation: ' a fee ' });

    const [row] = of(h.writes, 'agentFloatCount', 'create');
    expect(row.args.data).toMatchObject({
      companyId: COMPANY,
      closingId: CLOSING,
      branchId: BRANCH,
      providerId: uuidToBin(BANKILY),
      expected: 30_200,
      counted: 30_100,
      difference: -100,
      explanation: 'a fee',
      isSkipped: false,
      skipReason: null,
      countedById: USER,
    });
    expect(row.args.data.countedAt.getTime()).toBeGreaterThanOrEqual(before);
    // The expected figure is read as of the count instant: the anchor at or before it, the legs after the anchor and not after it.
    expect(h.db.agentPosition.findFirst.mock.calls[0][0].where).toMatchObject({ branchId: BRANCH, accountKind: 'provider', providerId: uuidToBin(BANKILY), at: { lte: expect.any(Date) } });
    // A difference becomes a question, not a number: opened on the float's row, through the one rule a channel's follows.
    const [question] = of(h.writes, 'closingDiscrepancy', 'create');
    expect(question.args.data).toMatchObject({ companyId: COMPANY, branchId: BRANCH, closingId: CLOSING, agentFloatCountId: row.args.data.id, amount: -100 });
    expect(question.args.data).not.toHaveProperty('channelCountId');
    // The day: counted once nothing is outstanding — never onto a locked row (D159) — the event on the timeline, the audit row.
    expect(of(h.writes, 'dailyClosing', 'updateMany')[0].args).toMatchObject({ where: { id: CLOSING, status: { not: 'locked' } }, data: { status: 'counted', countedById: USER } });
    expect(of(h.writes, 'closingEvent', 'create')[0].args.data).toMatchObject({ kind: 'count_saved', closingId: CLOSING, businessDate: dateValue(DAY), actorId: USER });
    expect(of(h.writes, 'closingEvent', 'create')[0].args.data.payload).toEqual({ channel: 'float', accountId: null, providerId: BANKILY, label: 'Bankily', counted: 30_100, expected: 30_200, difference: -100, skipped: false, skipReason: null });
    expect(h.audit.record).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'AgentFloatCount', action: 'create', after: expect.objectContaining({ day: DAY, providerId: BANKILY, counted: 30_100, expected: 30_200, difference: -100, explanation: 'a fee' }), branchId: BRANCH }));
    expect(result).toMatchObject({ status: 'counted', float: expect.objectContaining({ providerId: BANKILY, counted: 30_100 }) });
  });

  it('an unknown float records the count against nothing: expected null, difference null, no question opened', async () => {
    const h = harness({ anchor: null, legs: [{ direction: 'inflow', amount: 15_150, at: t('10:00') }] });
    await h.svc.recordFloatCount(DAY, { providerId: BANKILY, counted: 40_000 });
    expect(of(h.writes, 'agentFloatCount', 'create')[0].args.data).toMatchObject({ expected: null, counted: 40_000, difference: null });
    expect(of(h.writes, 'closingDiscrepancy')).toEqual([]);
    expect(of(h.writes, 'dailyClosing', 'updateMany')[0].args.data).toMatchObject({ status: 'counting' });
  });

  it('a skip with a reason is a decision, recorded as one: no amount, no difference, no question', async () => {
    const h = harness({ anchor: { amount: 1_000, at: t('08:00') } });
    await h.svc.recordFloatCount(DAY, { providerId: BANKILY, skip: true, skipReason: ' App down ' });
    expect(of(h.writes, 'agentFloatCount', 'create')[0].args.data).toMatchObject({ expected: 1_000, counted: null, difference: null, isSkipped: true, skipReason: 'App down' });
    expect(of(h.writes, 'closingDiscrepancy')).toEqual([]);
    expect(of(h.writes, 'closingEvent', 'create')[0].args.data.payload).toMatchObject({ skipped: true, skipReason: 'App down' });
  });

  it('a recount replaces the row and moves its question: a changed difference updates it, none left resolves it', async () => {
    const prior = { id: Buffer.alloc(16, 5) };
    const pending = { id: Buffer.alloc(16, 6), status: 'pending_investigation', amount: new Prisma.Decimal(-100) };
    const moved = harness({ anchor: { amount: 30_200, at: t('08:00') }, prior, questions: [pending] });
    await moved.svc.recordFloatCount(DAY, { providerId: BANKILY, counted: 30_150 });
    expect(of(moved.writes, 'agentFloatCount', 'update')[0].args).toMatchObject({ where: { id: prior.id }, data: { counted: 30_150, difference: -50 } });
    expect(of(moved.writes, 'closingDiscrepancy', 'update')[0].args).toMatchObject({ where: { id: pending.id }, data: { amount: -50 } });
    expect(moved.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'update' }));
    const agreed = harness({ anchor: { amount: 30_200, at: t('08:00') }, prior, questions: [pending] });
    await agreed.svc.recordFloatCount(DAY, { providerId: BANKILY, counted: 30_200 });
    expect(of(agreed.writes, 'closingDiscrepancy', 'update')[0].args.data).toMatchObject({ status: 'resolved', resolution: 'error_corrected', resolvedById: USER });
  });

  it('a day behind the boundary is counted against the float at that day’s end, never against today’s movement', async () => {
    const h = harness({ today: '2026-10-09', anchor: { amount: 50_000, at: t('08:00') }, legs: [{ direction: 'outflow', amount: 20_000, at: t('09:00') }, { direction: 'outflow', amount: 999, at: new Date('2026-10-09T10:00:00Z') }] });
    await h.svc.recordFloatCount(DAY, { providerId: BANKILY, counted: 30_000 });
    expect(h.businessDay.windowOf).toHaveBeenCalledWith(DAY);
    expect(of(h.writes, 'agentFloatCount', 'create')[0].args.data).toMatchObject({ expected: 30_000, difference: 0 });
  });

  describe('refused, nothing written', () => {
    it('an electronics-only branch, by name', async () => {
      const h = harness({ activity: 'electronics' });
      const { error, body } = await refusal(h.svc.recordFloatCount(DAY, { providerId: BANKILY, counted: 1 }));
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(body).toMatchObject({ code: 'activity_not_subscribed', activity: 'electronics', required: 'money_agent' });
      expect(h.writes).toEqual([]);
    });

    it('a count and a skip together, a skip without a reason, a reserved reason, neither a count nor a skip', async () => {
      for (const dto of [
        { providerId: BANKILY, counted: 1, skip: true, skipReason: 'x' },
        { providerId: BANKILY, skip: true },
        { providerId: BANKILY, skip: true, skipReason: 'ATTESTED_AT_CLOSE' },
        { providerId: BANKILY },
      ]) {
        const h = harness();
        const { error } = await refusal(h.svc.recordFloatCount(DAY, dto));
        expect(error).toBeInstanceOf(BadRequestException);
        expect(h.writes).toEqual([]);
      }
    });

    it('a day closed after the plain read, found by the count’s own lock: 409 already_closed, nothing written (D159)', async () => {
      const h = harness({ anchor: { amount: 1_000, at: t('08:00') }, lockedStatus: 'locked' });
      const { error, body } = await refusal(h.svc.recordFloatCount(DAY, { providerId: BANKILY, counted: 1_000 }));
      expect(error).toBeInstanceOf(ConflictException);
      expect(body).toEqual({ code: 'already_closed', message: `Day ${DAY} is already closed for this branch` });
      expect(h.db.$queryRaw.mock.calls[0][0].sql).toMatch(/SELECT status, reopened_at FROM daily_closings WHERE id = \? FOR UPDATE/);
      expect(h.writes).toEqual([]);
    });

    it('an unknown provider, a locked day, a day that has not begun', async () => {
      const unknown = await refusal(harness().svc.recordFloatCount(DAY, { providerId: SEDAD, counted: 1 }));
      expect(unknown.error).toBeInstanceOf(NotFoundException);
      expect(unknown.body?.code).toBe('provider_not_found');
      const locked = harness({ closing: { id: CLOSING, status: 'locked', version: 3, channelCounts: [] } });
      expect((await refusal(locked.svc.recordFloatCount(DAY, { providerId: BANKILY, counted: 1 }))).error).toBeInstanceOf(ConflictException);
      expect(locked.writes).toEqual([]);
      expect((await refusal(harness().svc.recordFloatCount('2026-10-09', { providerId: BANKILY, counted: 1 }))).error).toBeInstanceOf(BadRequestException);
    });
  });
});

/**
 * The lock (D154): every active provider's float is counted or skipped before the day locks. Driven through the
 * real `close`, with the report handed in — the drawer's figures are the closing's own tests — up to the refusal,
 * or past it to the acknowledgement that proves the floats were checked first.
 */
describe('POST closings — the lock waits for the floats', () => {
  function closer(opts: { providers: Row[]; counts: Row[]; counted?: Row[] }) {
    const channels = buildChannels([{ channel: 'cash', accountId: null, component: 'agentIn', amount: 20_000 }, { channel: 'cash', accountId: null, component: 'agentOut', amount: 15_000 }], [], 0);
    const report = assembleReport({
      date: DAY,
      today: DAY,
      timezone: 'UTC',
      window: { startsAt: `${DAY}T06:00:00.000Z`, endsAt: '2026-10-09T06:00:00.000Z' },
      standing: 'counting',
      sales: { count: 0, value: 0, itemsSold: 0, cost: 0, missingCostLines: 0 },
      returns: { count: 0, grossRefund: 0, adjustments: 0, netRefundDue: 0, costCredited: 0, missingCostLines: 0 },
      cancellations: { count: 0, value: 0, items: 0, cost: 0, missingCostLines: 0, ofTheseSales: 0 },
      collected: { atCheckout: 0, laterSameDay: 0, corrections: 0 },
      channels,
      splits: new Map(),
      expenses: [],
      expenseReversals: [],
      counts: new Map(),
      opening: { amount: 0, anchorDate: null, anchorVerified: false, carriedDays: 0 },
      pending: null,
      openDiscrepancies: 0,
      previousDay: null,
      closeKind: 'first',
    } satisfies ReportInputs);
    const floats = { providers: opts.providers, counts: new Map(opts.counts.map((c) => [c.providerId, c])), rows: [], counted: opts.counted ?? [] };
    const db = {
      dailyClosing: { findUnique: jest.fn(async () => ({ id: CLOSING, status: 'counting', version: 0, channelCounts: [], reopenedAt: null })) },
      dailyRollup: { findUnique: jest.fn(async () => null) },
      payment: { aggregate: jest.fn(async () => ({ _sum: { amount: null } })) },
      $queryRaw: jest.fn(async () => [{}]),
      $transaction: jest.fn(),
    };
    const svc = Object.create(ClosingService.prototype) as ClosingService & Record<string, unknown>;
    Object.assign(svc, {
      db,
      tenant: { companyId: () => COMPANY, requireBranchId: () => BRANCH, userId: () => USER, requireUserId: () => USER },
      businessDay: { describe: jest.fn(async () => ({ businessDate: DAY, localDate: DAY, timezone: 'UTC', canStartEarly: false, startedEarly: false })) },
      cls: { get: () => new Set(['closing.count', 'closing.perform']) },
      rollups: { recomputeDaily: jest.fn(async () => undefined) },
      buildReport: jest.fn(async () => ({ report, version: reportVersion(report), invariantFailures: [], channels, closing: null, opening: report.expected.cash.opening, cashAdjustment: 0, floats })),
      stockPaidOn: jest.fn(async () => ({ total: 0, cash: 0 })),
      // The drawer's independent check reads the same agent legs the report shows: 20 000 in, 15 000 out.
      agentCashOn: jest.fn(async () => ({ in: 20_000, out: 15_000 })),
    });
    return { svc, db };
  }
  const bankily = { providerId: BANKILY, label: 'Bankily', isActive: true };
  const sedad = { providerId: SEDAD, label: 'Sedad', isActive: true };

  it('refuses with the active providers still to count, before anything is locked', async () => {
    const { svc, db } = closer({ providers: [bankily, sedad], counts: [{ providerId: BANKILY, counted: 30_100, isSkipped: false }] });
    const { error, body } = await refusal(svc.close({}));
    expect(error).toBeInstanceOf(ConflictException);
    expect(body).toMatchObject({ code: 'float_count_required', providers: [{ providerId: SEDAD, label: 'Sedad' }] });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('a counted and a skipped float let the close go on to the drawer’s own acknowledgement; an electronics-only day meets no float', async () => {
    const counted = closer({ providers: [bankily, sedad], counts: [{ providerId: BANKILY, counted: 30_100, isSkipped: false }, { providerId: SEDAD, counted: null, isSkipped: true }] });
    expect((await refusal(counted.svc.close({}))).body?.code).toBe('acknowledgement_required');
    const electronics = closer({ providers: [], counts: [] });
    expect((await refusal(electronics.svc.close({}))).body?.code).toBe('acknowledgement_required');
  });
});

describe('a locked close anchors each counted float (D154)', () => {
  it('one agent_positions row per count — counted_close, at the count instant, what was tracked and the difference beside it, recorded by the locker', async () => {
    const h = harness();
    const countedAt = t('21:05');
    await (h.svc as unknown as { anchorCountedFloatsTx: (tx: unknown, args: Row) => Promise<void> }).anchorCountedFloatsTx(h.db, {
      companyId: COMPANY,
      branchId: BRANCH,
      closingId: CLOSING,
      day: DAY,
      counted: [
        { providerId: uuidToBin(BANKILY), counted: 149_900, expected: 150_000, countedAt },
        { providerId: uuidToBin(SEDAD), counted: 40_000, expected: null, countedAt },
      ],
    });
    const rows = of(h.writes, 'agentPosition', 'create').map((w) => w.args.data);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      companyId: COMPANY,
      branchId: BRANCH,
      accountKind: 'provider',
      providerId: uuidToBin(BANKILY),
      amount: 149_900,
      at: countedAt,
      businessDate: dateValue(DAY),
      source: 'counted_close',
      trackedBefore: 150_000,
      difference: -100,
      note: null,
      recordedById: USER,
      recordedByName: 'Owner',
    });
    expect(rows[1]).toMatchObject({ providerId: uuidToBin(SEDAD), amount: 40_000, trackedBefore: null, difference: null });
    expect(rows[0].clientUuid).toHaveLength(16);
    expect(rows[0].clientRequestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].clientUuid.equals(rows[1].clientUuid)).toBe(false);
  });

  it('a day counted behind the boundary is anchored at that day’s end — the instant its expected figure was taken — so the next morning’s legs stay after it', async () => {
    const h = harness();
    const dayEnd = new Date(new Date(`${DAY}T06:00:00Z`).getTime() + 86_400_000);
    // Counted at 10:00 the next morning; the expected figure was the float at the day's end (06:00).
    const nextMorning = new Date(dayEnd.getTime() + 4 * 3_600_000);
    await (h.svc as unknown as { anchorCountedFloatsTx: (tx: unknown, args: Row) => Promise<void> }).anchorCountedFloatsTx(h.db, {
      companyId: COMPANY,
      branchId: BRANCH,
      closingId: CLOSING,
      day: DAY,
      counted: [{ providerId: uuidToBin(BANKILY), counted: 50_000, expected: 50_000, countedAt: nextMorning }],
    });
    const [row] = of(h.writes, 'agentPosition', 'create').map((w) => w.args.data);
    expect(row).toMatchObject({ amount: 50_000, at: dayEnd, businessDate: dateValue(DAY), difference: 0 });
    // The float now: the anchor plus the legs strictly after it — an exchange at 09:00 the next morning still counts.
    const at09 = new Date(dayEnd.getTime() + 3 * 3_600_000);
    expect(at09.getTime()).toBeGreaterThan((row.at as Date).getTime());
  });

  it('a reclose that re-locks the same count writes nothing new; no counted float, nothing read', async () => {
    const again = harness();
    again.db.agentPosition.findFirst.mockImplementation((async () => ({ id: Buffer.alloc(16, 4) })) as unknown as typeof again.db.agentPosition.findFirst);
    await (again.svc as unknown as { anchorCountedFloatsTx: (tx: unknown, args: Row) => Promise<void> }).anchorCountedFloatsTx(again.db, {
      companyId: COMPANY,
      branchId: BRANCH,
      closingId: CLOSING,
      day: DAY,
      counted: [{ providerId: uuidToBin(BANKILY), counted: 149_900, expected: 150_000, countedAt: t('21:05') }],
    });
    expect(of(again.writes, 'agentPosition')).toEqual([]);
    const none = harness();
    await (none.svc as unknown as { anchorCountedFloatsTx: (tx: unknown, args: Row) => Promise<void> }).anchorCountedFloatsTx(none.db, { companyId: COMPANY, branchId: BRANCH, closingId: CLOSING, day: DAY, counted: [] });
    expect(none.db.user.findFirst).not.toHaveBeenCalled();
  });
});

/**
 * A counted float against the float now (D159): what the report and the live view compare it with. The count was held
 * against what the app tracked at its instant; a leg or a set after it moves the float, and the close waits for a
 * recount. On a day reopened since its close, the close's own anchor of that very count is the count, not a move.
 */
describe('a counted float held against the float now (D159)', () => {
  const read = (h: ReturnType<typeof harness>, closing: Row, today = DAY) =>
    (h.svc as unknown as { floatCountsFor: (b: Buffer, c: Row, d: string, t: string) => Promise<{ rows: Record<string, any>[] }> }).floatCountsFor(BRANCH, closing, DAY, today);
  const countedRow = (over: Row = {}): Row => ({
    providerId: uuidToBin(BANKILY),
    expected: new Prisma.Decimal(30_000),
    counted: new Prisma.Decimal(30_000),
    explanation: null,
    isSkipped: false,
    skipReason: null,
    countedAt: t('10:00'),
    countedBy: { name: 'Aicha' },
    ...over,
  });

  it('an exchange’s float leg after the count moves it: expected is the float now, expectedAtCount the figure counted against', async () => {
    const h = harness({
      anchor: { amount: 50_000, at: t('08:00') },
      legs: [{ direction: 'outflow', amount: 20_000, at: t('09:00') }, { direction: 'inflow', amount: 500, at: t('11:00') }],
      saved: [countedRow()],
    });
    const [row] = (await read(h, { id: CLOSING, status: 'counting' })).rows;
    expect(row).toMatchObject({ expected: 30_500, expectedAtCount: 30_000, counted: 30_000 });
    expect(floatSinceCount(row as never)).toEqual({ expectedAtCount: 30_000, movedSinceCount: true });
  });

  it('nothing after the count: the float holds', async () => {
    const h = harness({ anchor: { amount: 50_000, at: t('08:00') }, legs: [{ direction: 'outflow', amount: 20_000, at: t('09:00') }], saved: [countedRow()] });
    const [row] = (await read(h, { id: CLOSING, status: 'counting' })).rows;
    expect(floatSinceCount(row as never)).toEqual({ expectedAtCount: 30_000, movedSinceCount: false });
  });

  it('a day reopened since its close: the close’s anchor of this very count is the count, so only the legs after it move the float', async () => {
    // Counted 29 900 against 30 000; the close anchored the float at 29 900 at the count instant; the day was reopened.
    const anchoredByTheClose = { amount: 29_900, at: t('10:00'), source: 'counted_close' };
    const still = harness({ anchor: anchoredByTheClose, saved: [countedRow({ counted: new Prisma.Decimal(29_900) })] });
    expect(floatSinceCount((await read(still, { id: CLOSING, status: 'reopened' })).rows[0] as never)).toEqual({ expectedAtCount: 30_000, movedSinceCount: false });
    const moved = harness({ anchor: anchoredByTheClose, legs: [{ direction: 'inflow', amount: 700, at: t('12:00') }], saved: [countedRow({ counted: new Prisma.Decimal(29_900) })] });
    const [row] = (await read(moved, { id: CLOSING, status: 'reopened' })).rows;
    expect(row).toMatchObject({ expected: 30_700, expectedAtCount: 30_000 });
    expect(floatSinceCount(row as never).movedSinceCount).toBe(true);
  });

  it('a locked day is read as it was closed: the stored figure, compared with nothing', async () => {
    const h = harness({ anchor: { amount: 50_000, at: t('08:00') }, legs: [{ direction: 'inflow', amount: 500, at: t('11:00') }], saved: [countedRow()] });
    const [row] = (await read(h, { id: CLOSING, status: 'locked' })).rows;
    expect(row.expected).toBe(30_000);
    expect(row).not.toHaveProperty('expectedAtCount');
    expect(floatSinceCount(row as never)).toEqual({ expectedAtCount: null, movedSinceCount: false });
  });

  it('a skipped float is not compared', async () => {
    const h = harness({ anchor: { amount: 50_000, at: t('08:00') }, legs: [{ direction: 'inflow', amount: 500, at: t('11:00') }], saved: [countedRow({ counted: null, isSkipped: true, skipReason: 'App down' })] });
    const [row] = (await read(h, { id: CLOSING, status: 'counting' })).rows;
    expect(floatSinceCount(row as never)).toEqual({ expectedAtCount: null, movedSinceCount: false });
  });
});
