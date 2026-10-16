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
 * one pass at a time per process. Each pass finds the companies with a scheduled request whose start has come and
 * that can be put in force now, and the claims whose end is not recorded yet — at most 200 — and runs `applyIfDue`
 * for each, one at a time. Every activation is NOWAIT and guarded row by row, so a pass beside the lazy path, an
 * administrator's action or another instance does each thing once.
 *
 * "Can be put in force now" is the activation's own gate, read in the same query: the company is open and a paid
 * period is in force. A business still waiting for paid access (PQ1), or closed, keeps its requests scheduled — and
 * is not visited for them every minute: unordered and limited to 200, such businesses would otherwise fill every
 * pass once there were 200 of them, and a business that is due, and that nobody looks at, would never be reached.
 * Its approval puts its requests in force (the lifecycle's trigger), and so does the first pass after a period
 * starts. Its trial's end is still written down once, through the claims query.
 *
 * "Busy" — another writer held the business's subscription row, or a row its end needs, when the pass reached it — is
 * looked at again a second later, and again, within the pass (N2): in this product a writer holds such a row for the
 * milliseconds of its own transaction, and a business must not wait a minute for a holder that let go at once. So what
 * is due is put in force within a minute of its start (PQ11), or within about a second of the moment its row is free.
 * A row held longer than the pass's budget is left to the next pass.
 */

const SWEEP_INTERVAL_MS = 60_000;
/** Companies handled per pass; the rest wait for the next minute. */
const BATCH_SIZE = 200;
/** A business found busy is looked at again this long after… */
const BUSY_RETRY_MS = 1_000;
/** …until this long after the pass began: well inside the minute, so the next pass starts on time. */
const BUSY_RETRY_BUDGET_MS = 30_000;

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
  /** Set when the module is destroyed: a pass looking again at busy businesses stops, and leaves them to the next. */
  private stopped = false;

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
    this.stopped = true;
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

  /**
   * One pass: every company with something due, up to the batch, one at a time; then the busy ones again, a second
   * apart, until each is free or the pass's budget is spent. Each company is counted once, by how it ended.
   */
  async sweep(): Promise<TrialEndSweep> {
    const started = Date.now();
    const now = this.clock.now();
    const [scheduled, unrecorded] = await Promise.all([
      // The activation's gate (trial-end-roll.ts `activateDueAddOnsTx`): an open company with a paid period in force.
      this.prisma.$queryRaw<{ company_id: Buffer }[]>`
        SELECT DISTINCT sa.company_id
          FROM seat_allocations sa
          JOIN companies c ON c.id = sa.company_id
         WHERE sa.status = 'scheduled'
           AND sa.effective_at <= ${now}
           AND c.closed_at IS NULL
           AND EXISTS (
                 SELECT 1 FROM billing_periods bp
                  WHERE bp.company_id = sa.company_id
                    AND bp.period_start <= ${now}
                    AND (bp.period_end IS NULL OR bp.period_end > ${now})
               )
         LIMIT 200
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
    const busy = new Map<string, Buffer>();
    for (const [key, companyId] of companies) {
      const outcome = await this.trialEnd.applyIfDue(companyId);
      if (outcome === 'busy') busy.set(key, companyId);
      else outcomes[outcome] += 1;
    }
    const wasBusy = busy.size;
    while (busy.size > 0 && !this.stopped && Date.now() + BUSY_RETRY_MS <= started + BUSY_RETRY_BUDGET_MS) {
      await this.pause(BUSY_RETRY_MS);
      for (const [key, companyId] of [...busy]) {
        const outcome = await this.trialEnd.applyIfDue(companyId);
        if (outcome === 'busy') continue;
        busy.delete(key);
        outcomes[outcome] += 1;
      }
    }
    outcomes.busy = busy.size;
    if (wasBusy > 0) {
      this.log.log(`free trial end sweep: ${wasBusy} busy at first look; ${wasBusy - busy.size} finished on a later look, ${busy.size} left to the next pass`);
    }
    if (outcomes.failed > 0) {
      this.log.warn(`free trial end sweep: ${outcomes.failed} of ${companies.size} companies failed; retried next minute`);
    }
    if (outcomes.done > 0) this.log.log(`free trial end sweep: ${outcomes.done} companies brought up to date`);
    return { companies: companies.size, outcomes };
  }

  /** A real second between looks: the injected clock dates the work, it does not pace it. Never holds the process open. */
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
  }
}
