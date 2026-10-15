import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CLOCK, type Clock } from '../../entitlement/clock';
import { TrialEndRoll, type TrialEndOutcome } from './trial-end-roll';

/**
 * The free trial's end, for businesses nobody is looking at (D176) — mandatory, not a convenience.
 *
 * The lazy path runs when the business is evaluated, but the people a seat was paid for during the trial cannot
 * trigger anything: sign-in refuses an account that is not active yet, and their activation is asked for only by the
 * Super Admin's confirmation and a verification. Without a sweeper, an unvisited business would get the store and
 * the seat it paid for whenever somebody next happened to look — a month late, if nobody did.
 *
 * The rollup outbox's pattern (rollup-outbox.service.ts): a pass at start-up, then one a minute on an unref'd timer,
 * one pass at a time per process. Each pass finds the companies with a scheduled request whose start has come, and
 * the claims whose end is not recorded yet — at most 200 — and runs `applyIfDue` for each, one at a time. Every
 * activation is NOWAIT and guarded row by row, so a pass beside the lazy path, an administrator's action or another
 * instance does each thing once; a company still waiting for paid access (PQ1) is simply asked again a minute later.
 */

const SWEEP_INTERVAL_MS = 60_000;
/** Companies handled per pass; the rest wait for the next minute. */
const BATCH_SIZE = 200;

export interface TrialEndSweep {
  companies: number;
  outcomes: Record<TrialEndOutcome, number>;
}

@Injectable()
export class TrialEndSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(TrialEndSweeper.name);
  private readonly trialEnd: TrialEndRoll;
  private timer: NodeJS.Timeout | null = null;
  /** The pass running in this process; a call during it joins it. */
  private running: Promise<TrialEndSweep | null> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.trialEnd = new TrialEndRoll(prisma, clock);
  }

  onApplicationBootstrap(): void {
    // What a stop left behind is caught up before the first minute passes.
    void this.sweepNow();
    this.timer = setInterval(() => void this.sweepNow(), SWEEP_INTERVAL_MS);
    // Do not hold the process open purely for the sweeper.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass at a time in this process. Never rejects: a failed pass is logged and the next minute tries again. */
  sweepNow(): Promise<TrialEndSweep | null> {
    if (!this.running) {
      this.running = this.sweep()
        .catch((e: unknown): null => {
          this.log.error(`free trial end sweep failed: ${(e as Error).message}`);
          return null;
        })
        .finally(() => {
          this.running = null;
        });
    }
    return this.running;
  }

  /** One pass: every company with something due, up to the batch, one at a time. */
  async sweep(): Promise<TrialEndSweep> {
    const now = this.clock.now();
    const [scheduled, unrecorded] = await Promise.all([
      this.prisma.$queryRaw<{ company_id: Buffer }[]>`
        SELECT DISTINCT company_id FROM seat_allocations WHERE status = 'scheduled' AND effective_at <= ${now} LIMIT 200
      `,
      this.prisma.$queryRaw<{ company_id: Buffer }[]>`
        SELECT company_id FROM trial_claims WHERE expiry_recorded_at IS NULL AND ends_at <= ${now} LIMIT 200
      `,
    ]);
    const companies = new Map<string, Buffer>();
    for (const r of [...scheduled, ...unrecorded]) {
      const id = Buffer.from(r.company_id);
      if (companies.size >= BATCH_SIZE) break;
      companies.set(id.toString('hex'), id);
    }
    const outcomes: Record<TrialEndOutcome, number> = { busy: 0, nothing_due: 0, done: 0, failed: 0 };
    for (const companyId of companies.values()) {
      outcomes[await this.trialEnd.applyIfDue(companyId)] += 1;
    }
    if (outcomes.failed > 0) {
      this.log.warn(`free trial end sweep: ${outcomes.failed} of ${companies.size} companies failed; retried next minute`);
    }
    if (outcomes.done > 0) this.log.log(`free trial end sweep: ${outcomes.done} companies brought up to date`);
    return { companies: companies.size, outcomes };
  }
}
