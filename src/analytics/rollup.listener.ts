import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { SpineEventBus } from '../common/events/spine-event-bus';
import { ROLLUP_QUEUE, RollupQueue } from './rollup-queue';

/**
 * Bridges the spine event bus to the rollup queue: when a sale commits,
 * enqueue a recompute of that branch-day's rollups. Runs after commit, so a
 * rollup problem never affects the sale.
 */
@Injectable()
export class RollupListener implements OnModuleInit {
  constructor(
    private readonly events: SpineEventBus,
    @Inject(ROLLUP_QUEUE) private readonly queue: RollupQueue,
  ) {}

  onModuleInit(): void {
    this.events.on('sale.recorded', (e) => {
      this.queue.enqueueDailyRecompute({ companyId: e.companyId, branchId: e.branchId, day: e.day });
      // A sale changes stock + velocity → refresh the branch snapshots too.
      this.queue.enqueueBranchRefresh({ companyId: e.companyId, branchId: e.branchId });
    });
  }
}
