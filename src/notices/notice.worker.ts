import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CLOCK, type Clock } from '../entitlement/clock';
import { GRACE_MS } from '../entitlement/grace-rules';
import { GraceRoll } from '../billing/grace-roll';
import { END_NOTICE_WINDOW_MS, REMINDER_LEAD_HOURS } from './notice-rules';
import { NoticeService } from './notice.service';

/**
 * The clock behind the subscription messages and the grace decisions (0099; docs/101 §3, §6) — the sweepers' pattern
 * (`trial-end.sweeper.ts`): a pass at start-up, then on unref'd timers, one pass at a time per process.
 *
 * **Every minute:**
 *  1. the grace decisions due and not yet written — a paid period end of about the last ten days (its 72 hours, the
 *     7-day announcement window and an hour: `PAID_LOOKBACK_MS`) that passed with no decision — are written (NOWAIT; a
 *     business found busy is left to the next minute or its first evaluation). An older end is decided when it is
 *     first needed (the evaluation, the lifecycle) and never announced;
 *  2. the timeline of every business that may have a message now — a trial or a paid period ending in the next 72
 *     hours or in the announcement window, or a message still waiting — is brought up to date (`NoticeService.refresh`);
 *  3. the messages WhatsApp accepted are checked for a terminal failure (`watchAccepted`).
 *
 * **Every 15 seconds:** the messages due are sent (`deliverNow`); a request that queues one starts a pass at once.
 */

const MINUTE_MS = 60_000;
const DELIVERY_INTERVAL_MS = 15_000;
/** Businesses looked at per minute for each query; the rest wait for the next minute. */
const BATCH_SIZE = 500;
const HOUR_MS = 3_600_000;
/** How far back a paid period end can still produce a message: its grace (72 h) and the end's announcement window. */
const PAID_LOOKBACK_MS = GRACE_MS + END_NOTICE_WINDOW_MS + HOUR_MS;
/** How far ahead the first reminder falls, with a minute's margin. */
const LOOKAHEAD_MS = REMINDER_LEAD_HOURS.h72 * HOUR_MS + MINUTE_MS;

@Injectable()
export class NoticeWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(NoticeWorker.name);
  private readonly graceRoll: GraceRoll;
  private minuteTimer: NodeJS.Timeout | null = null;
  private deliveryTimer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notices: NoticeService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.graceRoll = new GraceRoll(prisma, clock);
  }

  onApplicationBootstrap(): void {
    void this.minuteNow();
    this.minuteTimer = setInterval(() => void this.minuteNow(), MINUTE_MS);
    this.minuteTimer.unref?.();
    this.deliveryTimer = setInterval(() => void this.notices.deliverNow(), DELIVERY_INTERVAL_MS);
    this.deliveryTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.minuteTimer) clearInterval(this.minuteTimer);
    if (this.deliveryTimer) clearInterval(this.deliveryTimer);
  }

  /** The minute's pass, one at a time in this process. Never rejects: a failed pass is logged and the next minute tries again. */
  minuteNow(): Promise<void> {
    this.running ??= this.minute()
      .then(() => undefined)
      .catch((e: unknown) => {
        this.log.error(`subscription message pass failed: ${(e as Error).name}`);
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /** The three steps, in order: decisions first, so an end's message says what was decided. */
  async minute(): Promise<{ decided: number; refreshed: number }> {
    const now = this.clock.now();
    const decided = await this.recordDueGrace(now);
    const companies = await this.companiesWithMessages(now);
    for (const companyId of companies) await this.notices.refresh(companyId);
    await this.notices.watchAccepted();
    void this.notices.deliverNow();
    return { decided, refreshed: companies.length };
  }

  /** Step 1: the recent paid period ends with no decision, decided now. */
  private async recordDueGrace(now: Date): Promise<number> {
    const since = new Date(now.getTime() - PAID_LOOKBACK_MS);
    const due = await this.prisma.$queryRaw<{ company_id: Buffer }[]>`
      SELECT s.company_id
        FROM subscriptions s
        LEFT JOIN grace_episodes g ON g.company_id = s.company_id AND g.period_end = s.current_period_end
       WHERE s.status IN ('activated', 'suspended')
         AND s.current_period_end <= ${now}
         AND s.current_period_end > ${since}
         AND g.id IS NULL
       LIMIT ${BATCH_SIZE}
    `;
    let recorded = 0;
    for (const r of due) {
      if ((await this.graceRoll.recordIfDue(Buffer.from(r.company_id), 'sweeper')) === 'recorded') recorded += 1;
    }
    if (recorded > 0) this.log.log(`grace decisions recorded: ${recorded}`);
    return recorded;
  }

  /** Step 2's businesses: a trial or a paid period ending near now, or a message of the timeline still waiting. */
  private async companiesWithMessages(now: Date): Promise<Buffer[]> {
    const ahead = new Date(now.getTime() + LOOKAHEAD_MS);
    const paidSince = new Date(now.getTime() - PAID_LOOKBACK_MS);
    const trialSince = new Date(now.getTime() - END_NOTICE_WINDOW_MS - HOUR_MS);
    const rows = await this.prisma.$queryRaw<{ company_id: Buffer }[]>`
      SELECT company_id FROM subscriptions
       WHERE status = 'activated' AND current_period_end > ${paidSince} AND current_period_end <= ${ahead}
      UNION
      SELECT company_id FROM trial_claims WHERE ends_at > ${trialSince} AND ends_at <= ${ahead}
      UNION
      SELECT company_id FROM subscription_notices WHERE state = 'pending' AND kind <> 'portal_instructions'
      LIMIT ${BATCH_SIZE}
    `;
    return rows.map((r) => Buffer.from(r.company_id));
  }
}
