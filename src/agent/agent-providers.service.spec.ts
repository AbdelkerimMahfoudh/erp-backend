import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { binToUuid, uuidToBin } from '../common/utils/uuid.util';
import { AGENT_PERMISSIONS } from './agent-access';
import { AgentProvidersService, configInForce } from './agent-providers.service';
import { canonicalJson, requestFingerprint } from './agent-request-keys';

/**
 * Providers and their versioned configuration (docs/73 §1.2, §4.1): the
 * blanks are named and gate the provider; a version is appended, never edited;
 * a deducted fee can only land on the float; every write is made once per
 * request key (D160). The database is mocked, so what is asserted is exactly
 * what would be written — and, for a write that failed, that nothing was.
 */

const COMPANY = Buffer.alloc(16, 1);
const BRANCH = Buffer.alloc(16, 2);
const USER = Buffer.alloc(16, 3);
const BANKILY = '01a0b1c2-0000-7000-8000-00000000000b';
const SEDAD = '01a0b1c2-0000-7000-8000-00000000000c';

type Row = Record<string, any>;

const KEY1 = '01a0b1c2-0000-7000-8000-0000000000d1';
const KEY2 = '01a0b1c2-0000-7000-8000-0000000000d2';
const KEY3 = '01a0b1c2-0000-7000-8000-0000000000d3';

const unique = () => new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });

/**
 * An in-memory company: its providers, versions, request keys and audit rows.
 * A transaction runs alone, as the database's row locks and unique index make
 * it, and a failed one leaves nothing behind. `concurrent: n` holds every
 * transaction until n key lookups were made — n requests that all looked
 * before any of them wrote.
 */
function harness(opts: { providers?: Row[]; configs?: Row[]; permissions?: string[] | null; resolved?: string[]; concurrent?: number } = {}) {
  const providers: Row[] = opts.providers ?? [{ id: uuidToBin(BANKILY), kind: 'bankily', label: 'Bankily', isActive: true, sortOrder: 1 }];
  const configs: Row[] = [...(opts.configs ?? [])];
  const keys: Row[] = [];
  const audits: Row[] = [];
  let seq = 0;
  let lookups = 0;
  let open!: () => void;
  let queue: Promise<unknown> = new Promise<void>((resolve) => (open = resolve));
  if (!opts.concurrent) open();
  const snapshot = () => [providers, configs, keys, audits].map((rows) => rows.map((r) => ({ ...r })));
  const restore = (saved: Row[][]) => [providers, configs, keys, audits].forEach((rows, i) => rows.splice(0, rows.length, ...saved[i]));
  const db = {
    agentProvider: {
      findMany: jest.fn(async () => providers),
      // A row read is a detached snapshot, as a database answers it: a later update never rewrites what the service already holds.
      findFirst: jest.fn(async ({ where }: { where: { id: Buffer } }) => {
        const found = providers.find((p) => p.id.equals(where.id));
        return found ? { ...found } : null;
      }),
      findFirstOrThrow: jest.fn(async ({ where }: { where: { id: Buffer } }) => providers.find((p) => p.id.equals(where.id))!),
      create: jest.fn(async ({ data }: { data: Row }) => {
        if (providers.some((p) => p.label === data.label)) throw unique();
        providers.push({ isActive: true, ...data });
        return data;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: Buffer }; data: Row }) => {
        if (data.label && providers.some((p) => p.label === data.label && !p.id.equals(where.id))) throw unique();
        Object.assign(providers.find((p) => p.id.equals(where.id))!, data);
        return {};
      }),
    },
    agentProviderConfig: {
      findFirst: jest.fn(async ({ where }: { where: { providerId: Buffer; effectiveFrom: { lte: Date } } }) => {
        const [latest] = configs
          .filter((c) => c.providerId.equals(where.providerId) && c.effectiveFrom.getTime() <= where.effectiveFrom.lte.getTime())
          .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime() || b.createdAt.getTime() - a.createdAt.getTime());
        return latest ?? null;
      }),
      findFirstOrThrow: jest.fn(async ({ where }: { where: { id: Buffer } }) => configs.find((c) => c.id.equals(where.id))!),
      findMany: jest.fn(async ({ where }: { where: { providerId: Buffer } }) => configs.filter((c) => c.providerId.equals(where.providerId))),
      create: jest.fn(async ({ data }: { data: Row }) => {
        configs.push({ ...data, createdAt: new Date(Date.UTC(2026, 9, 8, 10, 0, seq++)) });
        return data;
      }),
    },
    agentRequestKey: {
      findFirst: jest.fn(async ({ where }: { where: { companyId: Buffer; clientRequestId: Buffer } }) => {
        lookups += 1;
        if (lookups >= (opts.concurrent ?? 0)) open();
        const hit = keys.find((k) => k.companyId.equals(where.companyId) && k.clientRequestId.equals(where.clientRequestId));
        return hit ? { operation: hit.operation, requestHash: hit.requestHash, response: hit.response } : null;
      }),
      // The unique index on (company, key); the answer is kept as the JSON column keeps it.
      create: jest.fn(async ({ data }: { data: Row }) => {
        if (keys.some((k) => k.companyId.equals(data.companyId) && k.clientRequestId.equals(data.clientRequestId))) throw unique();
        keys.push({ ...data, response: JSON.parse(JSON.stringify(data.response)) });
        return data;
      }),
    },
    user: { findFirst: jest.fn(async () => ({ name: 'Owner' })) },
    $queryRaw: jest.fn(async (_sql: Prisma.Sql) => []),
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      const run = queue.then(async () => {
        const saved = snapshot();
        try {
          return await fn(db);
        } catch (e) {
          restore(saved);
          throw e;
        }
      });
      queue = run.catch(() => undefined);
      return run;
    }),
  };
  const audit = {
    record: jest.fn(async (entry: Row) => void audits.push(entry)),
    recordTx: jest.fn(async (_tx: unknown, entry: Row) => void audits.push(entry)),
  };
  const held = opts.permissions === null ? undefined : new Set(opts.permissions ?? ['agent.transaction.view']);
  const cls = { get: (key: string) => (key === 'permissions' ? held : undefined) };
  const access = { getEffectivePermissions: jest.fn(async () => new Set(opts.resolved ?? [])) };
  const tenant = { companyId: () => COMPANY, branchId: () => BRANCH, requireBranchId: () => BRANCH, requireUserId: () => USER };
  const svc = new AgentProvidersService(db as never, tenant as never, audit as never, cls as never, access as never);
  return { svc, db, audit, access, providers, configs, keys, audits };
}

const fixtureVersion = (over: Row = {}): Row => ({
  id: uuidToBin('01a0b1c2-0000-7000-8000-0000000000c1'),
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
  createdAt: new Date('2026-10-08T08:00:00Z'),
  ...over,
});

const refusal = async (p: Promise<unknown>) => {
  const e = await p.catch((err: unknown) => err);
  return { error: e, body: (e as { getResponse?: () => unknown }).getResponse?.() as Record<string, unknown> | undefined };
};

describe('the provider list', () => {
  it('names each provider’s blanks: not ready until every required field of the version in force is filled', async () => {
    const h = harness();
    const { providers } = await h.svc.list();
    expect(providers).toEqual([
      {
        id: BANKILY,
        kind: 'bankily',
        label: 'Bankily',
        isActive: true,
        sortOrder: 1,
        config: null,
        readyForTransactions: false,
        missing: ['rateInBp', 'rateOutBp', 'commissionDestination', 'principalFeeMode', 'referenceRule'],
      },
    ]);
  });

  it('a complete version in force makes the provider ready; a later version with a blank takes it away again', async () => {
    const h = harness({ configs: [fixtureVersion()] });
    expect((await h.svc.list()).providers[0]).toMatchObject({ readyForTransactions: true, missing: [], config: { id: '01a0b1c2-0000-7000-8000-0000000000c1', rateInBp: 100, rateOutBp: 100, effectiveFrom: '2026-10-08T08:00:00.000Z' } });
    h.configs.push(fixtureVersion({ id: uuidToBin('01a0b1c2-0000-7000-8000-0000000000c2'), commissionDestination: null, effectiveFrom: new Date('2026-10-08T09:00:00Z'), createdAt: new Date('2026-10-08T09:00:00Z') }));
    expect((await h.svc.list()).providers[0]).toMatchObject({ readyForTransactions: false, missing: ['commissionDestination'] });
  });

  it('a version dated in the future is not in force yet: the current one still decides', async () => {
    const future = fixtureVersion({ id: uuidToBin('01a0b1c2-0000-7000-8000-0000000000c9'), rateInBp: 500, rateOutBp: 500, effectiveFrom: new Date('2099-01-01T00:00:00Z') });
    const h = harness({ configs: [fixtureVersion(), future] });
    expect((await configInForce(h.db as never, uuidToBin(BANKILY), new Date('2026-10-08T12:00:00Z')))?.rateInBp).toBe(100);
  });

  it('opens to any of the nine keys, resolving them for the branch when no guard did; nobody else reads it', async () => {
    for (const key of ['agent.transaction.record', 'agent.provider.manage', 'agent.report.view']) {
      await expect(harness({ permissions: [key] }).svc.list()).resolves.toBeDefined();
    }
    const resolved = harness({ permissions: null, resolved: ['agent.mistake.report'] });
    await expect(resolved.svc.list()).resolves.toBeDefined();
    expect(resolved.access.getEffectivePermissions).toHaveBeenCalledWith(USER, BRANCH);
    const { error, body } = await refusal(harness({ permissions: ['sale.create', 'report.view'] }).svc.list());
    expect(error).toBeInstanceOf(ForbiddenException);
    // The guard's refusal shape (D161): any one of the nine would do, and all nine are named.
    expect(body).toMatchObject({ code: 'permission_denied', missing: [...AGENT_PERMISSIONS] });
  });
});

describe('adding and changing a provider', () => {
  it('creates it for the company, audited in the same transaction, and answers with the provider as the list shows it', async () => {
    const h = harness({ providers: [] });
    const created = await h.svc.create({ clientRequestId: KEY1, kind: 'sedad', label: '  Sedad ' });
    expect(h.db.agentProvider.create.mock.calls[0][0].data).toMatchObject({ companyId: COMPANY, kind: 'sedad', label: 'Sedad', sortOrder: 0 });
    expect(created).toMatchObject({ kind: 'sedad', label: 'Sedad', isActive: true, readyForTransactions: false, replayed: false });
    // The audit row moved inside the write's transaction (D160): a write that rolls back leaves no audit behind.
    expect(h.audit.recordTx).toHaveBeenCalledWith(h.db, expect.objectContaining({ entityType: 'AgentProvider', action: 'create' }));
    expect(h.audit.record).not.toHaveBeenCalled();
    expect(h.keys).toHaveLength(1);
    expect(h.keys[0]).toMatchObject({ companyId: COMPANY, clientRequestId: uuidToBin(KEY1), operation: 'provider_create', targetId: null, recordedById: USER });
  });

  it('a label already used is refused: provider_label_in_use, and nothing is kept — no audit, no key', async () => {
    const h = harness();
    const { error, body } = await refusal(h.svc.create({ clientRequestId: KEY1, kind: 'other', label: 'Bankily' }));
    expect(error).toBeInstanceOf(ConflictException);
    expect(body?.code).toBe('provider_label_in_use');
    expect(h.providers).toHaveLength(1);
    expect(h.audits).toEqual([]);
    expect(h.keys).toEqual([]);
  });

  it('switching a provider off is a status change; renaming is an update; an unknown provider is not found', async () => {
    const h = harness();
    const off = await h.svc.update(BANKILY, { clientRequestId: KEY1, isActive: false });
    expect(off.isActive).toBe(false);
    expect(h.audit.recordTx.mock.calls[0][1]).toMatchObject({ action: 'status_change', before: { isActive: true }, after: { isActive: false } });
    const renamed = await h.svc.update(BANKILY, { clientRequestId: KEY2, label: 'Bankily (main)', sortOrder: 2 });
    expect(renamed).toMatchObject({ label: 'Bankily (main)', sortOrder: 2 });
    expect(h.audit.recordTx.mock.calls[1][1]).toMatchObject({ action: 'update' });
    const { error } = await refusal(h.svc.update('01a0b1c2-0000-7000-8000-0000000000ff', { clientRequestId: KEY3, label: 'x' }));
    expect(error).toBeInstanceOf(NotFoundException);
    // A refused change keeps no key: the same request sent again is decided again.
    expect(h.keys.map((k) => binToUuid(k.clientRequestId))).toEqual([KEY1, KEY2]);
  });

  it('a change is made under the provider’s lock, in one transaction with its audit and its key', async () => {
    const h = harness();
    await h.svc.update(BANKILY, { clientRequestId: KEY1, sortOrder: 4 });
    expect(h.db.$queryRaw.mock.calls[0][0].sql).toMatch(/FROM agent_providers WHERE id = \? AND company_id = \?\s+FOR UPDATE/);
    expect(h.db.$transaction).toHaveBeenCalledTimes(1);
    expect(h.keys[0]).toMatchObject({ operation: 'provider_update', targetId: uuidToBin(BANKILY) });
  });

  it('renaming onto another provider’s label is still provider_label_in_use', async () => {
    const h = harness({
      providers: [
        { id: uuidToBin(BANKILY), kind: 'bankily', label: 'Bankily', isActive: true, sortOrder: 1 },
        { id: uuidToBin(SEDAD), kind: 'sedad', label: 'Sedad', isActive: true, sortOrder: 2 },
      ],
    });
    const { error, body } = await refusal(h.svc.update(SEDAD, { clientRequestId: KEY1, label: 'Bankily' }));
    expect(error).toBeInstanceOf(ConflictException);
    expect(body?.code).toBe('provider_label_in_use');
    expect(h.audits).toEqual([]);
    expect(h.keys).toEqual([]);
  });
});

describe('a provider change is safe to retry (D160, docs/73 §11.3)', () => {
  it('create: the same key and body answer with the provider it made — one row, one audit', async () => {
    const h = harness({ providers: [] });
    const first = await h.svc.create({ clientRequestId: KEY1, kind: 'sedad', label: 'Sedad' });
    const again = await h.svc.create({ clientRequestId: KEY1, kind: 'sedad', label: 'Sedad' });
    expect(again).toEqual({ ...first, replayed: true });
    expect(h.providers).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
    expect(h.keys).toHaveLength(1);
    expect(h.db.agentProvider.create).toHaveBeenCalledTimes(1);
  });

  it('create: the same key with another body is idempotency_conflict, and nothing is written', async () => {
    const h = harness({ providers: [] });
    await h.svc.create({ clientRequestId: KEY1, kind: 'sedad', label: 'Sedad' });
    for (const other of [
      { clientRequestId: KEY1, kind: 'sedad' as const, label: 'Sedad 2' },
      { clientRequestId: KEY1, kind: 'other' as const, label: 'Sedad' },
      { clientRequestId: KEY1, kind: 'sedad' as const, label: 'Sedad', sortOrder: 3 },
    ]) {
      const { error, body } = await refusal(h.svc.create(other));
      expect(error).toBeInstanceOf(ConflictException);
      expect(body?.code).toBe('idempotency_conflict');
    }
    expect(h.providers).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
  });

  it('a key used for another operation is a conflict too, whatever the body', async () => {
    const h = harness();
    await h.svc.update(BANKILY, { clientRequestId: KEY1, sortOrder: 2 });
    const { body } = await refusal(h.svc.addConfig(BANKILY, { clientRequestId: KEY1, sameRateBothDirections: true, reason: 'x' }));
    expect(body?.code).toBe('idempotency_conflict');
    expect(h.configs).toEqual([]);
  });

  it('create: two identical requests at once — one provider, the other answered with it', async () => {
    // Both looked the key up before either wrote; the loser's insert meets the winner's label, rolls back, and replays.
    const h = harness({ providers: [], concurrent: 2 });
    const [a, b] = await Promise.all([
      h.svc.create({ clientRequestId: KEY1, kind: 'sedad', label: 'Sedad' }),
      h.svc.create({ clientRequestId: KEY1, kind: 'sedad', label: 'Sedad' }),
    ]);
    expect(h.providers).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
    expect(h.keys).toHaveLength(1);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(a.id).toBe(b.id);
    // The loser did try: its insert met the unique label, and the key was looked up again (two first lookups, one after).
    expect(h.db.agentProvider.create).toHaveBeenCalledTimes(2);
    expect(h.db.agentRequestKey.findFirst).toHaveBeenCalledTimes(3);
  });

  it('create: a label clash under a fresh key is still provider_label_in_use, not a replay', async () => {
    const h = harness({ providers: [] });
    await h.svc.create({ clientRequestId: KEY1, kind: 'sedad', label: 'Sedad' });
    const { body } = await refusal(h.svc.create({ clientRequestId: KEY2, kind: 'sedad', label: 'Sedad' }));
    expect(body?.code).toBe('provider_label_in_use');
    expect(h.keys).toHaveLength(1);
  });

  it('update: the same key and body change nothing again — one audit, the first answer', async () => {
    const h = harness();
    const first = await h.svc.update(BANKILY, { clientRequestId: KEY1, isActive: false });
    // Someone switches it back on in between; the retry still answers what the first request did, and undoes nothing.
    await h.svc.update(BANKILY, { clientRequestId: KEY2, isActive: true });
    const again = await h.svc.update(BANKILY, { clientRequestId: KEY1, isActive: false });
    expect(again).toEqual({ ...first, replayed: true });
    expect(h.providers[0].isActive).toBe(true);
    expect(h.audits).toHaveLength(2);
  });

  it('update: the same key on another provider or with another body is idempotency_conflict', async () => {
    const h = harness({
      providers: [
        { id: uuidToBin(BANKILY), kind: 'bankily', label: 'Bankily', isActive: true, sortOrder: 1 },
        { id: uuidToBin(SEDAD), kind: 'sedad', label: 'Sedad', isActive: true, sortOrder: 2 },
      ],
    });
    await h.svc.update(BANKILY, { clientRequestId: KEY1, isActive: false });
    for (const [id, dto] of [
      [SEDAD, { clientRequestId: KEY1, isActive: false }],
      [BANKILY, { clientRequestId: KEY1, isActive: true }],
    ] as const) {
      const { body } = await refusal(h.svc.update(id, dto));
      expect(body?.code).toBe('idempotency_conflict');
    }
    expect(h.providers[1].isActive).toBe(true);
    expect(h.audits).toHaveLength(1);
  });

  it('update: two identical requests at once — one change and one audit, the other replayed', async () => {
    const h = harness({ concurrent: 2 });
    const answers = await Promise.all([
      h.svc.update(BANKILY, { clientRequestId: KEY1, label: 'Bankily (main)' }),
      h.svc.update(BANKILY, { clientRequestId: KEY1, label: 'Bankily (main)' }),
    ]);
    expect(answers.map((a) => a.replayed).sort()).toEqual([false, true]);
    expect(h.audits).toHaveLength(1);
    expect(h.keys).toHaveLength(1);
    // The loser renamed and audited too, then its key insert failed and took both back with it.
    expect(h.db.agentProvider.update).toHaveBeenCalledTimes(2);
    expect(h.db.agentRequestKey.create).toHaveBeenCalledTimes(2);
  });

  it('config: the same key and body append one version — the retry answers with it, so phones holding its id stay current', async () => {
    const h = harness();
    const body = { clientRequestId: KEY1, rateInBp: 100, sameRateBothDirections: true, commissionDestination: 'cash' as const, principalFeeMode: 'separate' as const, referenceRule: 'optional' as const, reason: 'the October schedule' };
    const first = await h.svc.addConfig(BANKILY, body);
    const again = await h.svc.addConfig(BANKILY, { ...body });
    expect(again).toEqual({ ...first, replayed: true });
    expect(again.config.id).toBe(first.config.id);
    expect(h.configs).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
  });

  it('config: the same key with another rate, reason or blank is idempotency_conflict, and no version is appended', async () => {
    const h = harness();
    const body = { clientRequestId: KEY1, rateInBp: 100, sameRateBothDirections: true, reason: 'the October schedule' };
    await h.svc.addConfig(BANKILY, body);
    for (const changed of [{ ...body, rateInBp: 101 }, { ...body, reason: 'another' }, { ...body, referenceRule: 'none' as const }]) {
      const { error, body: answer } = await refusal(h.svc.addConfig(BANKILY, changed));
      expect(error).toBeInstanceOf(ConflictException);
      expect(answer?.code).toBe('idempotency_conflict');
    }
    expect(h.configs).toHaveLength(1);
  });

  it('config: two identical requests at once — one version and one audit; the loser waits on the lock, fails on the key, rolls back and replays', async () => {
    const h = harness({ concurrent: 2 });
    const body = { clientRequestId: KEY1, rateInBp: 100, sameRateBothDirections: true, reason: 'the October schedule' };
    const answers = await Promise.all([h.svc.addConfig(BANKILY, body), h.svc.addConfig(BANKILY, { ...body })]);
    expect(answers.map((a) => a.replayed).sort()).toEqual([false, true]);
    expect(answers[0].config.id).toBe(answers[1].config.id);
    // The loser did write its version and its audit before its key failed: both rolled back with it.
    expect(h.db.agentProviderConfig.create).toHaveBeenCalledTimes(2);
    expect(h.configs).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
  });

  it('config: a new key is a new version, even with the same figures — the key is the request, not the content', async () => {
    const h = harness();
    const body = { rateInBp: 100, sameRateBothDirections: true, reason: 'the October schedule' };
    await h.svc.addConfig(BANKILY, { clientRequestId: KEY1, ...body });
    await h.svc.addConfig(BANKILY, { clientRequestId: KEY2, ...body });
    expect(h.configs).toHaveLength(2);
  });
});

describe('the request fingerprint', () => {
  const base = { operation: 'provider_config' as const, targetId: BANKILY, body: { clientRequestId: KEY1, rateInBp: 100, reason: 'r' } };

  it('reads the same whatever the order of the fields, and without the key itself', () => {
    const reordered = { reason: 'r', rateInBp: 100, clientRequestId: KEY2 };
    expect(requestFingerprint(base)).toBe(requestFingerprint({ ...base, body: reordered }));
    expect(requestFingerprint(base)).toBe(requestFingerprint({ ...base, targetId: BANKILY.toUpperCase() }));
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, { f: 1, e: 0 }] } })).toBe('{"a":{"c":[2,{"e":0,"f":1}]},"b":1}');
  });

  it('binds the operation, the target and every field of the body', () => {
    const fp = requestFingerprint(base);
    expect(requestFingerprint({ ...base, operation: 'provider_update' })).not.toBe(fp);
    expect(requestFingerprint({ ...base, targetId: SEDAD })).not.toBe(fp);
    const otherRate = { ...base.body, rateInBp: 101 };
    const oneMoreField = { ...base.body, rateOutBp: null };
    expect(requestFingerprint({ ...base, body: otherRate })).not.toBe(fp);
    expect(requestFingerprint({ ...base, body: oneMoreField })).not.toBe(fp);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('a configuration version (the blanks, docs/73 §1.2)', () => {
  it('is appended in force from the server’s clock, under the provider’s lock, with the one rate copied to both directions', async () => {
    const h = harness();
    const before = Date.now();
    const result = await h.svc.addConfig(BANKILY, { clientRequestId: KEY1, rateInBp: 150, rateOutBp: 20, sameRateBothDirections: true, commissionDestination: 'cash', principalFeeMode: 'separate', referenceRule: 'required', reason: 'the October schedule' });
    expect(h.db.$queryRaw.mock.calls[0][0].sql).toMatch(/FROM agent_providers WHERE id = \? AND company_id = \?\s+FOR UPDATE/);
    const data = h.db.agentProviderConfig.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ companyId: COMPANY, providerId: uuidToBin(BANKILY), rateInBp: 150, rateOutBp: 150, sameRateBothDirections: true, commissionDestination: 'cash', principalFeeMode: 'separate', referenceRule: 'required', recordedById: USER, recordedByName: 'Owner', reason: 'the October schedule' });
    expect(data.effectiveFrom.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.config).toMatchObject({ id: binToUuid(data.id), rateInBp: 150, rateOutBp: 150, recordedByName: 'Owner', reason: 'the October schedule' });
    expect(result.provider).toMatchObject({ readyForTransactions: true, missing: [] });
    expect(result.replayed).toBe(false);
    expect(h.audit.recordTx).toHaveBeenCalledWith(h.db, expect.objectContaining({ entityType: 'AgentProviderConfig', action: 'create', reason: 'the October schedule' }));
    expect(h.keys[0]).toMatchObject({ operation: 'provider_config', targetId: uuidToBin(BANKILY) });
  });

  it('two rates stay two; a blank stays a blank and the provider is not ready', async () => {
    const h = harness();
    const result = await h.svc.addConfig(BANKILY, { clientRequestId: KEY1, rateInBp: 150, rateOutBp: 20, sameRateBothDirections: false, reason: 'two rates' });
    expect(h.db.agentProviderConfig.create.mock.calls[0][0].data).toMatchObject({ rateInBp: 150, rateOutBp: 20, commissionDestination: null, principalFeeMode: null, referenceRule: null });
    expect(result.provider).toMatchObject({ readyForTransactions: false, missing: ['commissionDestination', 'principalFeeMode', 'referenceRule'] });
  });

  it('a fee deducted from the principal anywhere but the float is refused by name, and nothing is written', async () => {
    for (const destination of ['cash', 'held_separately', null] as const) {
      const h = harness();
      const { error, body } = await refusal(h.svc.addConfig(BANKILY, { clientRequestId: KEY1, rateInBp: 100, sameRateBothDirections: true, commissionDestination: destination, principalFeeMode: 'deducted', referenceRule: 'none', reason: 'x' }));
      expect(error).toBeInstanceOf(BadRequestException);
      expect(body?.code).toBe('config_invalid');
      expect(h.db.agentProviderConfig.create).not.toHaveBeenCalled();
      expect(h.keys).toEqual([]);
    }
    await expect(harness().svc.addConfig(BANKILY, { clientRequestId: KEY1, rateInBp: 100, sameRateBothDirections: true, commissionDestination: 'provider_float', principalFeeMode: 'deducted', referenceRule: 'none', reason: 'ok' })).resolves.toBeDefined();
  });

  it('a blank reason is refused (reason_required) before anything is looked up or written', async () => {
    const h = harness();
    const { body } = await refusal(h.svc.addConfig(BANKILY, { clientRequestId: KEY1, sameRateBothDirections: true, reason: '   ' }));
    expect(body?.code).toBe('reason_required');
    expect(h.db.agentRequestKey.findFirst).not.toHaveBeenCalled();
    expect(h.configs).toEqual([]);
  });

  it('an unknown provider is not found, and keeps no key', async () => {
    const h = harness();
    const { error } = await refusal(h.svc.addConfig('01a0b1c2-0000-7000-8000-0000000000ff', { clientRequestId: KEY1, sameRateBothDirections: true, reason: 'x' }));
    expect(error).toBeInstanceOf(NotFoundException);
    expect(h.keys).toEqual([]);
    expect(h.configs).toEqual([]);
  });

  it('the history lists every version, newest first; an unknown provider is not found', async () => {
    const older = fixtureVersion({ effectiveFrom: new Date('2026-10-01T08:00:00Z') });
    const newer = fixtureVersion({ id: uuidToBin('01a0b1c2-0000-7000-8000-0000000000c2'), effectiveFrom: new Date('2026-10-08T08:00:00Z') });
    const h = harness({ configs: [older, newer] });
    const { configs } = await h.svc.listConfigs(BANKILY);
    expect(configs).toHaveLength(2);
    expect(h.db.agentProviderConfig.findMany.mock.calls[0][0]).toMatchObject({ orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }] });
    const { error } = await refusal(h.svc.listConfigs('01a0b1c2-0000-7000-8000-0000000000ff'));
    expect(error).toBeInstanceOf(NotFoundException);
  });
});
