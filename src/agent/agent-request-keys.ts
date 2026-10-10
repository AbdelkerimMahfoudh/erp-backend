import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { TenantPrisma } from '../prisma/tenant.extension';
import { newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';

/**
 * The Owner's provider settings, safe to retry (D160, docs/73 §11.3).
 *
 * A lost answer retried later created the provider a second time (refused as
 * a label clash, so the Owner never saw the provider it had made), audited a
 * change twice, or appended a second configuration version — and every phone
 * holding the first version's id then had its queued exchanges refused as
 * stale. These writes have no natural key of their own, so the request
 * carries one: `clientRequestId`, kept in `agent_request_keys` beside a
 * fingerprint of what was asked and the answer that was given.
 *
 * - The same key and the same request: the original answer, `replayed: true`,
 *   and nothing written.
 * - The same key with another request or operation: 409 `idempotency_conflict`.
 * - Two identical requests at once: the key row is inserted in the write's own
 *   transaction, so the loser's insert waits on the unique index, fails, rolls
 *   its whole write back, and answers with the winner's answer.
 */

/** The writes a request key covers. Float positions carry their own key on `agent_positions` (0089). */
export type RequestKeyOperation = 'provider_create' | 'provider_update' | 'provider_config';

/** What the client asked: the operation, the record it names (a create names none) and its body, key included. */
export interface KeyedRequest {
  operation: RequestKeyOperation;
  targetId: string | null;
  body: { clientRequestId: string };
}

/** Every answer says whether it was written now or replayed from the key. */
export type Answered<R> = R & { replayed: boolean };

type TenantTx = Parameters<Parameters<TenantPrisma['$transaction']>[0]>[0];
type KeyClient = Pick<TenantPrisma, 'agentRequestKey' | '$transaction'>;

/** JSON with every object's keys in order and undefined fields left out: the same request always reads the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sorted(value));
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sorted(v)]));
}

/** SHA-256 of the operation, the target and the body without its key: a retry under the same key reads the same. */
export function requestFingerprint(request: KeyedRequest): string {
  const { clientRequestId: _key, ...body } = request.body;
  const canonical = canonicalJson({ operation: request.operation, targetId: request.targetId?.toLowerCase() ?? null, body });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Run `write` once per key. The key is looked up first; a fresh request runs
 * `write` and records the key with its answer in the same transaction. A
 * unique violation — the key itself, or the row the write inserts (a provider's
 * label) — is looked up again: a request that lost a race answers with the
 * winner's answer; anything else is rethrown for the caller to name.
 */
export async function withRequestKey<R extends Record<string, unknown>>(
  db: KeyClient,
  request: KeyedRequest & { companyId: Buffer; userId: Buffer },
  write: (tx: TenantTx) => Promise<R>,
): Promise<Answered<R>> {
  const clientRequestId = uuidToBin(request.body.clientRequestId);
  const hash = requestFingerprint(request);
  const prior = await answerFor<R>(db, request, clientRequestId, hash);
  if (prior) return prior;
  try {
    const answer = await db.$transaction(async (tx) => {
      const written = await write(tx);
      await tx.agentRequestKey.create({
        data: {
          id: newUuidV7Bin(),
          companyId: request.companyId,
          clientRequestId,
          operation: request.operation,
          targetId: request.targetId ? uuidToBin(request.targetId) : null,
          requestHash: hash,
          response: written as unknown as Prisma.InputJsonValue,
          recordedById: request.userId,
        },
      });
      return written;
    });
    return { ...answer, replayed: false };
  } catch (e) {
    if (isUniqueViolation(e)) {
      const winner = await answerFor<R>(db, request, clientRequestId, hash);
      if (winner) return winner;
    }
    throw e;
  }
}

/** The answer a key already gave, replayed; another request under the same key is refused. */
async function answerFor<R>(db: KeyClient, request: KeyedRequest & { companyId: Buffer }, clientRequestId: Buffer, hash: string): Promise<Answered<R> | null> {
  const prior = await db.agentRequestKey.findFirst({
    where: { companyId: request.companyId, clientRequestId },
    select: { operation: true, requestHash: true, response: true },
  });
  if (!prior) return null;
  if (prior.operation !== request.operation || prior.requestHash !== hash) {
    throw new ConflictException({
      code: 'idempotency_conflict',
      message: 'That request id was already used for a different change. Refresh, then make the change again.',
    });
  }
  return { ...(prior.response as R), replayed: true };
}

export function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}
