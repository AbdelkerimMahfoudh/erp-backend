import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { binToUuid, uuidToBin } from '../common/utils/uuid.util';
import { dateValue } from '../common/business-day/business-day.service';
import { ClosingService } from '../closing/closing.service';
import { AgentTransactionsService } from './agent-transactions.service';
import { exchangeFingerprint } from './agent-rules';
import { CreateAgentTransactionDto } from './dto/transaction.dto';

/**
 * The counter's exchanges (A5–A8, docs/73 §4), driven through the real service
 * over an in-memory ledger: what is asserted is exactly what would be written —
 * the transaction, its legs, its reversal — and, for a refusal, that nothing was.
 */

const COMPANY = Buffer.alloc(16, 1);
const BRANCH = Buffer.alloc(16, 2);
const USER = Buffer.alloc(16, 3);
const BANKILY = '01a0b1c2-0000-7000-8000-00000000000b';
const CONFIG = '01a0b1c2-0000-7000-8000-0000000000c1';
const KEY = '01a0b1c2-0000-7000-8000-0000000000aa';
const KEY2 = '01a0b1c2-0000-7000-8000-0000000000ab';
const DAY = '2026-10-08';

type Row = Record<string, any>;

const fixtureConfig = (over: Row = {}): Row => ({
  id: uuidToBin(CONFIG),
  providerId: uuidToBin(BANKILY),
  rateInBp: 100,
  rateOutBp: 100,
  sameRateBothDirections: true,
  commissionDestination: 'provider_float',
  principalFeeMode: 'separate',
  referenceRule: 'optional',
  effectiveFrom: new Date('2026-10-08T08:00:00Z'),
  recordedByName: 'Owner',
  reason: 'fixture rates (invented)',
  ...over,
});

interface Options {
  activity?: string;
  /** The version in force; null for none. */
  config?: Row | null;
  providerActive?: boolean;
  providerMissing?: boolean;
  closed?: boolean;
  closedInside?: boolean;
  permissions?: string[];
  race?: () => boolean;
}

function harness(opts: Options = {}) {
  const transactions: Row[] = [];
  const movements: Row[] = [];
  const mistakes: Row[] = [];
  const rebalancings: Row[] = [];
  let seq = 0;
  const next = () => new Date(Date.UTC(2026, 9, 8, 9, 0, 0, seq++));
  const config = opts.config === undefined ? fixtureConfig() : opts.config;
  const rowOf = (t: Row, select?: Row) => {
    const { customerNumber, ...masked } = t;
    return {
      ...(select?.customerNumber ? { ...masked, customerNumber } : masked),
      provider: { label: 'Bankily' },
      movements: movements.filter((m) => m.transactionId?.equals(t.id)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      mistakeReports: mistakes.filter((m) => m.transactionId.equals(t.id)),
    };
  };
  const mistakeOf = (m: Row) => ({ ...m });
  const rebalancingOf = (r: Row) => ({ ...r, legs: movements.filter((m) => m.rebalancingId?.equals(r.id)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()) });
  const db = {
    branch: { findFirst: jest.fn(async () => ({ activity: opts.activity ?? 'money_agent' })) },
    user: { findFirst: jest.fn(async () => ({ name: 'Aicha' })) },
    agentProviderConfig: { findFirst: jest.fn(async () => config) },
    agentProvider: { findMany: jest.fn(async ({ where }: { where: { id: { in: Buffer[] } } }) => where.id.in.filter((b) => b.equals(uuidToBin(BANKILY))).map((id) => ({ id }))) },
    agentTransaction: {
      findFirst: jest.fn(async ({ where, select }: { where: Row; select?: Row }) => {
        const hit = where.clientUuid
          ? transactions.find((t) => t.clientUuid.equals(where.clientUuid))
          : transactions.find((t) => t.id.equals(where.id) && (!where.branchId || t.branchId.equals(where.branchId)));
        if (!hit) return null;
        return where.clientUuid ? { id: hit.id, clientRequestHash: hit.clientRequestHash } : rowOf(hit, select);
      }),
      findMany: jest.fn(async (args: Row) => transactions.map((t) => rowOf(t, args.select))),
      create: jest.fn(async ({ data }: { data: Row }) => {
        if (opts.race?.()) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
        transactions.push({ ...data, reversedAt: null, reversedByName: null, reversalReason: null, reversalClientUuid: null, createdAt: next() });
        return data;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const hit = transactions.find((t) => t.id.equals(where.id) && t.status === where.status);
        if (!hit) return { count: 0 };
        Object.assign(hit, data);
        return { count: 1 };
      }),
    },
    agentMovement: {
      createMany: jest.fn(async ({ data }: { data: Row[] }) => {
        for (const d of data) movements.push({ ...d, createdAt: next() });
        return { count: data.length };
      }),
      findMany: jest.fn(async ({ where }: { where: Row }) => movements.filter((m) => m.transactionId?.equals(where.transactionId) && (!where.kind || where.kind.in.includes(m.kind)))),
    },
    agentMistakeReport: {
      findFirst: jest.fn(async ({ where }: { where: Row }) => {
        const hit = where.clientUuid ? mistakes.find((m) => m.clientUuid.equals(where.clientUuid)) : mistakes.find((m) => m.id.equals(where.id) && m.branchId.equals(where.branchId));
        return hit ? mistakeOf(hit) : null;
      }),
      findFirstOrThrow: jest.fn(async ({ where }: { where: { id: Buffer } }) => mistakeOf(mistakes.find((m) => m.id.equals(where.id))!)),
      findMany: jest.fn(async ({ where }: { where: Row }) => mistakes.filter((m) => !where.status || m.status === where.status).map(mistakeOf)),
      create: jest.fn(async ({ data }: { data: Row }) => {
        mistakes.push({ decidedByName: null, decidedAt: null, decisionNote: null, ...data });
        return data;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const hits = mistakes.filter((m) => (where.id ? m.id.equals(where.id) : m.transactionId.equals(where.transactionId)) && m.status === where.status);
        for (const m of hits) Object.assign(m, data);
        return { count: hits.length };
      }),
    },
    agentRebalancing: {
      findFirst: jest.fn(async ({ where }: { where: Row }) => {
        const hit = rebalancings.find((r) => r.clientUuid.equals(where.clientUuid));
        return hit ? { id: hit.id, clientRequestHash: hit.clientRequestHash } : null;
      }),
      findFirstOrThrow: jest.fn(async ({ where }: { where: { id: Buffer } }) => rebalancingOf(rebalancings.find((r) => r.id.equals(where.id))!)),
      findMany: jest.fn(async () => rebalancings.map(rebalancingOf)),
      create: jest.fn(async ({ data }: { data: Row }) => {
        rebalancings.push({ ...data });
        return data;
      }),
    },
    $queryRaw: jest.fn(async (sql: Prisma.Sql) => {
      if (sql.sql.includes('FROM agent_providers')) {
        return opts.providerMissing ? [] : [{ id: uuidToBin(BANKILY), label: 'Bankily', is_active: opts.providerActive === false ? 0 : 1 }];
      }
      if (sql.sql.includes('FROM agent_transactions')) {
        const hit = transactions.find((t) => t.id.equals(sql.values[0] as Buffer));
        return hit ? [{ status: hit.status, reversal_client_uuid: hit.reversalClientUuid }] : [];
      }
      return [];
    }),
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(db)),
  };
  const closed = () => {
    throw new ConflictException({ code: 'store_closed', closedReason: 'closed', businessDate: DAY, message: 'closed' });
  };
  const closing = {
    assertCounterOpen: jest.fn(async () => (opts.closed ? closed() : undefined)),
    assertCounterOpenTx: jest.fn(async () => (opts.closedInside ? closed() : undefined)),
  };
  const audit = { record: jest.fn(async (_entry: Row) => undefined), recordTx: jest.fn(async (_tx: unknown, _entry: Row) => undefined) };
  const businessDay = { assign: jest.fn(async () => DAY), today: jest.fn(async () => DAY) };
  const tenant = { companyId: () => COMPANY, requireBranchId: () => BRANCH, requireUserId: () => USER };
  const cls = { get: (key: string) => (key === 'permissions' ? new Set(opts.permissions ?? []) : undefined) };
  const svc = new AgentTransactionsService(db as never, tenant as never, audit as never, businessDay as never, closing as never, cls as never);
  return { svc, db, audit, businessDay, closing, transactions, movements, mistakes, rebalancings };
}

const exchange = (over: Partial<CreateAgentTransactionDto> = {}): CreateAgentTransactionDto => ({
  clientUuid: KEY,
  providerId: BANKILY,
  direction: 'cash_in_credit_out',
  amount: 20_000,
  customerNumber: ' +222 36 12-34-56 ',
  ...over,
});

const refusal = async (p: Promise<unknown>) => {
  const e = await p.catch((err: unknown) => err);
  return { error: e, body: (e as { getResponse?: () => unknown }).getResponse?.() as Record<string, unknown> | undefined };
};

describe('recording an exchange', () => {
  it('writes the transaction with the session’s actor, the server’s day and the configuration snapshot, and its legs with it — in one transaction, under the day’s lock', async () => {
    const h = harness();
    const before = Date.now();
    const view = await h.svc.record(exchange({ providerReference: ' TX-77 ', deviceRecordedAt: '2026-10-08T08:59:00.000Z' }));

    const data = h.db.agentTransaction.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      companyId: COMPANY,
      branchId: BRANCH,
      providerId: uuidToBin(BANKILY),
      direction: 'cash_in_credit_out',
      amount: 20_000,
      customerNumber: '+22236123456',
      customerNumberLast4: '3456',
      providerReference: 'TX-77',
      commissionAmount: 200,
      commissionRateBp: 100,
      configVersionId: uuidToBin(CONFIG),
      businessDate: dateValue(DAY),
      deviceRecordedAt: new Date('2026-10-08T08:59:00.000Z'),
      recordedById: USER,
      recordedByName: 'Aicha',
      clientUuid: uuidToBin(KEY),
      status: 'completed',
    });
    expect(data.recordedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(data.configSnapshot).toMatchObject({ id: CONFIG, rateInBp: 100, rateOutBp: 100, commissionDestination: 'provider_float', principalFeeMode: 'separate', referenceRule: 'optional', reason: 'fixture rates (invented)' });
    // The business day from the posting instant, inside the transaction; then the day's lock.
    expect(h.businessDay.assign).toHaveBeenCalledWith(BRANCH, data.recordedAt, h.db);
    expect(h.closing.assertCounterOpen).toHaveBeenCalledWith(BRANCH, 'agent_exchange');
    expect(h.closing.assertCounterOpenTx).toHaveBeenCalledWith(h.db, { branchId: BRANCH, businessDate: DAY, operation: 'agent_exchange' });
    // The legs, with the transaction: cash in A (the drawer's agentIn), the float out A, the float in C.
    const legs = h.db.agentMovement.createMany.mock.calls[0][0].data;
    expect(legs.map((l: Row) => [l.accountKind, l.providerId ? binToUuid(l.providerId) : null, l.direction, l.amount, l.kind])).toEqual([
      ['cash', null, 'inflow', 20_000, 'principal'],
      ['provider', BANKILY, 'outflow', 20_000, 'principal'],
      ['provider', BANKILY, 'inflow', 200, 'commission'],
    ]);
    expect(legs.every((l: Row) => l.companyId.equals(COMPANY) && l.branchId.equals(BRANCH) && l.transactionId.equals(data.id) && l.businessDate.getTime() === dateValue(DAY).getTime() && l.recordedAt === data.recordedAt)).toBe(true);
    expect(h.audit.recordTx).toHaveBeenCalledWith(h.db, expect.objectContaining({ entityType: 'AgentTransaction', entityId: data.id, action: 'create', branchId: BRANCH }));

    expect(view).toMatchObject({
      id: binToUuid(data.id),
      providerLabel: 'Bankily',
      direction: 'cash_in_credit_out',
      amount: 20_000,
      customerNumberMasked: '•••• 3456',
      providerReference: 'TX-77',
      commission: { amount: 200, rateBp: 100, destination: 'provider_float', principalFeeMode: 'separate', configVersionId: CONFIG },
      businessDate: DAY,
      recordedBy: { id: binToUuid(USER), name: 'Aicha' },
      status: 'completed',
      reversal: null,
      mistakes: [],
    });
    expect(view.legs).toHaveLength(3);
    // The number itself never leaves the counter's answer.
    expect(view).not.toHaveProperty('customerNumber');
  });

  it('the other direction, a deducted fee: cash out A, one netted float leg in A + C, no commission leg; the commission still recorded', async () => {
    const h = harness({ config: fixtureConfig({ principalFeeMode: 'deducted', rateInBp: 50, rateOutBp: 150 }) });
    await h.svc.record(exchange({ direction: 'cash_out_credit_in', amount: 10_000 }));
    expect(h.db.agentTransaction.create.mock.calls[0][0].data).toMatchObject({ commissionAmount: 150, commissionRateBp: 150 });
    expect(h.db.agentMovement.createMany.mock.calls[0][0].data.map((l: Row) => [l.accountKind, l.direction, l.amount, l.kind])).toEqual([
      ['cash', 'outflow', 10_000, 'principal'],
      ['provider', 'inflow', 10_150, 'principal'],
    ]);
  });

  describe('the refusals, in order, and nothing written', () => {
    it('the body first: a malformed customer number is refused before the branch, the day or the provider is looked at', async () => {
      const h = harness();
      const { error, body } = await refusal(h.svc.record(exchange({ customerNumber: 'MR13 0002' })));
      expect(error).toBeInstanceOf(BadRequestException);
      expect(body?.code).toBe('customer_number_invalid');
      expect(h.db.branch.findFirst).not.toHaveBeenCalled();
      expect(h.closing.assertCounterOpen).not.toHaveBeenCalled();
      expect(h.db.$transaction).not.toHaveBeenCalled();
    });

    it('then the activity: an electronics-only branch is refused by name, before the open-first rule', async () => {
      const h = harness({ activity: 'electronics' });
      const { error, body } = await refusal(h.svc.record(exchange()));
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(body).toMatchObject({ code: 'activity_not_subscribed', activity: 'electronics', required: 'money_agent' });
      expect(h.closing.assertCounterOpen).not.toHaveBeenCalled();
      expect(h.db.$transaction).not.toHaveBeenCalled();
    });

    it('then open first: a closed day refuses before the provider is read; a day closing meanwhile refuses under the lock and rolls back', async () => {
      const plain = harness({ closed: true });
      const refused = await refusal(plain.svc.record(exchange()));
      expect(refused.body?.code).toBe('store_closed');
      expect(plain.db.$transaction).not.toHaveBeenCalled();
      const inside = harness({ closedInside: true });
      const late = await refusal(inside.svc.record(exchange()));
      expect(late.body?.code).toBe('store_closed');
      expect(inside.db.agentTransaction.create).not.toHaveBeenCalled();
      expect(inside.db.agentMovement.createMany).not.toHaveBeenCalled();
    });

    it('the real refusal sentence: nothing was exchanged, with the day and why', async () => {
      const db = {
        dailyClosing: { findUnique: jest.fn(async () => ({ status: 'locked' })) },
        closingEvent: { findFirst: jest.fn(async () => ({ id: Buffer.alloc(16, 7) })) },
      };
      const businessDay = { today: jest.fn(async () => DAY) };
      const closing = new ClosingService(db as never, { companyId: () => COMPANY } as never, {} as never, {} as never, {} as never, businessDay as never, {} as never, {} as never, {} as never);
      const { error, body } = await refusal(closing.assertCounterOpen(BRANCH, 'agent_exchange'));
      expect(error).toBeInstanceOf(ConflictException);
      expect(body).toEqual({
        code: 'store_closed',
        closedReason: 'closed',
        businessDate: DAY,
        message: `The store is closed for business day ${DAY}. Nothing was exchanged: the Owner or a named delegate must open the store first.`,
      });
    });

    it('then the provider: unknown, switched off, not configured (the blanks named), or a stale version', async () => {
      const missing = await refusal(harness({ providerMissing: true }).svc.record(exchange()));
      expect(missing.error).toBeInstanceOf(NotFoundException);
      expect(missing.body?.code).toBe('provider_not_found');

      const off = harness({ providerActive: false });
      const inactive = await refusal(off.svc.record(exchange()));
      expect(inactive.error).toBeInstanceOf(BadRequestException);
      expect(inactive.body?.code).toBe('provider_inactive');
      expect(off.db.agentTransaction.create).not.toHaveBeenCalled();

      const blank = harness({ config: fixtureConfig({ rateInBp: null, rateOutBp: null, referenceRule: null }) });
      const notConfigured = await refusal(blank.svc.record(exchange()));
      expect(notConfigured.error).toBeInstanceOf(ConflictException);
      expect(notConfigured.body).toMatchObject({ code: 'provider_not_configured', missing: ['rateInBp', 'rateOutBp', 'referenceRule'] });
      const none = await refusal(harness({ config: null }).svc.record(exchange()));
      expect(none.body).toMatchObject({ code: 'provider_not_configured', missing: ['rateInBp', 'rateOutBp', 'commissionDestination', 'principalFeeMode', 'referenceRule'] });

      const stale = await refusal(harness().svc.record(exchange({ configVersionId: '01a0b1c2-0000-7000-8000-0000000000c0' })));
      expect(stale.error).toBeInstanceOf(ConflictException);
      expect(stale.body).toMatchObject({ code: 'stale_configuration', expectedConfigVersionId: '01a0b1c2-0000-7000-8000-0000000000c0', currentConfigVersionId: CONFIG });
      await expect(harness().svc.record(exchange({ configVersionId: CONFIG }))).resolves.toBeDefined();
    });

    it('the reference follows the provider’s rule: required, optional, or left aside', async () => {
      const required = harness({ config: fixtureConfig({ referenceRule: 'required' }) });
      const { error, body } = await refusal(required.svc.record(exchange()));
      expect(error).toBeInstanceOf(BadRequestException);
      expect(body?.code).toBe('reference_required');
      expect(required.db.agentTransaction.create).not.toHaveBeenCalled();
      await expect(required.svc.record(exchange({ providerReference: 'TX-1' }))).resolves.toMatchObject({ providerReference: 'TX-1' });
      const none = harness({ config: fixtureConfig({ referenceRule: 'none' }) });
      await expect(none.svc.record(exchange({ providerReference: 'ignored' }))).resolves.toMatchObject({ providerReference: null });
    });
  });

  describe('one key, one exchange (A10, D155)', () => {
    it('the same key with the same payload returns the same record and writes nothing — whatever the day has become since', async () => {
      const h = harness();
      const first = await h.svc.record(exchange());
      h.closing.assertCounterOpen.mockImplementation(async () => {
        throw new ConflictException({ code: 'store_closed' });
      });
      const again = await h.svc.record(exchange({ customerNumber: '+22236123456' }));
      expect(again.id).toBe(first.id);
      expect(h.db.agentTransaction.create).toHaveBeenCalledTimes(1);
      expect(h.db.agentMovement.createMany).toHaveBeenCalledTimes(1);
      expect(h.db.$transaction).toHaveBeenCalledTimes(1);
    });

    it('the same key with a changed payload is refused: idempotency_conflict, nothing written', async () => {
      const h = harness();
      await h.svc.record(exchange());
      for (const changed of [exchange({ amount: 20_001 }), exchange({ direction: 'cash_out_credit_in' }), exchange({ customerNumber: '36 12 34 57' })]) {
        const { error, body } = await refusal(h.svc.record(changed));
        expect(error).toBeInstanceOf(ConflictException);
        expect(body?.code).toBe('idempotency_conflict');
      }
      expect(h.db.agentTransaction.create).toHaveBeenCalledTimes(1);
    });

    it('two identical submissions racing: the loser is answered with its twin', async () => {
      let raced = false;
      const h = harness({
        race: () => {
          if (raced) return false;
          raced = true;
          h.transactions.push({
            id: uuidToBin('01a0b1c2-0000-7000-8000-0000000000e1'),
            branchId: BRANCH,
            providerId: uuidToBin(BANKILY),
            direction: 'cash_in_credit_out',
            amount: 20_000,
            customerNumber: '+22236123456',
            customerNumberLast4: '3456',
            providerReference: null,
            commissionAmount: 200,
            commissionRateBp: 100,
            configVersionId: uuidToBin(CONFIG),
            configSnapshot: {},
            businessDate: dateValue(DAY),
            recordedAt: new Date(),
            deviceRecordedAt: null,
            recordedById: USER,
            recordedByName: 'Aicha',
            clientUuid: uuidToBin(KEY),
            clientRequestHash: exchangeFingerprint({ providerId: BANKILY, direction: 'cash_in_credit_out', amount: 20_000, customerNumber: '+22236123456' }),
            status: 'completed',
            reversedAt: null,
            reversedByName: null,
            reversalReason: null,
            reversalClientUuid: null,
            createdAt: new Date(),
          });
          return true;
        },
      });
      const view = await h.svc.record(exchange());
      expect(view.id).toBe('01a0b1c2-0000-7000-8000-0000000000e1');
    });
  });

  it('a body naming the actor — employeeId, userId, recordedBy, recordedById — is refused by the global pipe, which forbids unknown properties', async () => {
    // The pipe as main.ts builds it: `transform` is what hands the handler a DTO instance rather than the raw body.
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } });
    const meta = { type: 'body' as const, metatype: CreateAgentTransactionDto };
    await expect(pipe.transform({ ...exchange(), customerNumber: '36123456' }, meta)).resolves.toBeInstanceOf(CreateAgentTransactionDto);
    for (const field of ['employeeId', 'userId', 'recordedBy', 'recordedById']) {
      const e = await pipe.transform({ ...exchange(), customerNumber: '36123456', [field]: binToUuid(USER) }, meta).catch((err: unknown) => err);
      expect(e).toBeInstanceOf(BadRequestException);
      expect(JSON.stringify((e as BadRequestException).getResponse())).toContain(`property ${field} should not exist`);
    }
    // The pipe the API boots with is that pipe.
    const main = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');
    expect(main).toMatch(/new ValidationPipe\(\{\s*whitelist: true,\s*forbidNonWhitelisted: true/);
  });
});

describe('reading exchanges', () => {
  it('the list is masked, newest first, every filter in SQL, paged on the key; the number is never selected', async () => {
    const h = harness();
    await h.svc.record(exchange());
    const page = await h.svc.list({ from: '2026-10-01', to: DAY, providerId: BANKILY, direction: 'cash_in_credit_out', recordedById: binToUuid(USER), last4: '3456', reference: 'TX-1', status: 'completed', cursor: KEY2, limit: 10 });
    const args = h.db.agentTransaction.findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      branchId: BRANCH,
      businessDate: { gte: dateValue('2026-10-01'), lte: dateValue(DAY) },
      providerId: uuidToBin(BANKILY),
      direction: 'cash_in_credit_out',
      recordedById: USER,
      customerNumberLast4: '3456',
      providerReference: 'TX-1',
      status: 'completed',
    });
    expect(args).toMatchObject({ cursor: { id: uuidToBin(KEY2) }, skip: 1, orderBy: { id: 'desc' }, take: 11 });
    expect(args.select).not.toHaveProperty('customerNumber');
    expect(page.rows[0]).toMatchObject({ customerNumberMasked: '•••• 3456' });
    expect(JSON.stringify(page)).not.toContain('22236123456');
    expect(page.nextCursor).toBeNull();
    await expect(h.svc.list({ from: '2026-10-09', to: DAY })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('the detail reveals the number only to agent.customer.reveal; a holder of agent.transaction.view alone sees it masked', async () => {
    const hidden = harness({ permissions: ['agent.transaction.view'] });
    const recorded = await hidden.svc.record(exchange());
    const masked = await hidden.svc.detail(recorded.id);
    expect(masked).not.toHaveProperty('customerNumber');
    expect(masked.customerNumberMasked).toBe('•••• 3456');
    const reveal = harness({ permissions: ['agent.transaction.view', 'agent.customer.reveal'] });
    const own = await reveal.svc.record(exchange());
    const full = await reveal.svc.detail(own.id);
    expect(full.customerNumber).toBe('+22236123456');
    expect(reveal.db.agentTransaction.findFirst.mock.calls.at(-1)![0].select).toMatchObject({ customerNumber: true });
    const { error } = await refusal(reveal.svc.detail('01a0b1c2-0000-7000-8000-0000000000ff'));
    expect(error).toBeInstanceOf(NotFoundException);
  });
});

describe('reversing an exchange (A7)', () => {
  it('counters every leg once on the day of the reversal, marks the row, closes its open report, audits — and keeps the original legs', async () => {
    const h = harness();
    const recorded = await h.svc.record(exchange());
    await h.svc.reportMistake(recorded.id, { clientUuid: KEY2, kind: 'wrong_direction', note: 'the customer gave cash' });
    const reversed = await h.svc.reverse(recorded.id, { clientUuid: '01a0b1c2-0000-7000-8000-0000000000ac', reason: 'wrong direction' });

    expect(h.db.$queryRaw.mock.calls.at(-1)![0].sql).toMatch(/FROM agent_transactions WHERE id = \? AND company_id = \? FOR UPDATE/);
    const counter = h.db.agentMovement.createMany.mock.calls[1][0].data;
    expect(counter.map((l: Row) => [l.accountKind, l.direction, l.amount, l.kind])).toEqual([
      ['cash', 'outflow', 20_000, 'reversal'],
      ['provider', 'inflow', 20_000, 'reversal'],
      ['provider', 'outflow', 200, 'reversal'],
    ]);
    expect(counter.every((l: Row) => l.transactionId.equals(uuidToBin(recorded.id)) && l.businessDate.getTime() === dateValue(DAY).getTime())).toBe(true);
    expect(h.db.agentTransaction.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: uuidToBin(recorded.id), status: 'completed' }, data: { status: 'reversed', reversedById: USER, reversedByName: 'Aicha', reversalReason: 'wrong direction' } });
    expect(h.db.agentMistakeReport.updateMany.mock.calls[0][0]).toMatchObject({ where: { transactionId: uuidToBin(recorded.id), status: 'open' }, data: { status: 'reversed', decidedById: USER } });
    expect(h.audit.recordTx.mock.calls.at(-1)![1]).toMatchObject({ entityType: 'AgentTransaction', action: 'status_change', reason: 'wrong direction', before: { status: 'completed' }, after: expect.objectContaining({ status: 'reversed' }) });

    expect(reversed.status).toBe('reversed');
    expect(reversed.reversal).toMatchObject({ byName: 'Aicha', reason: 'wrong direction' });
    expect(reversed.mistakes[0]).toMatchObject({ kind: 'wrong_direction', status: 'reversed' });
    // Six legs on the row: the three original ones untouched, and their three counter-legs.
    expect(reversed.legs.map((l) => l.kind)).toEqual(['principal', 'principal', 'commission', 'reversal', 'reversal', 'reversal']);
    expect(h.movements.filter((m) => m.kind !== 'reversal').map((m) => [m.direction, m.amount])).toEqual([['inflow', 20_000], ['outflow', 20_000], ['inflow', 200]]);
  });

  it('a second reversal is refused: already_reversed, no legs written; the same key again is a retry and answers the same', async () => {
    const h = harness();
    const recorded = await h.svc.record(exchange());
    const first = await h.svc.reverse(recorded.id, { clientUuid: KEY2, reason: 'wrong direction' });
    const { error, body } = await refusal(h.svc.reverse(recorded.id, { clientUuid: '01a0b1c2-0000-7000-8000-0000000000ad', reason: 'again' }));
    expect(error).toBeInstanceOf(ConflictException);
    expect(body?.code).toBe('already_reversed');
    expect(h.db.agentMovement.createMany).toHaveBeenCalledTimes(2);
    const retry = await h.svc.reverse(recorded.id, { clientUuid: KEY2, reason: 'wrong direction' });
    expect(retry.id).toBe(first.id);
    expect(h.db.agentMovement.createMany).toHaveBeenCalledTimes(2);
    expect(h.db.$transaction).toHaveBeenCalledTimes(2);
  });

  it('a reversal that loses the lock race is refused too, and an electronics-only branch cannot reverse', async () => {
    const h = harness();
    const recorded = await h.svc.record(exchange());
    h.db.$queryRaw.mockImplementationOnce(async () => [{ status: 'reversed', reversal_client_uuid: null }]);
    const { body } = await refusal(h.svc.reverse(recorded.id, { clientUuid: KEY2, reason: 'x' }));
    expect(body?.code).toBe('already_reversed');
    const electronics = harness({ activity: 'electronics' });
    const refused = await refusal(electronics.svc.reverse(recorded.id, { clientUuid: KEY2, reason: 'x' }));
    expect(refused.error).toBeInstanceOf(ForbiddenException);
  });
});

describe('mistake reports', () => {
  it('are recorded open under their key, listed by status, and dismissed once', async () => {
    const h = harness();
    const recorded = await h.svc.record(exchange());
    const { mistake } = await h.svc.reportMistake(recorded.id, { clientUuid: KEY2, kind: 'wrong_amount', note: ' it was 2 000 ' });
    expect(h.db.agentMistakeReport.create.mock.calls[0][0].data).toMatchObject({ companyId: COMPANY, branchId: BRANCH, transactionId: uuidToBin(recorded.id), kind: 'wrong_amount', note: 'it was 2 000', status: 'open', reportedById: USER, reportedByName: 'Aicha', clientUuid: uuidToBin(KEY2) });
    expect(mistake).toMatchObject({ transactionId: recorded.id, kind: 'wrong_amount', status: 'open', reportedByName: 'Aicha' });
    const again = await h.svc.reportMistake(recorded.id, { clientUuid: KEY2, kind: 'wrong_amount', note: 'it was 2 000' });
    expect(again.mistake.id).toBe(mistake.id);
    expect(h.db.agentMistakeReport.create).toHaveBeenCalledTimes(1);
    const { body } = await refusal(h.svc.reportMistake(recorded.id, { clientUuid: KEY2, kind: 'wrong_provider' }));
    expect(body?.code).toBe('idempotency_conflict');
    expect((await h.svc.listMistakes({ status: 'open' })).rows).toHaveLength(1);
    expect((await h.svc.listMistakes({ status: 'dismissed' })).rows).toHaveLength(0);
    const dismissed = await h.svc.dismissMistake(mistake.id, { note: 'checked the slip' });
    expect(dismissed.mistake).toMatchObject({ status: 'dismissed', decidedByName: 'Aicha', decisionNote: 'checked the slip' });
    const twice = await refusal(h.svc.dismissMistake(mistake.id, {}));
    expect(twice.body?.code).toBe('mistake_decided');
    expect((await h.svc.listMistakes({})).rows).toHaveLength(1);
  });

  it('cannot be reported on a reversed exchange, and an unknown one is not found', async () => {
    const h = harness();
    const recorded = await h.svc.record(exchange());
    await h.svc.reverse(recorded.id, { clientUuid: KEY2, reason: 'x' });
    const { body } = await refusal(h.svc.reportMistake(recorded.id, { clientUuid: '01a0b1c2-0000-7000-8000-0000000000ad', kind: 'other' }));
    expect(body?.code).toBe('already_reversed');
    const { error } = await refusal(h.svc.reportMistake('01a0b1c2-0000-7000-8000-0000000000ff', { clientUuid: '01a0b1c2-0000-7000-8000-0000000000ae', kind: 'other' }));
    expect(error).toBeInstanceOf(NotFoundException);
  });
});

describe('rebalancing (A8)', () => {
  it('writes the rebalancing and its legs, never a transaction: no count, no volume, no commission', async () => {
    const h = harness();
    const { rebalancing } = await h.svc.rebalance({ clientUuid: KEY, reason: 'Bought float', legs: [{ account: 'cash', direction: 'outflow', amount: 100_000 }, { account: 'provider', providerId: BANKILY, direction: 'inflow', amount: 100_000 }] });
    expect(h.db.agentRebalancing.create.mock.calls[0][0].data).toMatchObject({ companyId: COMPANY, branchId: BRANCH, reason: 'Bought float', externalCounterparty: null, externalAmount: null, businessDate: dateValue(DAY), recordedById: USER, recordedByName: 'Aicha' });
    const legs = h.db.agentMovement.createMany.mock.calls[0][0].data;
    expect(legs.map((l: Row) => [l.accountKind, l.direction, l.amount, l.kind, l.transactionId])).toEqual([
      ['cash', 'outflow', 100_000, 'rebalancing', null],
      ['provider', 'inflow', 100_000, 'rebalancing', null],
    ]);
    expect(legs.every((l: Row) => l.rebalancingId.equals(uuidToBin(rebalancing.id)))).toBe(true);
    expect(h.db.agentTransaction.create).not.toHaveBeenCalled();
    expect(rebalancing).toMatchObject({ reason: 'Bought float', externalCounterparty: null, externalAmount: null, businessDate: DAY, recordedBy: { name: 'Aicha' } });
    expect(rebalancing.legs).toHaveLength(2);
    expect(h.audit.recordTx).toHaveBeenCalledWith(h.db, expect.objectContaining({ entityType: 'AgentRebalancing', action: 'create' }));
    expect((await h.svc.listRebalancings({})).rows).toHaveLength(1);
  });

  it('an outside party for exactly the difference writes the external leg and the signed amount', async () => {
    const h = harness();
    const { rebalancing } = await h.svc.rebalance({ clientUuid: KEY, reason: 'Owner capital', legs: [{ account: 'cash', direction: 'inflow', amount: 50_000 }], externalCounterparty: 'owner_capital', externalAmount: 50_000 });
    expect(rebalancing).toMatchObject({ externalCounterparty: 'owner_capital', externalAmount: 50_000 });
    expect(rebalancing.legs.map((l) => [l.account, l.direction, l.amount])).toEqual([['cash', 'inflow', 50_000], ['external', 'outflow', 50_000]]);
  });

  it('refused, nothing written: legs that do not balance, an unknown provider, an electronics-only branch; the same key replays', async () => {
    const h = harness();
    const unbalanced = await refusal(h.svc.rebalance({ clientUuid: KEY, reason: 'x', legs: [{ account: 'cash', direction: 'outflow', amount: 100 }, { account: 'provider', providerId: BANKILY, direction: 'inflow', amount: 90 }] }));
    expect(unbalanced.error).toBeInstanceOf(BadRequestException);
    expect(unbalanced.body?.code).toBe('rebalancing_unbalanced');
    const unknown = await refusal(h.svc.rebalance({ clientUuid: KEY, reason: 'x', legs: [{ account: 'cash', direction: 'outflow', amount: 100 }, { account: 'provider', providerId: '01a0b1c2-0000-7000-8000-0000000000ff', direction: 'inflow', amount: 100 }] }));
    expect(unknown.error).toBeInstanceOf(NotFoundException);
    expect(h.db.agentRebalancing.create).not.toHaveBeenCalled();
    expect(h.db.agentMovement.createMany).not.toHaveBeenCalled();
    const electronics = harness({ activity: 'electronics' });
    const refused = await refusal(electronics.svc.rebalance({ clientUuid: KEY, reason: 'x', legs: [{ account: 'cash', direction: 'inflow', amount: 1 }], externalCounterparty: 'other', externalAmount: 1 }));
    expect(refused.error).toBeInstanceOf(ForbiddenException);
    const body = { clientUuid: KEY, reason: 'x', legs: [{ account: 'cash' as const, direction: 'outflow' as const, amount: 100 }, { account: 'provider' as const, providerId: BANKILY, direction: 'inflow' as const, amount: 100 }] };
    const first = await h.svc.rebalance(body);
    const again = await h.svc.rebalance(body);
    expect(again.rebalancing.id).toBe(first.rebalancing.id);
    expect(h.db.agentRebalancing.create).toHaveBeenCalledTimes(1);
  });
});
