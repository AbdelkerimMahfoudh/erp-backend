import { Prisma } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import { isRetryableLockConflict, withLockRetry } from './deadlock-retry';

/**
 * Retrying a rolled-back transaction (H1.4.1).
 *
 * Found by running two purchases of one product at the same instant against
 * real MySQL: making the cost average atomic swapped a read-then-write `upsert`
 * for `INSERT … ON DUPLICATE KEY UPDATE`, which takes insert-intention gap
 * locks, and one of the two was chosen as a deadlock victim and lost entirely.
 *
 * What matters here is the DISCRIMINATION — that a lock conflict is retried and
 * nothing else is. A retry loop that swallowed domain refusals would turn a
 * clear "no" into a slow one, and could apply a real conflict twice.
 */

const raw = (message: string, meta: Record<string, unknown> = {}) =>
  new Prisma.PrismaClientKnownRequestError(message, { code: 'P2010', clientVersion: 'test', meta });

describe('what counts as worth retrying', () => {
  it('retries an InnoDB deadlock', () => {
    expect(
      isRetryableLockConflict(
        raw('Raw query failed. Code: `1213`. Message: `Deadlock found when trying to get lock`', { code: '1213' }),
      ),
    ).toBe(true);
  });

  it('retries a lock-wait timeout', () => {
    expect(
      isRetryableLockConflict(raw('Raw query failed. Code: `1205`. Message: `Lock wait timeout exceeded`', { code: '1205' })),
    ).toBe(true);
  });

  it('retries Prisma’s own transaction-conflict code', () => {
    expect(
      isRetryableLockConflict(
        new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: 'test' }),
      ),
    ).toBe(true);
  });

  /**
   * The important negatives. A duplicate key is an answer about the data, and a
   * domain conflict is an answer about the workflow — reissuing either would be
   * asking a question that has already been answered.
   */
  it('does NOT retry a unique-constraint violation', () => {
    expect(
      isRetryableLockConflict(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }),
      ),
    ).toBe(false);
  });

  it('does NOT retry a domain conflict or an ordinary error', () => {
    expect(isRetryableLockConflict(new ConflictException('already received'))).toBe(false);
    expect(isRetryableLockConflict(new Error('boom'))).toBe(false);
    expect(isRetryableLockConflict(null)).toBe(false);
  });
});

describe('the retry itself', () => {
  const deadlock = () => raw('Raw query failed. Code: `1213`.', { code: '1213' });

  it('returns the result without retrying when the work succeeds', async () => {
    let calls = 0;
    const result = await withLockRetry(async () => {
      calls += 1;
      return 'done';
    });
    expect(result).toBe('done');
    expect(calls).toBe(1);
  });

  it('re-runs the whole unit of work after a deadlock, and succeeds', async () => {
    let calls = 0;
    const result = await withLockRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw deadlock();
        return 'committed';
      },
      { baseDelayMs: 1 },
    );
    expect(result).toBe('committed');
    expect(calls).toBe(2);
  });

  it('gives up after the attempt limit rather than looping forever', async () => {
    let calls = 0;
    await expect(
      withLockRetry(
        async () => {
          calls += 1;
          throw deadlock();
        },
        { attempts: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow(/1213/);
    expect(calls).toBe(3);
  });

  it('rethrows anything else immediately, without a second attempt', async () => {
    let calls = 0;
    await expect(
      withLockRetry(async () => {
        calls += 1;
        throw new ConflictException('that stock was taken while you were selling');
      }),
    ).rejects.toThrow(ConflictException);
    expect(calls).toBe(1);
  });
});
