import { Injectable, Logger } from '@nestjs/common';
import { RollupQueue, RollupJob, BranchRefreshJob } from './rollup-queue';
import { RollupService } from './rollup.service';

/**
 * Dev/default queue: runs the recompute inline (fire-and-forget) after the sale
 * has already committed. A rollup failure is logged and swallowed — it must
 * never surface to the sale caller or roll anything back.
 */
@Injectable()
export class InProcessRollupQueue implements RollupQueue {
  private readonly log = new Logger(InProcessRollupQueue.name);

  constructor(private readonly rollups: RollupService) {}

  enqueueDailyRecompute(job: RollupJob): void {
    void this.rollups
      .recomputeDaily(job.companyId, job.branchId, job.day)
      .catch((e) => this.log.error(`daily rollup recompute failed: ${e?.message ?? e}`, e?.stack));
  }

  enqueueBranchRefresh(job: BranchRefreshJob): void {
    void this.rollups
      .refreshBranch(job.companyId, job.branchId)
      .catch((e) => this.log.error(`branch refresh failed: ${e?.message ?? e}`, e?.stack));
  }
}
