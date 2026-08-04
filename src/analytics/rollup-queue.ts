/** A branch-day recompute request. */
export interface RollupJob {
  companyId: Buffer;
  branchId: Buffer;
  day: string; // YYYY-MM-DD (branch-day bucket)
}

/** A branch-snapshot refresh request (inventory valuation + velocity). */
export interface BranchRefreshJob {
  companyId: Buffer;
  branchId: Buffer;
}

/**
 * Queue seam for rollup recomputes. `InProcessRollupQueue` runs them inline
 * after commit (no Redis; runs on WAMP today). A `BullRollupQueue` can enqueue
 * the identical job to BullMQ in production without changing any emitter — the
 * event listener and RollupService stay the same (P1).
 */
export interface RollupQueue {
  /** Fire-and-forget: recompute the day's rollups for a branch. Never throws. */
  enqueueDailyRecompute(job: RollupJob): void;
  /** Fire-and-forget: refresh a branch's inventory valuation + velocity. Never throws. */
  enqueueBranchRefresh(job: BranchRefreshJob): void;
}

export const ROLLUP_QUEUE = Symbol('ROLLUP_QUEUE');
