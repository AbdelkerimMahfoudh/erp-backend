import { newUuidV7Bin } from '../common/utils/uuid.util';
import { requestRollupTx, type RollupRequest } from './rollup-queue';
import { backoffMs, describe as describeError, groupByScope, RollupOutboxService } from './rollup-outbox.service';
import type { RollupService } from './rollup.service';

/**
 * The durable recompute requests (0081, docs/52), against an in-memory request table
 * and a rollup that — like the real one — is REBUILT from its source records on every
 * recompute. Each guarantee is exercised the way it can break:
 *
 *   a stop between the commit and the recompute   → the request is still there at start-up
 *   a recompute that fails                          → the request waits and is retried, never lost
 *   a pass that dies mid-recompute                  → its lease expires and the rows are taken again
 *   a request committed during a recompute           → it is not swallowed by that recompute
 *   the same request worked twice                    → the sale is counted once
 */

const COMPANY = Buffer.alloc(16, 1);
const MAIN = Buffer.alloc(16, 2);
const OTHER = Buffer.alloc(16, 3);

type Row = Record<string, unknown> & { id: Buffer };

/** The request table, with the three query shapes the worker uses. */
function makeTable() {
  const rows: Row[] = [];
  const due = (r: Row, or: Array<Record<string, any>>) =>
    or.some((c) =>
      c.status === 'pending'
        ? r.status === 'pending' && (r.nextAttemptAt as Date) <= c.nextAttemptAt.lte
        : r.status === 'processing' && r.claimedUntil !== null && (r.claimedUntil as Date) < c.claimedUntil.lt,
    );
  const matches = (r: Row, where: Record<string, any>) => {
    if (where.id?.in && !where.id.in.some((id: Buffer) => id.equals(r.id))) return false;
    if (where.OR && !due(r, where.OR)) return false;
    if (where.claimToken && !(r.claimToken as Buffer | null)?.equals(where.claimToken)) return false;
    if (where.status && r.status !== where.status) return false;
    return true;
  };
  const rollupRequest = {
    createMany: async ({ data }: { data: Row[] }) => {
      for (const d of data) rows.push({ status: 'pending', attempts: 0, lastError: null, claimToken: null, claimedUntil: null, processedAt: null, ...d });
      return { count: data.length };
    },
    findMany: async ({ where, take }: { where: Record<string, any>; take: number }) =>
      rows
        .filter((r) => matches(r, where))
        .sort((a, b) => (a.requestedAt as Date).getTime() - (b.requestedAt as Date).getTime())
        .slice(0, take)
        .map((r) => ({ ...r })),
    updateMany: async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const r of hit) {
        for (const [k, v] of Object.entries(data)) r[k] = v && typeof v === 'object' && 'increment' in v ? Number(r[k]) + v.increment : v;
      }
      return { count: hit.length };
    },
  };
  return { rows, rollupRequest };
}

/** The real rollup's shape: every recompute REBUILDS the day from the ledger; it never adds. */
function makeRollups() {
  const sales: { branch: Buffer; day: string; amount: number }[] = [];
  const rollup = new Map<string, number>();
  const calls: string[] = [];
  let failures = 0;
  let during: (() => Promise<void>) | null = null;
  const service = {
    recomputeDaily: async (_c: Buffer, branch: Buffer, day: string) => {
      calls.push(`daily ${branch.toString('hex').slice(0, 2)} ${day}`);
      if (failures > 0) {
        failures -= 1;
        throw new Error('database unavailable');
      }
      if (during) {
        const hook = during;
        during = null;
        await hook();
      }
      rollup.set(`${branch.toString('hex')}|${day}`, sales.filter((s) => s.branch.equals(branch) && s.day === day).reduce((n, s) => n + s.amount, 0));
    },
    refreshBranch: async (_c: Buffer, branch: Buffer) => void calls.push(`branch ${branch.toString('hex').slice(0, 2)}`),
  };
  return {
    sales,
    rollup,
    calls,
    service,
    failNext: (n: number) => void (failures = n),
    /** Runs inside the next recompute, before it reads the ledger — a commit landing mid-pass. */
    whileRecomputing: (fn: () => Promise<void>) => void (during = fn),
    figure: (branch: Buffer, day: string) => rollup.get(`${branch.toString('hex')}|${day}`),
  };
}

function setup() {
  const table = makeTable();
  const rollups = makeRollups();
  const outbox = new RollupOutboxService({ rollupRequest: table.rollupRequest } as never, rollups.service as unknown as RollupService);
  jest.spyOn((outbox as unknown as { log: { warn: () => void; error: () => void } }).log, 'warn').mockImplementation(() => undefined);
  jest.spyOn((outbox as unknown as { log: { warn: () => void; error: () => void } }).log, 'error').mockImplementation(() => undefined);
  /** A committed sale: its source record and, in the same "transaction", its requests. */
  const sell = async (branch: Buffer, day: string, amount: number) => {
    rollups.sales.push({ branch, day, amount });
    const reqs: RollupRequest[] = [
      { kind: 'daily', companyId: COMPANY, branchId: branch, day, cause: 'sale', sourceId: newUuidV7Bin() },
      { kind: 'branch', companyId: COMPANY, branchId: branch, cause: 'sale' },
    ];
    await requestRollupTx({ rollupRequest: table.rollupRequest }, reqs);
  };
  const status = () => table.rows.map((r) => r.status);
  return { table, rollups, outbox, sell, status };
}

afterEach(() => jest.useRealTimers());

describe('a committed change cannot lose its recompute', () => {
  it('the request is written with the change, and a stop before the recompute leaves it pending for the next start', async () => {
    const { rollups, outbox, sell, status } = setup();
    await sell(MAIN, '2026-11-09', 10_040);
    // The process stops here: nothing worked the request.
    expect(status()).toEqual(['pending', 'pending']);
    expect(rollups.figure(MAIN, '2026-11-09')).toBeUndefined();

    // The next start works what is pending.
    await outbox.processNow();
    expect(rollups.figure(MAIN, '2026-11-09')).toBe(10_040);
    expect(status()).toEqual(['done', 'done']);
  });

  it('many requests for one branch-day are worked by one recompute; other days and branches by their own', async () => {
    const { rollups, outbox, sell, table } = setup();
    await sell(MAIN, '2026-11-09', 100);
    await sell(MAIN, '2026-11-09', 200);
    await sell(MAIN, '2026-11-10', 300);
    await sell(OTHER, '2026-11-09', 400);
    await outbox.processNow();
    expect(rollups.calls.filter((c) => c.startsWith('daily')).sort()).toEqual(['daily 02 2026-11-09', 'daily 02 2026-11-10', 'daily 03 2026-11-09']);
    expect(rollups.calls.filter((c) => c.startsWith('branch')).sort()).toEqual(['branch 02', 'branch 03']);
    expect([rollups.figure(MAIN, '2026-11-09'), rollups.figure(MAIN, '2026-11-10'), rollups.figure(OTHER, '2026-11-09')]).toEqual([300, 300, 400]);
    expect(table.rows.every((r) => r.status === 'done' && r.processedAt instanceof Date)).toBe(true);
  });
});

describe('a recompute that fails is retried, never lost', () => {
  it('the rows wait with the error and a backoff; the caller is never failed; the retry after the backoff recovers the figure', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-09T09:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const { rollups, outbox, sell, table } = setup();
    await sell(MAIN, '2026-11-09', 10_040);
    rollups.failNext(1);
    await expect(outbox.processNow()).resolves.toBeUndefined();

    const daily = table.rows.find((r) => r.kind === 'daily')!;
    expect(daily).toMatchObject({ status: 'pending', attempts: 1, lastError: 'database unavailable', claimToken: expect.any(Buffer) });
    expect((daily.nextAttemptAt as Date).getTime()).toBe(Date.parse('2026-11-09T09:00:05Z'));
    expect(rollups.figure(MAIN, '2026-11-09')).toBeUndefined();

    // Before the backoff: not retried.
    await outbox.processNow();
    expect(rollups.calls.filter((c) => c.startsWith('daily'))).toHaveLength(1);

    jest.setSystemTime(new Date('2026-11-09T09:00:06Z'));
    await outbox.processNow();
    expect(rollups.figure(MAIN, '2026-11-09')).toBe(10_040);
    expect(daily).toMatchObject({ status: 'done', attempts: 2, lastError: null });
  });

  it('keeps retrying however long it fails — the backoff is capped at thirty minutes, the row is never abandoned', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-09T09:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const { rollups, outbox, sell, table } = setup();
    await sell(MAIN, '2026-11-09', 500);
    rollups.failNext(12);
    for (let i = 0; i < 12; i += 1) {
      await outbox.processNow();
      jest.setSystemTime(new Date(Date.now() + 31 * 60_000));
    }
    const daily = table.rows.find((r) => r.kind === 'daily')!;
    expect(daily).toMatchObject({ status: 'pending', attempts: 12 });
    expect(backoffMs(12)).toBe(30 * 60_000);
    await outbox.processNow();
    expect(daily.status).toBe('done');
    expect(rollups.figure(MAIN, '2026-11-09')).toBe(500);
  });

  it('a sweep that cannot even read the table never rejects: the caller\'s commit stands', async () => {
    const outbox = new RollupOutboxService(
      { rollupRequest: { findMany: async () => { throw new Error('connection lost'); } } } as never,
      makeRollups().service as unknown as RollupService,
    );
    jest.spyOn((outbox as unknown as { log: { error: () => void } }).log, 'error').mockImplementation(() => undefined);
    await expect(outbox.processNow()).resolves.toBeUndefined();
  });
});

describe('a pass that dies mid-recompute', () => {
  it('holds a lease, not a lock: while it runs nobody else takes the rows; once it expires they are taken and finished', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-09T09:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const { rollups, outbox, sell, table } = setup();
    await sell(MAIN, '2026-11-09', 7_000);
    // A previous process claimed the rows and died before recomputing.
    for (const r of table.rows) Object.assign(r, { status: 'processing', claimToken: newUuidV7Bin(), claimedUntil: new Date('2026-11-09T09:01:00Z'), attempts: 1 });

    await outbox.processNow();
    expect(rollups.calls).toEqual([]);

    jest.setSystemTime(new Date('2026-11-09T09:01:01Z'));
    await outbox.processNow();
    expect(rollups.figure(MAIN, '2026-11-09')).toBe(7_000);
    expect(table.rows.map((r) => [r.status, r.attempts])).toEqual([['done', 2], ['done', 2]]);
  });
});

describe('no lost update, no double count', () => {
  it('a sale committed while its day is being recomputed is not swallowed: its request stays and the next pass counts it', async () => {
    const { rollups, outbox, sell, table } = setup();
    await sell(MAIN, '2026-11-09', 100);
    rollups.whileRecomputing(async () => {
      await sell(MAIN, '2026-11-09', 50);
      // The committing caller asks for a pass while this one runs.
      void outbox.processNow();
    });
    await outbox.processNow();
    expect(rollups.figure(MAIN, '2026-11-09')).toBe(150);
    expect(table.rows.every((r) => r.status === 'done')).toBe(true);
    expect(rollups.calls.filter((c) => c.startsWith('daily'))).toHaveLength(2);
  });

  it('the same request worked twice — a stop after the recompute, before "done" — counts the sale once', async () => {
    const { rollups, outbox, sell, table } = setup();
    await sell(MAIN, '2026-11-09', 10_040);
    await outbox.processNow();
    expect(rollups.figure(MAIN, '2026-11-09')).toBe(10_040);

    // As if the process had stopped before writing "done": the rows are pending again.
    for (const r of table.rows) Object.assign(r, { status: 'pending', claimToken: null, claimedUntil: null });
    await outbox.processNow();
    await outbox.processNow();
    expect(rollups.figure(MAIN, '2026-11-09')).toBe(10_040);
  });

  it('a caller waits for a pass that began after its commit', async () => {
    const { rollups, outbox, sell } = setup();
    await sell(MAIN, '2026-11-09', 10);
    const first = outbox.processNow();
    await sell(MAIN, '2026-11-09', 20);
    await outbox.processNow();
    expect(rollups.figure(MAIN, '2026-11-09')).toBe(30);
    await first;
  });
});

describe('the request itself', () => {
  it('a daily request names its day, a branch request none — the table refuses the other shapes', async () => {
    const table = makeTable();
    await requestRollupTx({ rollupRequest: table.rollupRequest }, [
      { kind: 'daily', companyId: COMPANY, branchId: MAIN, day: '2026-11-09', cause: 'expense_confirmed' },
      { kind: 'branch', companyId: COMPANY, branchId: MAIN, cause: 'purchase_received' },
    ]);
    expect(table.rows.map((r) => [r.kind, (r.day as Date | null)?.toISOString() ?? null, r.cause, r.status])).toEqual([
      ['daily', '2026-11-09T00:00:00.000Z', 'expense_confirmed', 'pending'],
      ['branch', null, 'purchase_received', 'pending'],
    ]);
    expect(groupByScope(table.rows as never)).toHaveLength(2);
  });

  it('keeps the line of an error that says what went wrong, not the code frame before it', () => {
    const prisma = new Error(
      [
        '',
        'Invalid `this.prisma.dailyRollup.upsert()` invocation in',
        'rollup.service.ts:363:31',
        '',
        '  363   this.prisma.dailyRollup.upsert(',
        'Error occurred during query execution:',
        'ConnectorError(MysqlError { code: 1644, message: "simulated rollup failure" })',
      ].join('\n'),
    );
    expect(describeError(prisma)).toBe('ConnectorError(MysqlError { code: 1644, message: "simulated rollup failure" })');
    expect(describeError('plain')).toBe('plain');
  });

  it('writes nothing when nothing is asked', async () => {
    const createMany = jest.fn();
    await requestRollupTx({ rollupRequest: { createMany } }, []);
    expect(createMany).not.toHaveBeenCalled();
  });
});
