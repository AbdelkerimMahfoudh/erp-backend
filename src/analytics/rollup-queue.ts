import { newUuidV7Bin } from '../common/utils/uuid.util';

/**
 * Durable requests to recompute derived figures (0081, docs/52).
 *
 * A change that moves a day's figures writes its request with `requestRollupTx`
 * INSIDE its own transaction, so the request commits with the change or not at
 * all. After commit the caller asks the queue to work it (`processNow`); if the
 * process stops first, or the recompute fails, the request stays in the table and
 * is worked at the next start-up or the next sweep.
 *
 * The recompute rebuilds a whole branch-day from its source records — it never
 * adds a sale to a total — so working the same request twice cannot count
 * anything twice.
 */

/** What asked for the recompute: every transaction type that changes derived figures. */
export type RollupCause =
  | 'sale'
  | 'expense_confirmed'
  | 'return_approved'
  | 'refund_confirmed'
  | 'correction_approved'
  | 'purchase_received'
  | 'transfer_shipped'
  | 'transfer_received';

/** `daily`: recompute one branch-day. `branch`: refresh the branch's stock snapshots (valuation + velocity). */
export type RollupRequest =
  | { kind: 'daily'; companyId: Buffer; branchId: Buffer; day: string; cause: RollupCause; sourceId?: Buffer | null }
  | { kind: 'branch'; companyId: Buffer; branchId: Buffer; cause: RollupCause; sourceId?: Buffer | null };

/** The Prisma surface `requestRollupTx` needs — the caller's transaction client. */
export interface RollupRequestTx {
  rollupRequest: { createMany(args: { data: unknown[] }): Promise<unknown> };
}

/**
 * Record, inside the caller's transaction, that derived figures must be recomputed.
 * Durable by construction: it commits with the change or not at all.
 */
export async function requestRollupTx(tx: RollupRequestTx, requests: RollupRequest[]): Promise<void> {
  if (requests.length === 0) return;
  const now = new Date();
  await tx.rollupRequest.createMany({
    data: requests.map((r) => ({
      id: newUuidV7Bin(),
      companyId: r.companyId,
      branchId: r.branchId,
      kind: r.kind,
      day: r.kind === 'daily' ? new Date(`${r.day}T00:00:00.000Z`) : null,
      cause: r.cause,
      sourceId: r.sourceId ?? null,
      requestedAt: now,
      nextAttemptAt: now,
    })),
  });
}

/** The worker's seam, injected where a change is committed. */
export interface RollupQueue {
  /**
   * Work the due requests now, after the caller's commit, and wait for a pass that
   * began after this call. Never throws: a recompute that fails stays pending and
   * is retried.
   */
  processNow(): Promise<void>;
}

export const ROLLUP_QUEUE = Symbol('ROLLUP_QUEUE');
