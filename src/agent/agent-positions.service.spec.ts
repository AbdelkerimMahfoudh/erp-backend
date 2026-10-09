import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { binToUuid, uuidToBin } from '../common/utils/uuid.util';
import { dateValue } from '../common/business-day/business-day.service';
import { AgentPositionsService } from './agent-positions.service';
import { positionFingerprint } from './agent-rules';

/**
 * The money of an agent branch (docs/73 §4.4–4.5): the drawer handed in by the
 * closing, each float from its anchor and legs, and the Owner setting a float.
 * The database is mocked; what is asserted is what would be read and written.
 */

const COMPANY = Buffer.alloc(16, 1);
const BRANCH = Buffer.alloc(16, 2);
const USER = Buffer.alloc(16, 3);
const BANKILY = '01a0b1c2-0000-7000-8000-00000000000b';
const SEDAD = '01a0b1c2-0000-7000-8000-00000000000c';
const OLD = '01a0b1c2-0000-7000-8000-00000000000d';
const KEY = '01a0b1c2-0000-7000-8000-0000000000aa';
const DAY = '2026-10-08';
const t = (hhmm: string) => new Date(`${DAY}T${hhmm}:00Z`);

type Row = Record<string, any>;

/** The slice of Prisma's `where` the float reads use: equality, Buffers, dates, `in`, and the instant bounds. */
function matches(row: Row, where: Row): boolean {
  for (const [key, cond] of Object.entries(where)) {
    const actual = row[key];
    if (cond === undefined) continue;
    if (Buffer.isBuffer(cond)) {
      if (!Buffer.isBuffer(actual) || !cond.equals(actual)) return false;
    } else if (cond instanceof Date) {
      if (!(actual instanceof Date) || actual.getTime() !== cond.getTime()) return false;
    } else if (cond && typeof cond === 'object') {
      if ('in' in cond && !cond.in.some((v: unknown) => (Buffer.isBuffer(v) ? v.equals(actual) : v === actual))) return false;
      if ('gt' in cond && !(actual > cond.gt)) return false;
      if ('gte' in cond && !(actual >= cond.gte)) return false;
      if ('lt' in cond && !(actual < cond.lt)) return false;
      if ('lte' in cond && !(actual <= cond.lte)) return false;
    } else if (actual !== cond) return false;
  }
  return true;
}

const provider = (id: string, label: string, over: Row = {}): Row => ({ id: uuidToBin(id), kind: 'bankily', label, isActive: true, sortOrder: 1, ...over });
const anchorRow = (providerId: string, amount: number, at: Date, over: Row = {}): Row => ({
  id: uuidToBin('01a0b1c2-0000-7000-8000-0000000000f1'),
  branchId: BRANCH,
  accountKind: 'provider',
  providerId: uuidToBin(providerId),
  amount: new Prisma.Decimal(amount),
  at,
  businessDate: dateValue(DAY),
  source: 'set',
  trackedBefore: null,
  difference: null,
  note: null,
  recordedByName: 'Owner',
  clientUuid: uuidToBin('01a0b1c2-0000-7000-8000-0000000000f2'),
  clientRequestHash: 'x'.repeat(64),
  createdAt: at,
  ...over,
});
const leg = (providerId: string, direction: 'inflow' | 'outflow', amount: number, at: Date, accountKind = 'provider'): Row => ({
  branchId: BRANCH,
  accountKind,
  providerId: uuidToBin(providerId),
  direction,
  amount: new Prisma.Decimal(amount),
  recordedAt: at,
  businessDate: dateValue(DAY),
});

function harness(opts: { activity?: string; providers?: Row[]; positions?: Row[]; movements?: Row[]; configs?: Record<string, Row>; cash?: Row; race?: () => boolean } = {}) {
  const providers = opts.providers ?? [provider(BANKILY, 'Bankily'), provider(SEDAD, 'Sedad', { kind: 'sedad', sortOrder: 2 })];
  const positions: Row[] = [...(opts.positions ?? [])];
  const movements: Row[] = [...(opts.movements ?? [])];
  const sum = (rows: Row[]) => rows.reduce((n, r) => n + Number(r.amount), 0);
  const db = {
    branch: { findFirst: jest.fn(async () => ({ activity: opts.activity ?? 'money_agent' })) },
    agentProvider: { findMany: jest.fn(async () => providers) },
    agentProviderConfig: { findFirst: jest.fn(async ({ where }: { where: { providerId: Buffer } }) => opts.configs?.[binToUuid(where.providerId)] ?? null) },
    agentPosition: {
      findFirst: jest.fn(async ({ where, select }: { where: Row; select?: Row }) => {
        if (where.clientUuid) {
          const hit = positions.find((p) => p.clientUuid.equals(where.clientUuid));
          return hit ? { id: hit.id, clientRequestHash: hit.clientRequestHash } : null;
        }
        const [latest] = positions.filter((p) => matches(p, where)).sort((a, b) => b.at.getTime() - a.at.getTime() || b.createdAt.getTime() - a.createdAt.getTime());
        void select;
        return latest ?? null;
      }),
      findFirstOrThrow: jest.fn(async ({ where }: { where: { id: Buffer } }) => {
        const row = positions.find((p) => p.id.equals(where.id))!;
        return { ...row, provider: providers.find((p) => p.id.equals(row.providerId)) };
      }),
      groupBy: jest.fn(async ({ where }: { where: Row }) => {
        const seen = new Map<string, Row>();
        for (const p of positions.filter((r) => matches(r, where))) seen.set(`${p.accountKind}:${p.providerId.toString('hex')}`, { accountKind: p.accountKind, providerId: p.providerId });
        return [...seen.values()];
      }),
      create: jest.fn(async ({ data }: { data: Row }) => {
        if (opts.race?.()) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
        positions.push({ ...data, createdAt: new Date() });
        return data;
      }),
    },
    agentMovement: {
      groupBy: jest.fn(async ({ by, where }: { by: string[]; where: Row }) => {
        const rows = movements.filter((m) => matches(m, where));
        if (by.includes('direction')) {
          return (['inflow', 'outflow'] as const).map((direction) => ({ direction, _sum: { amount: new Prisma.Decimal(sum(rows.filter((m) => m.direction === direction))) } }));
        }
        const seen = new Map<string, Row>();
        for (const m of rows) seen.set(`${m.accountKind}:${m.providerId.toString('hex')}`, { accountKind: m.accountKind, providerId: m.providerId });
        return [...seen.values()];
      }),
    },
    user: { findFirst: jest.fn(async () => ({ name: 'Owner' })) },
    $queryRaw: jest.fn(async (sql: Prisma.Sql) => {
      const id = sql.values[0] as Buffer;
      const found = providers.find((p) => p.id.equals(id));
      return found ? [{ id: found.id, label: found.label }] : [];
    }),
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(db)),
  };
  const cash = opts.cash ?? { key: 'cash', channel: 'cash', known: true, position: 10_000, unknownReason: null, anchor: { source: 'opening', amount: 10_000 }, sinceAnchorNet: 0, movement: { businessDate: DAY, inflows: 0, outflows: 0, net: 0 } };
  const closing = { drawerMethod: jest.fn(async () => cash) };
  const audit = { recordTx: jest.fn(async (_tx: unknown, _entry: Row) => undefined) };
  const businessDay = { today: jest.fn(async () => DAY), assign: jest.fn(async () => DAY) };
  const tenant = { companyId: () => COMPANY, requireBranchId: () => BRANCH, requireUserId: () => USER };
  const svc = new AgentPositionsService(db as never, tenant as never, audit as never, businessDay as never, closing as never);
  return { svc, db, audit, businessDay, closing, positions, movements };
}

const refusal = async (p: Promise<unknown>) => {
  const e = await p.catch((err: unknown) => err);
  return { error: e, body: (e as { getResponse?: () => unknown }).getResponse?.() as Record<string, unknown> | undefined };
};

describe('GET agent/positions — the money of the branch', () => {
  it('the drawer is the closing’s own method, untouched; a float is its anchor plus the legs after it; the day beside each', async () => {
    const h = harness({
      positions: [anchorRow(BANKILY, 50_000, t('08:00'))],
      movements: [leg(BANKILY, 'outflow', 20_000, t('09:00')), leg(BANKILY, 'inflow', 200, t('09:00')), leg(BANKILY, 'inflow', 999, t('07:00')), leg(SEDAD, 'inflow', 15_150, t('10:00'))],
    });
    const view = await h.svc.view();
    expect(h.closing.drawerMethod).toHaveBeenCalledTimes(1);
    expect(view.cash).toEqual({ known: true, position: 10_000, unknownReason: null, movement: { businessDate: DAY, inflows: 0, outflows: 0, net: 0 }, anchor: { source: 'opening', amount: 10_000 } });
    expect(view.floats).toEqual([
      {
        providerId: BANKILY,
        providerLabel: 'Bankily',
        providerKind: 'bankily',
        accountKind: 'provider',
        known: true,
        position: 30_200,
        unknownReason: null,
        anchor: { amount: 50_000, at: '2026-10-08T08:00:00.000Z', businessDate: DAY, byName: 'Owner', source: 'set' },
        sinceAnchorNet: -19_800,
        movement: { businessDate: DAY, inflows: 1_199, outflows: 20_000, net: -18_801 },
      },
      {
        providerId: SEDAD,
        providerLabel: 'Sedad',
        providerKind: 'sedad',
        accountKind: 'provider',
        known: false,
        position: null,
        unknownReason: 'no_anchor',
        anchor: null,
        sinceAnchorNet: null,
        movement: { businessDate: DAY, inflows: 15_150, outflows: 0, net: 15_150 },
      },
    ]);
    expect(view.commissionHeld).toEqual([]);
    expect(view).toMatchObject({ businessDate: DAY, branchId: binToUuid(BRANCH), total: null, unknownKeys: [`provider:${SEDAD}`] });
  });

  it('every float known: the total is the drawer plus the floats; a drawer unknown makes it unknown', async () => {
    const known = harness({ positions: [anchorRow(BANKILY, 50_000, t('08:00')), anchorRow(SEDAD, 40_000, t('14:00'), { id: uuidToBin('01a0b1c2-0000-7000-8000-0000000000f3') })] });
    expect(await known.svc.view()).toMatchObject({ total: 100_000, unknownKeys: [] });
    const drawerUnknown = harness({
      positions: [anchorRow(BANKILY, 50_000, t('08:00')), anchorRow(SEDAD, 40_000, t('14:00'), { id: uuidToBin('01a0b1c2-0000-7000-8000-0000000000f3') })],
      cash: { known: false, position: null, unknownReason: 'no_counted_close', anchor: null, sinceAnchorNet: null, movement: { businessDate: DAY, inflows: 0, outflows: 0, net: 0 } },
    });
    expect(await drawerUnknown.svc.view()).toMatchObject({ total: null, unknownKeys: ['cash'] });
  });

  it('an inactive provider is listed only with a position or a movement; a held commission only when configured or ever held', async () => {
    const old = provider(OLD, 'Old wallet', { kind: 'other', isActive: false, sortOrder: 9 });
    const silent = harness({ providers: [provider(BANKILY, 'Bankily'), old] });
    expect((await silent.svc.view()).floats.map((f) => f.providerLabel)).toEqual(['Bankily']);
    const moved = harness({ providers: [provider(BANKILY, 'Bankily'), old], movements: [leg(OLD, 'inflow', 5, t('09:00'))] });
    expect((await moved.svc.view()).floats.map((f) => f.providerLabel)).toEqual(['Bankily', 'Old wallet']);
    const held = harness({
      providers: [provider(BANKILY, 'Bankily'), old],
      configs: { [BANKILY]: { commissionDestination: 'held_separately' } },
      movements: [leg(OLD, 'inflow', 7, t('09:00'), 'commission_held')],
    });
    const view = await held.svc.view();
    expect(view.commissionHeld.map((f) => [f.providerLabel, f.accountKind, f.known, f.movement.net])).toEqual([
      ['Bankily', 'commission_held', false, 0],
      ['Old wallet', 'commission_held', false, 7],
    ]);
    // Bankily's own float is listed (active) and unknown too: every listed float without an anchor is named, floats before held commissions.
    expect(view.unknownKeys).toEqual([`provider:${BANKILY}`, `commission_held:${BANKILY}`, `commission_held:${OLD}`]);
  });

  it('an electronics-only branch is refused by name, before any money is read', async () => {
    const h = harness({ activity: 'electronics' });
    const { error, body } = await refusal(h.svc.view());
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(body).toMatchObject({ code: 'activity_not_subscribed', activity: 'electronics', required: 'money_agent' });
    expect(h.closing.drawerMethod).not.toHaveBeenCalled();
  });
});

describe('POST agent/positions — the Owner sets what a float holds', () => {
  it('locks the provider, records the amount on the server’s clock with what was tracked and the difference, audits, and answers with the float', async () => {
    const h = harness({ positions: [anchorRow(BANKILY, 50_000, t('08:00'))], movements: [leg(BANKILY, 'outflow', 20_000, t('09:00')), leg(BANKILY, 'inflow', 200, t('09:00'))] });
    const before = Date.now();
    const result = await h.svc.set({ clientUuid: KEY, providerId: BANKILY, amount: 30_100, note: ' app ' });
    expect(h.db.$queryRaw.mock.calls[0][0].sql).toMatch(/FROM agent_providers WHERE id = \? AND company_id = \? FOR UPDATE/);
    const data = h.db.agentPosition.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      companyId: COMPANY,
      branchId: BRANCH,
      accountKind: 'provider',
      providerId: uuidToBin(BANKILY),
      amount: 30_100,
      businessDate: dateValue(DAY),
      source: 'set',
      trackedBefore: 30_200,
      difference: -100,
      note: 'app',
      recordedById: USER,
      recordedByName: 'Owner',
      clientUuid: uuidToBin(KEY),
      clientRequestHash: positionFingerprint({ providerId: BANKILY, accountKind: 'provider', amount: 30_100, note: 'app' }),
    });
    expect(data.at.getTime()).toBeGreaterThanOrEqual(before);
    expect(h.businessDay.assign).toHaveBeenCalledWith(BRANCH, data.at, h.db);
    expect(h.audit.recordTx).toHaveBeenCalledWith(h.db, expect.objectContaining({ entityType: 'AgentPosition', action: 'create', after: expect.objectContaining({ amount: 30_100, trackedBefore: 30_200, difference: -100, source: 'set' }), branchId: BRANCH }));
    expect(result.position).toMatchObject({ providerId: BANKILY, accountKind: 'provider', amount: 30_100, trackedBefore: 30_200, difference: -100, note: 'app', byName: 'Owner', source: 'set', businessDate: DAY });
    // From now on the float holds what was set: the earlier legs are inside it.
    expect(result.float).toMatchObject({ known: true, position: 30_100, sinceAnchorNet: 0, anchor: { amount: 30_100, source: 'set' } });
  });

  it('an unknown float records no tracked amount and no difference; a held commission can be set too', async () => {
    const h = harness();
    const result = await h.svc.set({ clientUuid: KEY, providerId: SEDAD, accountKind: 'commission_held', amount: 0 });
    expect(h.db.agentPosition.create.mock.calls[0][0].data).toMatchObject({ accountKind: 'commission_held', amount: 0, trackedBefore: null, difference: null });
    expect(result.float).toMatchObject({ accountKind: 'commission_held', known: true, position: 0 });
  });

  it('a retry with the same key and payload returns the same record and writes nothing; a different payload is refused', async () => {
    const hash = positionFingerprint({ providerId: BANKILY, accountKind: 'provider', amount: 1_000 });
    const h = harness({ positions: [anchorRow(BANKILY, 1_000, t('08:00'), { clientUuid: uuidToBin(KEY), clientRequestHash: hash })] });
    const result = await h.svc.set({ clientUuid: KEY, providerId: BANKILY.toUpperCase(), amount: 1_000 });
    expect(result.position.amount).toBe(1_000);
    expect(h.db.$transaction).not.toHaveBeenCalled();
    const { error, body } = await refusal(h.svc.set({ clientUuid: KEY, providerId: BANKILY, amount: 1_200 }));
    expect(error).toBeInstanceOf(ConflictException);
    expect(body?.code).toBe('idempotency_conflict');
    expect(h.db.agentPosition.create).not.toHaveBeenCalled();
  });

  it('two identical retries racing: the loser answers with the winner’s record', async () => {
    const hash = positionFingerprint({ providerId: BANKILY, accountKind: 'provider', amount: 900 });
    let raced = false;
    const h = harness({
      race: () => {
        if (raced) return false;
        raced = true;
        h.positions.push(anchorRow(BANKILY, 900, t('11:00'), { id: uuidToBin('01a0b1c2-0000-7000-8000-0000000000f9'), clientUuid: uuidToBin(KEY), clientRequestHash: hash }));
        return true;
      },
    });
    const result = await h.svc.set({ clientUuid: KEY, providerId: BANKILY, amount: 900 });
    expect(result.position.id).toBe('01a0b1c2-0000-7000-8000-0000000000f9');
  });

  it('refused before anything is read or written: a negative amount or a third decimal, an electronics-only branch, an unknown provider', async () => {
    for (const amount of [-5, 10.005]) {
      const h = harness();
      const { error, body } = await refusal(h.svc.set({ clientUuid: KEY, providerId: BANKILY, amount }));
      expect(error).toBeInstanceOf(BadRequestException);
      expect(body?.code).toBe('amount_invalid');
      expect(h.db.agentPosition.findFirst).not.toHaveBeenCalled();
    }
    const electronics = harness({ activity: 'electronics' });
    const refused = await refusal(electronics.svc.set({ clientUuid: KEY, providerId: BANKILY, amount: 10 }));
    expect(refused.error).toBeInstanceOf(ForbiddenException);
    expect(refused.body?.code).toBe('activity_not_subscribed');
    expect(electronics.db.$transaction).not.toHaveBeenCalled();
    const unknown = harness();
    const missing = await refusal(unknown.svc.set({ clientUuid: KEY, providerId: '01a0b1c2-0000-7000-8000-0000000000ff', amount: 10 }));
    expect(missing.error).toBeInstanceOf(NotFoundException);
    expect(missing.body?.code).toBe('provider_not_found');
    expect(unknown.db.agentPosition.create).not.toHaveBeenCalled();
    expect(unknown.audit.recordTx).not.toHaveBeenCalled();
  });
});
