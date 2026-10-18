import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { Clock } from '../entitlement/clock';
import { isLockBusy } from '../common/db/deadlock-retry';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { redact } from '../platform/platform-audit.service';
import { lockNowait } from '../platform/trial/trial-end-roll';
import {
  GRACE_ALLOWANCE,
  GRACE_WINDOW_MONTHS,
  decideGrace,
  graceDue,
  graceSpan,
  graceWindowStart,
  type GraceDecision,
  type RecordedGrace,
} from '../entitlement/grace-rules';
import { lockSubscriptionNowait } from './renewal';
import type { BillingDb } from './billing.service';

/**
 * Writing down a paid period end's grace decision (0099; docs/101 §3) — once, under the subscription lock.
 *
 * The state is computed from the facts on every request, so access changes at the period end exactly whether or not
 * anything was written yet (`grace-rules.ts` decides an unrecorded end exactly as it will be recorded). Three paths
 * write it, whichever comes first:
 *
 *  - **the lifecycle**, inside the transaction of any decision that moves the period end (approve, extend, set the
 *    end, grant), which holds the subscription row FOR UPDATE: an end that has passed is recorded BEFORE it moves, so
 *    the history every later decision is counted from is always complete, and an edited expiry can never skip one;
 *  - **the first evaluation** after the end, NOWAIT, at most once a minute per company — never holding up a request;
 *  - **the sweeper**, once a minute, NOWAIT, for the businesses nobody is looking at.
 *
 * The UNIQUE (company, period end) row, the subscription lock and the CHECKs make every path safe beside the others:
 * two writers produce one decision, and the second finds it.
 */

export type GraceRollOutcome = 'busy' | 'nothing_due' | 'recorded' | 'failed';

/** Who wrote the decision (`grace_episodes.recorded_by`). */
export type GraceWriter = 'evaluation' | 'sweeper' | 'lifecycle';

/** A uses count fits the column (TINYINT UNSIGNED): only a period end moved far into the past could count more. */
const MAX_USES = 255;
const TX_OPTIONS = { maxWait: 2_000, timeout: 10_000 } as const;
const DUE_CHECK_TTL_MS = 60_000;

/** The timeline's sentence, with no instant in it (C7): the dates travel as data. */
export function graceEventNote(decision: GraceDecision, usesBefore: number): string {
  return decision === 'granted'
    ? `The paid period ended: 72 hours of grace started (${usesBefore + 1} of ${GRACE_ALLOWANCE} in ${GRACE_WINDOW_MONTHS} months).`
    : `The paid period ended with the ${GRACE_ALLOWANCE} grace periods of the last ${GRACE_WINDOW_MONTHS} months already used: no grace.`;
}

/**
 * The decision for the subscription's current period end, written now if it is due and not written yet — on the
 * caller's transaction, which must already hold the subscription row. Returns what was written, or null when nothing
 * was due (not passed, covered by a grant, not a paid relationship) or it was already written.
 *
 * `nowait` takes the company row (the parent of the event and the audit) without waiting, for the lazy and sweeper
 * paths; the lifecycle's own transaction may wait like any other write.
 */
export async function recordDueGraceTx(
  tx: BillingDb,
  companyId: Buffer,
  now: Date,
  by: GraceWriter,
  opts: { nowait?: boolean } = {},
): Promise<RecordedGrace | null> {
  const sub = await tx.subscription.findFirst({
    where: { companyId },
    select: {
      id: true,
      status: true,
      currentPeriodEnd: true,
      isComplimentary: true,
      complimentaryUntil: true,
      company: { select: { name: true } },
    },
  });
  if (!sub || !graceDue(sub, now)) return null;
  const periodEnd = sub.currentPeriodEnd as Date;
  if (opts.nowait) await lockNowait(tx, 'company', companyId);

  // The UNIQUE (company, period end) key, read by its two columns.
  const existing = await tx.graceEpisode.findFirst({ where: { companyId, periodEnd }, select: { id: true } });
  if (existing) return null;

  const windowStart = graceWindowStart(periodEnd);
  const usesBefore = await tx.graceEpisode.count({
    where: { companyId, decision: 'granted', startedAt: { gt: windowStart }, NOT: { periodEnd } },
  });
  const decision = decideGrace(usesBefore);
  const span = graceSpan(periodEnd, decision);
  const id = newUuidV7Bin();
  await tx.graceEpisode.create({
    data: {
      id,
      companyId,
      subscriptionId: sub.id,
      periodEnd,
      decision,
      startedAt: span.startedAt,
      endsAt: span.endsAt,
      usesBefore: Math.min(usesBefore, MAX_USES),
      windowStart,
      recordedAt: now,
      recordedBy: by,
      createdAt: now,
    },
  });
  await tx.subscriptionEvent.create({
    data: {
      id: newUuidV7Bin(),
      companyId,
      subscriptionId: sub.id,
      kind: decision === 'granted' ? 'grace_started' : 'grace_unavailable',
      note: graceEventNote(decision, usesBefore),
      periodEndAfter: periodEnd,
      actor: 'system',
      createdAt: now,
    },
  });
  await tx.platformAuditEvent.create({
    data: {
      id: newUuidV7Bin(),
      adminId: null,
      actor: 'system',
      action: decision === 'granted' ? 'grace.started' : 'grace.unavailable',
      targetType: 'Company',
      targetId: companyId,
      targetLabel: sub.company.name.slice(0, 200),
      afterJson: redact({
        episodeId: binToUuid(id),
        periodEnd: periodEnd.toISOString(),
        endsAt: span.endsAt.toISOString(),
        usesBefore,
        allowance: GRACE_ALLOWANCE,
        windowStart: windowStart.toISOString(),
        recordedBy: by,
      }) as Prisma.InputJsonValue,
      createdAt: now,
    },
  });
  return { periodEnd, decision, startedAt: span.startedAt, endsAt: span.endsAt };
}

/**
 * The lazy and sweeper paths (constructed by hand, as `TrialEndRoll` is): NOWAIT on the subscription row and the
 * company row, so another writer makes the attempt `busy` at once and a later look finishes it.
 */
export class GraceRoll {
  private readonly log = new Logger('GraceRoll');
  /** company → when the lazy path last asked: at most once a minute per company. */
  private readonly checkedAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /**
   * The first evaluation after a period end that has no decision yet: record it now if the rows are free. True when
   * this call wrote it (the caller reads the record again). Never throws into the request.
   */
  async onEvaluation(companyId: Buffer): Promise<boolean> {
    const key = companyId.toString('hex');
    const t = this.clock.now().getTime();
    const last = this.checkedAt.get(key);
    if (last !== undefined && t - last < DUE_CHECK_TTL_MS) return false;
    this.checkedAt.set(key, t);
    const outcome = await this.recordIfDue(companyId, 'evaluation');
    if (outcome !== 'recorded') {
      // Busy or failed: the next evaluation may try again at once; nothing due: wait out the minute.
      if (outcome !== 'nothing_due') this.checkedAt.delete(key);
      return false;
    }
    return true;
  }

  /** Record the due decision now, NOWAIT. */
  async recordIfDue(companyId: Buffer, by: Exclude<GraceWriter, 'lifecycle'>): Promise<GraceRollOutcome> {
    try {
      const written = await this.prisma.$transaction(async (tx) => {
        await lockSubscriptionNowait(tx, companyId);
        // The instant is read behind the lock, as every writer here reads it.
        return recordDueGraceTx(tx, companyId, this.clock.now(), by, { nowait: true });
      }, TX_OPTIONS);
      return written ? 'recorded' : 'nothing_due';
    } catch (e) {
      if (isLockBusy(e)) return 'busy';
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return 'nothing_due';
      this.log.warn(`Grace decision not recorded for company ${binToUuid(companyId)}: ${(e as Error).message}`);
      return 'failed';
    }
  }
}
