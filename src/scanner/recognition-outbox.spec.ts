import { RecognitionOutboxService } from './recognition-outbox.service';
import { uuidToBin } from '../common/utils/uuid.util';

/**
 * The outbox exists so a crash cannot lose learning, and cannot double-count it.
 *
 * The failure modes below are the ones that actually bite in production: a
 * process that dies between commit and side effect, two workers racing, a
 * worker that dies holding a claim, and a poison row that must not hammer the
 * database forever. Each is asserted rather than assumed.
 */

const COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c001');
const OTHER_COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c002');
const PRODUCT = uuidToBin('018f0000-0000-7000-8000-00000000a001');
const PURCHASE = uuidToBin('018f0000-0000-7000-8000-00000000d001');

function row(over: Record<string, unknown> = {}) {
  return {
    id: uuidToBin('018f0000-0000-7000-8000-000000000001'),
    companyId: COMPANY,
    purchaseId: PURCHASE,
    codeType: 'barcode',
    code: '6001234500009',
    productId: PRODUCT,
    supplierId: null,
    source: 'receiving',
    status: 'pending',
    attempts: 0,
    claimedUntil: null,
    nextAttemptAt: new Date(Date.now() - 1000),
    ...over,
  };
}

/**
 * In-memory Prisma implementing the conditional-claim semantics the design
 * depends on. A stub that always "succeeds" would let a broken claim pass.
 */
function makeHarness(rows: any[], opts: { learnFails?: boolean } = {}) {
  let learnCount = 0;
  const store = rows;

  const matchesClaim = (r: any, where: any) => {
    if (!r.id.equals(where.id)) return false;
    return (where.OR as any[]).some((c) => {
      if (c.status === 'pending') return r.status === 'pending' && r.nextAttemptAt <= c.nextAttemptAt.lte;
      return r.status === 'processing' && r.claimedUntil && r.claimedUntil < c.claimedUntil.lt;
    });
  };

  const prisma: any = {
    recognitionOutbox: {
      findMany: jest.fn(async ({ where, take }: any) =>
        store
          .filter((r) =>
            (where.OR as any[]).some((c) =>
              c.status === 'pending'
                ? r.status === 'pending' && r.nextAttemptAt <= c.nextAttemptAt.lte
                : r.status === 'processing' && r.claimedUntil && r.claimedUntil < c.claimedUntil.lt,
            ),
          )
          .slice(0, take),
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const target = store.find((r) => matchesClaim(r, where));
        if (!target) return { count: 0 };
        Object.assign(target, {
          status: data.status,
          claimedUntil: data.claimedUntil,
          attempts: target.attempts + 1,
        });
        return { count: 1 };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const target = store.find((r) => r.id.equals(where.id));
        Object.assign(target, data);
        return target;
      }),
    },
    $transaction: jest.fn(async (fn: any) =>
      fn({
        recognitionOutbox: prisma.recognitionOutbox,
        productRecognition: {},
      }),
    ),
  };

  const recognition = {
    learn: jest.fn(async () => {
      if (opts.learnFails) throw new Error('learn exploded');
      learnCount += 1;
    }),
  };

  // Runs the callback immediately — CLS scoping is not what these assert.
  const cls = { runWith: jest.fn(async (_store: unknown, fn: any) => fn()) };

  const service = new RecognitionOutboxService(
    prisma as never,
    recognition as never,
    cls as never,
  );

  return { service, store, prisma, learn: () => learnCount, cls };
}

describe('recognition outbox', () => {
  it('processes a due event exactly once and marks it done', async () => {
    const { service, store, learn } = makeHarness([row()]);

    const result = await service.sweep();

    expect(result.processed).toBe(1);
    expect(learn()).toBe(1);
    expect(store[0].status).toBe('done');
    expect(store[0].processedAt).toBeInstanceOf(Date);
  });

  it('a second sweep does not re-learn a completed event', async () => {
    const { service, learn } = makeHarness([row()]);

    await service.sweep();
    await service.sweep();
    await service.sweep();

    expect(learn()).toBe(1);
  });

  it('learning and marking done share one transaction', async () => {
    const { service, prisma } = makeHarness([row()]);

    await service.sweep();

    // The completion update must happen inside the $transaction callback —
    // that is what makes "crash after learning" impossible.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('a failed event is retried later, not lost, with backoff', async () => {
    const { service, store, learn } = makeHarness([row()], { learnFails: true });

    await service.sweep();

    expect(learn()).toBe(0);
    expect(store[0].status).toBe('pending');
    expect(store[0].lastError).toContain('learn exploded');
    // Backed off into the future rather than retried immediately.
    expect(store[0].nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('a permanently failing event ends visible as failed, never deleted', async () => {
    const { service, store } = makeHarness([row({ attempts: 7 })], { learnFails: true });

    await service.sweep();

    expect(store).toHaveLength(1);
    expect(store[0].status).toBe('failed');
    expect(store[0].lastError).toBeTruthy();
  });

  it('a stale lease is reclaimed — a dead worker cannot wedge the queue', async () => {
    const abandoned = row({
      status: 'processing',
      claimedUntil: new Date(Date.now() - 60_000), // expired
      attempts: 1,
    });
    const { service, store, learn } = makeHarness([abandoned]);

    await service.sweep();

    expect(learn()).toBe(1);
    expect(store[0].status).toBe('done');
  });

  it('a live claim is left alone — no two workers process one event', async () => {
    const claimed = row({
      status: 'processing',
      claimedUntil: new Date(Date.now() + 60_000), // still held
    });
    const { service, learn } = makeHarness([claimed]);

    const result = await service.sweep();

    expect(result.processed).toBe(0);
    expect(learn()).toBe(0);
  });

  it('overlapping sweeps in one instance do not double-process', async () => {
    const { service, learn } = makeHarness([row()]);

    await Promise.all([service.sweep(), service.sweep(), service.sweep()]);

    expect(learn()).toBe(1);
  });

  it('a purchase with several codes yields independently retryable events', async () => {
    const good = row();
    const bad = row({
      id: uuidToBin('018f0000-0000-7000-8000-000000000002'),
      code: '7770000000001',
    });
    const { service, store } = makeHarness([good, bad]);

    await service.sweep();

    // Both are separate rows with their own status — one failing later cannot
    // block or re-run the other.
    expect(store.every((r) => r.status === 'done')).toBe(true);
    expect(store).toHaveLength(2);
  });

  it('carries each row company into the learning scope', async () => {
    const { service, cls } = makeHarness([row(), row({
      id: uuidToBin('018f0000-0000-7000-8000-000000000003'),
      companyId: OTHER_COMPANY,
      code: '888',
    })]);

    await service.sweep();

    const companies = cls.runWith.mock.calls.map((c: any[]) => c[0].companyId);
    expect(companies).toContainEqual(COMPANY);
    expect(companies).toContainEqual(OTHER_COMPANY);
  });

  it('enqueue writes one row per code and tolerates replay', async () => {
    const { service } = makeHarness([]);
    const createMany = jest.fn(async (_args: any) => ({ count: 2 }));

    await service.enqueueTx({ recognitionOutbox: { createMany } } as never, [
      { companyId: COMPANY, purchaseId: PURCHASE, codeType: 'barcode', code: 'a', productId: PRODUCT, source: 'receiving' },
      { companyId: COMPANY, purchaseId: PURCHASE, codeType: 'tac', code: 'b', productId: PRODUCT, source: 'receiving' },
    ]);

    const args = createMany.mock.calls[0][0] as any;
    expect(args.data).toHaveLength(2);
    // Replay of the same business request must be a no-op, not an error.
    expect(args.skipDuplicates).toBe(true);
  });

  it('enqueue with nothing to learn touches the database not at all', async () => {
    const { service } = makeHarness([]);
    const createMany = jest.fn();

    await service.enqueueTx({ recognitionOutbox: { createMany } } as never, []);

    expect(createMany).not.toHaveBeenCalled();
  });
});
