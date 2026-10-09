import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { binToUuid, uuidToBin } from '../common/utils/uuid.util';
import { AgentProvidersService, configInForce } from './agent-providers.service';

/**
 * Providers and their versioned configuration (docs/73 §1.2, §4.1): the
 * blanks are named and gate the provider; a version is appended, never edited;
 * a deducted fee can only land on the float. The database is mocked, so what
 * is asserted is exactly what would be written.
 */

const COMPANY = Buffer.alloc(16, 1);
const BRANCH = Buffer.alloc(16, 2);
const USER = Buffer.alloc(16, 3);
const BANKILY = '01a0b1c2-0000-7000-8000-00000000000b';

type Row = Record<string, any>;

function harness(opts: { providers?: Row[]; configs?: Row[]; permissions?: string[] | null; resolved?: string[] } = {}) {
  const providers: Row[] = opts.providers ?? [{ id: uuidToBin(BANKILY), kind: 'bankily', label: 'Bankily', isActive: true, sortOrder: 1 }];
  const configs: Row[] = [...(opts.configs ?? [])];
  let seq = 0;
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
        if (providers.some((p) => p.label === data.label)) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
        providers.push({ isActive: true, ...data });
        return data;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: Buffer }; data: Row }) => {
        if (data.label && providers.some((p) => p.label === data.label && !p.id.equals(where.id))) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
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
    user: { findFirst: jest.fn(async () => ({ name: 'Owner' })) },
    $queryRaw: jest.fn(async (_sql: Prisma.Sql) => []),
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(db)),
  };
  const audit = { record: jest.fn(async (_entry: Row) => undefined), recordTx: jest.fn(async (_tx: unknown, _entry: Row) => undefined) };
  const held = opts.permissions === null ? undefined : new Set(opts.permissions ?? ['agent.transaction.view']);
  const cls = { get: (key: string) => (key === 'permissions' ? held : undefined) };
  const access = { getEffectivePermissions: jest.fn(async () => new Set(opts.resolved ?? [])) };
  const tenant = { companyId: () => COMPANY, branchId: () => BRANCH, requireBranchId: () => BRANCH, requireUserId: () => USER };
  const svc = new AgentProvidersService(db as never, tenant as never, audit as never, cls as never, access as never);
  return { svc, db, audit, access, providers, configs };
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
    const { error } = await refusal(harness({ permissions: ['sale.create', 'report.view'] }).svc.list());
    expect(error).toBeInstanceOf(ForbiddenException);
  });
});

describe('adding and changing a provider', () => {
  it('creates it for the company, audited, and answers with the provider as the list shows it', async () => {
    const h = harness({ providers: [] });
    const created = await h.svc.create({ kind: 'sedad', label: '  Sedad ' });
    expect(h.db.agentProvider.create.mock.calls[0][0].data).toMatchObject({ companyId: COMPANY, kind: 'sedad', label: 'Sedad', sortOrder: 0 });
    expect(created).toMatchObject({ kind: 'sedad', label: 'Sedad', isActive: true, readyForTransactions: false });
    expect(h.audit.record).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'AgentProvider', action: 'create' }));
  });

  it('a label already used is refused: provider_label_in_use', async () => {
    const h = harness();
    const { error, body } = await refusal(h.svc.create({ kind: 'other', label: 'Bankily' }));
    expect(error).toBeInstanceOf(ConflictException);
    expect(body?.code).toBe('provider_label_in_use');
  });

  it('switching a provider off is a status change; renaming is an update; an unknown provider is not found', async () => {
    const h = harness();
    const off = await h.svc.update(BANKILY, { isActive: false });
    expect(off.isActive).toBe(false);
    expect(h.audit.record.mock.calls[0][0]).toMatchObject({ action: 'status_change', before: { isActive: true }, after: { isActive: false } });
    const renamed = await h.svc.update(BANKILY, { label: 'Bankily (main)', sortOrder: 2 });
    expect(renamed).toMatchObject({ label: 'Bankily (main)', sortOrder: 2 });
    expect(h.audit.record.mock.calls[1][0]).toMatchObject({ action: 'update' });
    const { error } = await refusal(h.svc.update('01a0b1c2-0000-7000-8000-0000000000ff', { label: 'x' }));
    expect(error).toBeInstanceOf(NotFoundException);
  });
});

describe('a configuration version (the blanks, docs/73 §1.2)', () => {
  it('is appended in force from the server’s clock, under the provider’s lock, with the one rate copied to both directions', async () => {
    const h = harness();
    const before = Date.now();
    const result = await h.svc.addConfig(BANKILY, { rateInBp: 150, rateOutBp: 20, sameRateBothDirections: true, commissionDestination: 'cash', principalFeeMode: 'separate', referenceRule: 'required', reason: 'the October schedule' });
    expect(h.db.$queryRaw.mock.calls[0][0].sql).toMatch(/FROM agent_providers WHERE id = \? AND company_id = \?\s+FOR UPDATE/);
    const data = h.db.agentProviderConfig.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ companyId: COMPANY, providerId: uuidToBin(BANKILY), rateInBp: 150, rateOutBp: 150, sameRateBothDirections: true, commissionDestination: 'cash', principalFeeMode: 'separate', referenceRule: 'required', recordedById: USER, recordedByName: 'Owner', reason: 'the October schedule' });
    expect(data.effectiveFrom.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.config).toMatchObject({ id: binToUuid(data.id), rateInBp: 150, rateOutBp: 150, recordedByName: 'Owner', reason: 'the October schedule' });
    expect(result.provider).toMatchObject({ readyForTransactions: true, missing: [] });
    expect(h.audit.recordTx).toHaveBeenCalledWith(h.db, expect.objectContaining({ entityType: 'AgentProviderConfig', action: 'create', reason: 'the October schedule' }));
  });

  it('two rates stay two; a blank stays a blank and the provider is not ready', async () => {
    const h = harness();
    const result = await h.svc.addConfig(BANKILY, { rateInBp: 150, rateOutBp: 20, sameRateBothDirections: false, reason: 'two rates' });
    expect(h.db.agentProviderConfig.create.mock.calls[0][0].data).toMatchObject({ rateInBp: 150, rateOutBp: 20, commissionDestination: null, principalFeeMode: null, referenceRule: null });
    expect(result.provider).toMatchObject({ readyForTransactions: false, missing: ['commissionDestination', 'principalFeeMode', 'referenceRule'] });
  });

  it('a fee deducted from the principal anywhere but the float is refused by name, and nothing is written', async () => {
    for (const destination of ['cash', 'held_separately', null] as const) {
      const h = harness();
      const { error, body } = await refusal(h.svc.addConfig(BANKILY, { rateInBp: 100, sameRateBothDirections: true, commissionDestination: destination, principalFeeMode: 'deducted', referenceRule: 'none', reason: 'x' }));
      expect(error).toBeInstanceOf(BadRequestException);
      expect(body?.code).toBe('config_invalid');
      expect(h.db.agentProviderConfig.create).not.toHaveBeenCalled();
    }
    await expect(harness().svc.addConfig(BANKILY, { rateInBp: 100, sameRateBothDirections: true, commissionDestination: 'provider_float', principalFeeMode: 'deducted', referenceRule: 'none', reason: 'ok' })).resolves.toBeDefined();
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
