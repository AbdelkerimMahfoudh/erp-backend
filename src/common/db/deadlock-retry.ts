import { Prisma } from '@prisma/client';

/**
 * Retry a transaction that InnoDB rolled back for a lock conflict.
 *
 * ## Why this is necessary and not a workaround
 *
 * Two transactions inserting the SAME unique key at the same instant can
 * deadlock: each takes an insert-intention gap lock, then each waits for the
 * other's row lock to resolve the duplicate. MySQL detects the cycle, picks a
 * victim, and rolls **its whole transaction** back — so there is nothing left
 * to "carry on" from. Re-running the work is the only correct response, and
 * MySQL's own guidance is to always be prepared to reissue a transaction that
 * failed this way.
 *
 * This was found, not predicted. Making the quantity-cost average atomic
 * (H1.4.1) replaced a read-then-write `upsert` with
 * `INSERT … ON DUPLICATE KEY UPDATE`, which is correct but takes a different
 * lock profile — and two simultaneous purchases of the same product then lost
 * one to a deadlock. The live race suite caught it; the unit tests could not,
 * because a deadlock is a property of two real transactions meeting.
 *
 * ## What it is NOT
 *
 * It is not a substitute for doing the arithmetic in SQL, and it is not a
 * delay-and-hope. The average is still computed inside a single statement
 * against committed values; this only re-runs work the database itself threw
 * away. A retry is safe precisely because the rollback was total: no partial
 * write survives to be applied twice.
 *
 * Callers that are idempotent by key (purchase, transfer receipt) stay
 * idempotent — a retry re-enters the same guarded path.
 */

/** InnoDB deadlock victim. */
const DEADLOCK = '1213';
/** Waited too long for a lock the other transaction still holds. */
const LOCK_TIMEOUT = '1205';

function isLockConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
  // P2034 is Prisma's own "transaction conflict or deadlock, please retry".
  if (e.code === 'P2034') return true;
  // A raw statement surfaces as P2010 carrying the MySQL error number.
  const detail = `${e.code} ${JSON.stringify(e.meta ?? {})} ${e.message}`;
  return detail.includes(DEADLOCK) || detail.includes(LOCK_TIMEOUT);
}

/**
 * Run `work`, retrying only on a lock conflict.
 *
 * Anything else — a validation failure, a conflict the domain raised, a
 * genuine constraint violation — is rethrown immediately and untouched. A
 * retry loop that swallowed those would turn a clear refusal into a slow one.
 *
 * Three attempts with a short jittered backoff: a deadlock is resolved the
 * moment the victim rolls back, so the second attempt almost always succeeds.
 * The jitter stops two transactions retrying in lockstep and colliding again.
 */
export async function withLockRetry<T>(
  work: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 15;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (e) {
      if (attempt >= attempts || !isLockConflict(e)) throw e;
      const delay = base * attempt + Math.floor(Math.random() * base);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** Exposed for tests: is this the kind of failure worth retrying? */
export const isRetryableLockConflict = isLockConflict;
