import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import { RollupService } from './rollup.service';
import type { RollupQueue } from './rollup-queue';

/**
 * Works the durable recompute requests (0081, docs/52).
 *
 * The same guarantees as the recognition outbox, obtained the same way, with one
 * difference that matters here — many requests for one branch-day are worked by
 * ONE recompute:
 *
 *  - **No lost update.** A request only exists if the change that wrote it
 *    committed. The worker claims the requests it has seen, THEN recomputes, so the
 *    recompute reads every change behind them. A request committed during the
 *    recompute is not in the claim: it stays pending for the next pass.
 *  - **No double counting.** The recompute rebuilds the branch-day from its source
 *    records; it never adds to a total. Working a request twice — a crash after the
 *    recompute but before `done`, an expired lease taken over, a replayed pass —
 *    writes the same figures again.
 *  - **No stuck work.** A claim is a lease. A worker that dies mid-recompute lets it
 *    expire; the next pass takes the rows again.
 *  - **No lost request after a failure.** A recompute that throws puts its rows back
 *    to `pending` with the error and a capped backoff. They are never abandoned:
 *    a day's figures matter more than a quiet log, so the row stays visible and is
 *    retried every half hour at most.
 */

/** How long a claim is held before another pass may take the rows. */
const LEASE_MS = 60_000;
/** Requests read per round; a round repeats until nothing due is left. */
const BATCH_SIZE = 200;
/** Sweep cadence, plus one sweep at start-up to recover what a stop left behind. */
const SWEEP_INTERVAL_MS = 30_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 30 * 60_000;

interface DueRow {
  id: Buffer;
  companyId: Buffer;
  branchId: Buffer;
  kind: 'daily' | 'branch';
  day: Date | null;
  attempts: number;
}

export interface SweepResult {
  /** Recomputes that succeeded (one per branch-day or branch). */
  recomputed: number;
  /** Recomputes that failed and were put back to wait. */
  failed: number;
}

@Injectable()
export class RollupOutboxService implements RollupQueue, OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(RollupOutboxService.name);
  private timer: NodeJS.Timeout | null = null;
  /** The pass running in this process, and whether another was asked for while it ran. */
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rollups: RollupService,
  ) {}

  onApplicationBootstrap(): void {
    // Recover whatever a stop or a failure left behind before serving traffic.
    void this.processNow();
    this.timer = setInterval(() => void this.processNow(), SWEEP_INTERVAL_MS);
    // Do not hold the process open purely for the sweeper.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One pass at a time in this process. A caller arriving during a pass gets one
   * more pass after it — which begins after the caller's commit, so it sees the
   * caller's request. Never rejects.
   */
  processNow(): Promise<void> {
    this.again = true;
    if (!this.running) {
      this.running = (async () => {
        try {
          while (this.again) {
            this.again = false;
            try {
              await this.sweep();
            } catch (e) {
              // The rows stay where they are; the next pass retries them.
              this.log.error(`rollup sweep failed: ${describe(e)}`);
            }
          }
        } finally {
          this.running = null;
        }
      })();
    }
    return this.running;
  }

  /** Work every due request, a branch-day at a time. */
  async sweep(): Promise<SweepResult> {
    const result: SweepResult = { recomputed: 0, failed: 0 };
    for (;;) {
      const now = new Date();
      const due = (await this.prisma.rollupRequest.findMany({
        where: {
          OR: [
            { status: 'pending', nextAttemptAt: { lte: now } },
            // An expired lease: the pass that held it died mid-recompute.
            { status: 'processing', claimedUntil: { lt: now } },
          ],
        },
        orderBy: { requestedAt: 'asc' },
        take: BATCH_SIZE,
        select: { id: true, companyId: true, branchId: true, kind: true, day: true, attempts: true },
      })) as DueRow[];
      if (due.length === 0) return result;

      let progressed = false;
      for (const group of groupByScope(due)) {
        const outcome = await this.work(group);
        if (outcome === 'done') result.recomputed += 1;
        if (outcome === 'failed') result.failed += 1;
        if (outcome === 'done') progressed = true;
      }
      // A full batch may hide more; anything that failed waits for its backoff.
      if (due.length < BATCH_SIZE || !progressed) return result;
    }
  }

  private async work(group: DueRow[]): Promise<'done' | 'failed' | 'skipped'> {
    const first = group[0];
    const now = new Date();
    const token = newUuidV7Bin();

    // Conditional claim: only the pass whose UPDATE matches a row works it.
    const claim = await this.prisma.rollupRequest.updateMany({
      where: {
        id: { in: group.map((r) => r.id) },
        OR: [
          { status: 'pending', nextAttemptAt: { lte: now } },
          { status: 'processing', claimedUntil: { lt: now } },
        ],
      },
      data: { status: 'processing', claimToken: token, claimedUntil: new Date(now.getTime() + LEASE_MS), attempts: { increment: 1 } },
    });
    if (claim.count === 0) return 'skipped';

    try {
      if (first.kind === 'daily') {
        await this.rollups.recomputeDaily(first.companyId, first.branchId, dayKeyOf(first.day as Date));
      } else {
        await this.rollups.refreshBranch(first.companyId, first.branchId);
      }
      await this.prisma.rollupRequest.updateMany({
        where: { claimToken: token, status: 'processing' },
        data: { status: 'done', processedAt: new Date(), claimedUntil: null, lastError: null },
      });
      return 'done';
    } catch (e) {
      const attempts = Math.max(...group.map((r) => r.attempts)) + 1;
      await this.prisma.rollupRequest.updateMany({
        where: { claimToken: token, status: 'processing' },
        data: {
          status: 'pending',
          claimedUntil: null,
          lastError: describe(e).slice(0, 500),
          nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
        },
      });
      this.log.warn(`rollup ${first.kind} ${first.kind === 'daily' ? dayKeyOf(first.day as Date) : ''} failed (attempt ${attempts}), will retry: ${describe(e)}`);
      return 'failed';
    }
  }
}

/** One group per branch-day (`daily`) or per branch (`branch`), in the order first requested. */
export function groupByScope<T extends { branchId: Buffer; kind: 'daily' | 'branch'; day: Date | null }>(rows: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const key = `${r.branchId.toString('hex')}|${r.kind}|${r.day ? dayKeyOf(r.day) : ''}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  return [...groups.values()];
}

export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS);
}

function dayKeyOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The line that says what went wrong: a Prisma error puts its cause last, after a code frame. */
export function describe(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? text;
}
