import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../prisma/prisma.service';
import { AppClsStore } from '../common/context/request-context';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import { RecognitionService } from './recognition.service';

/**
 * Durable teach-on-confirm.
 *
 * Learning used to run after the purchase transaction committed. If the process
 * stopped in that window the stock existed and the learning did not — lost
 * silently and permanently, so the scanner never got smarter from a delivery it
 * had already accepted.
 *
 * The intent is now written INSIDE the business transaction (`enqueueTx`), so
 * either both exist or neither does. This service drains the queue.
 *
 * Guarantees, and how each is obtained:
 *
 *  - **No double counting.** `learn()` and marking the row `done` happen in ONE
 *    transaction. A crash after incrementing evidence but before marking cannot
 *    happen — both roll back together. The unique event key is a second line of
 *    defence: the same logical event cannot be enqueued twice at all.
 *  - **No lost work.** Rows are never deleted. A permanently failing event ends
 *    as `failed` and stays visible for investigation.
 *  - **No stuck work.** Claims are LEASES with a deadline, not locks. A worker
 *    that dies mid-process simply lets its lease expire and the row is picked up
 *    again — no manual intervention, no wedged queue.
 *  - **No stampede.** Exponential backoff with a cap, so one poison row cannot
 *    hammer a shop's database every sweep.
 *  - **Safe for more than one instance later.** Claiming is a conditional
 *    `updateMany`; only the worker whose UPDATE matched a row processes it.
 */

/** How long a claim is held before another worker may take the row. */
const LEASE_MS = 60_000;
/** Rows per sweep. Bounded so a large backlog cannot monopolise the process. */
const BATCH_SIZE = 50;
/** Sweep cadence, plus one sweep at startup to recover anything left behind. */
const SWEEP_INTERVAL_MS = 60_000;
/** Give up after this many tries and leave the row visible as `failed`. */
const MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 30 * 60_000;

/** The Prisma surface `enqueueTx` needs — the caller's transaction client. */
export interface OutboxTxClient {
  recognitionOutbox: {
    createMany: (args: unknown) => Promise<unknown>;
  };
}

export interface LearningIntent {
  companyId: Buffer;
  /** The business record this came from — a purchase, or null for catalog. */
  purchaseId: Buffer | null;
  codeType: string;
  code: string;
  productId: Buffer;
  supplierId?: Buffer | null;
  source: string;
}

@Injectable()
export class RecognitionOutboxService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(RecognitionOutboxService.name);
  private timer: NodeJS.Timeout | null = null;
  /** Guards against a slow sweep overlapping the next tick in this instance. */
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly recognition: RecognitionService,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  onApplicationBootstrap(): void {
    // Recover anything a previous run left behind before serving traffic.
    void this.sweep().catch((e) => this.log.error(`startup sweep failed: ${describe(e)}`));
    this.timer = setInterval(() => {
      void this.sweep().catch((e) => this.log.error(`sweep failed: ${describe(e)}`));
    }, SWEEP_INTERVAL_MS);
    // Do not hold the process open purely for the sweeper.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Queue learning intents inside the caller's transaction.
   *
   * `skipDuplicates` makes a replayed business request a no-op here rather than
   * an error: the unique key is (company, purchase, codeType, code), so one
   * delivery's codes are each independently idempotent, and a purchase carrying
   * several codes produces several separately-retryable events.
   */
  async enqueueTx(tx: OutboxTxClient, intents: LearningIntent[]): Promise<void> {
    if (intents.length === 0) return;
    await tx.recognitionOutbox.createMany({
      data: intents.map((i) => ({
        id: newUuidV7Bin(),
        companyId: i.companyId,
        purchaseId: i.purchaseId,
        codeType: i.codeType,
        code: i.code,
        productId: i.productId,
        supplierId: i.supplierId ?? null,
        source: i.source,
      })),
      skipDuplicates: true,
    });
  }

  /** Best-effort immediate drain after a commit. Purely an optimisation. */
  async processNow(): Promise<void> {
    try {
      await this.sweep();
    } catch (e) {
      // The sweeper will retry; never fail the business request for this.
      this.log.warn(`immediate drain failed, leaving to sweeper: ${describe(e)}`);
    }
  }

  async sweep(): Promise<{ processed: number; failed: number }> {
    if (this.sweeping) return { processed: 0, failed: 0 };
    this.sweeping = true;
    try {
      const now = new Date();
      const due = await this.prisma.recognitionOutbox.findMany({
        where: {
          OR: [
            { status: 'pending', nextAttemptAt: { lte: now } },
            // An expired lease means the previous worker died mid-flight.
            { status: 'processing', claimedUntil: { lt: now } },
          ],
        },
        orderBy: { nextAttemptAt: 'asc' },
        take: BATCH_SIZE,
      });

      let processed = 0;
      let failed = 0;
      for (const row of due) {
        const outcome = await this.processRow(row);
        if (outcome === 'done') processed += 1;
        else if (outcome === 'failed') failed += 1;
      }
      return { processed, failed };
    } finally {
      this.sweeping = false;
    }
  }

  private async processRow(row: {
    id: Buffer;
    companyId: Buffer;
    codeType: string;
    code: string;
    productId: Buffer;
    supplierId: Buffer | null;
    source: string;
    attempts: number;
  }): Promise<'done' | 'failed' | 'skipped'> {
    const now = new Date();

    // Conditional claim: whoever's UPDATE matches a row owns it. A second
    // worker's UPDATE matches nothing and it moves on.
    const claim = await this.prisma.recognitionOutbox.updateMany({
      where: {
        id: row.id,
        OR: [
          { status: 'pending', nextAttemptAt: { lte: now } },
          { status: 'processing', claimedUntil: { lt: now } },
        ],
      },
      data: {
        status: 'processing',
        claimedUntil: new Date(now.getTime() + LEASE_MS),
        attempts: { increment: 1 },
      },
    });
    if (claim.count === 0) return 'skipped';

    const attempts = row.attempts + 1;

    try {
      /**
       * The atomicity that matters: learning and completion commit together.
       *
       * Run inside a CLS scope carrying this row's company so the learning path
       * behaves exactly as it does in a request — same audit trail, same
       * company scoping — despite there being no HTTP request here.
       */
      await this.cls.runWith({ companyId: row.companyId } as AppClsStore, async () => {
        await this.prisma.$transaction(async (tx) => {
          await this.recognition.learn(
            {
              codeType: row.codeType as never,
              code: row.code,
              productId: row.productId,
              source: row.source as never,
              supplierId: row.supplierId,
            },
            { tx: tx as never, companyId: row.companyId },
          );
          await tx.recognitionOutbox.update({
            where: { id: row.id },
            data: { status: 'done', processedAt: new Date(), claimedUntil: null, lastError: null },
          });
        });
      });
      return 'done';
    } catch (e) {
      const dead = attempts >= MAX_ATTEMPTS;
      await this.prisma.recognitionOutbox.update({
        where: { id: row.id },
        data: {
          // `failed` is a terminal, VISIBLE state — the row is kept so a human
          // can see what never learned and why.
          status: dead ? 'failed' : 'pending',
          claimedUntil: null,
          lastError: describe(e).slice(0, 500),
          nextAttemptAt: dead ? new Date() : new Date(Date.now() + backoffMs(attempts)),
        },
      });
      if (dead) this.log.error(`learning event ${row.code} dead after ${attempts} attempts`);
      return dead ? 'failed' : 'skipped';
    }
  }
}

function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS);
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
