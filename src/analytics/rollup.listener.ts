import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { SpineEventBus } from '../common/events/spine-event-bus';
import { ROLLUP_QUEUE, RollupQueue } from './rollup-queue';

/**
 * Kicks the rollup queue when a sale or a stock movement commits. The request
 * itself was written inside that transaction (0081, docs/52) — this only works it
 * sooner; if the process stops first, the start-up sweep works it instead. Runs
 * after commit, so a rollup problem never affects the sale.
 */
@Injectable()
export class RollupListener implements OnModuleInit {
  constructor(
    private readonly events: SpineEventBus,
    @Inject(ROLLUP_QUEUE) private readonly queue: RollupQueue,
  ) {}

  onModuleInit(): void {
    // The sale wrote its branch-day recompute and its branch refresh (stock + velocity).
    this.events.on('sale.recorded', () => void this.queue.processNow());

    /**
     * A transfer changes what BOTH branches hold, so both are refreshed — the
     * shipment or receipt wrote a branch request for each end.
     *
     * Nothing did this before: valuation was only ever recomputed by a sale, so
     * after a shipment the source branch went on reporting stock it no longer
     * had until something else happened to touch it. No daily recompute is
     * enqueued — a transfer moves goods between branches of one company and
     * sells nothing, so revenue, COGS and profit for the day are unchanged.
     */
    this.events.on('stock.moved', () => void this.queue.processNow());
  }
}
