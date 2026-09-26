import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { AppClsStore } from '../common/context/request-context';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RollupService } from '../analytics/rollup.service';
import { periodFigures } from '../analytics/period-figures';
import { expensesTodayOf } from './expenses-today';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { dayWindow, isDateString, localParts, localTimeOf, shiftDate } from '../common/business-day';
import { BusinessDayService, dateKey, dateValue } from '../common/business-day/business-day.service';
import { fromCents, sharesBySale } from '../sales/sale-shares';
import { CreateClosingDto } from './dto/create-closing.dto';
import { RecordCountDto } from './dto/record-count.dto';
import { ReopenClosingDto } from './dto/reopen-closing.dto';
import { OpenDayDto } from './dto/open-day.dto';
import {
  buildChannels,
  countingComplete,
  isCountable,
  type Channel,
  type ChannelRow,
  type Component,
  type MovementRow,
} from './channels';
import { opensDiscrepancy } from './debt-rules';
import {
  canOpen,
  canReopen,
  closeKindOf,
  doorState,
  freshCounts,
  NOT_VERIFIED_AT_CLOSE,
  openingOf,
  verificationOf,
  type Verification,
  previousDayNeedsReview,
  reconcileDiscrepancy,
  reopenChoices,
  openChoices,
  standingOf,
  type DayStanding,
} from './closing-lifecycle';
import { reclosedNotice, reopenedNotice, saleNotice, type Notice } from './closing-notices';
import { ClosingNoticeService, type NoticeOutcome } from './closing-notice.service';
import {
  assembleReport,
  gateReport,
  reportInvariants,
  reportVersion,
  type ChannelCountState,
  type ClosingReport,
  type OpeningCash,
  type ReportPermissions,
} from './closing-report';
import {
  cancellationFigures,
  channelSplits,
  collectedForSales,
  dayActivity,
  expenseLines,
  expenseReversalLines,
  movementFingerprint,
  openDiscrepancies,
  pendingReports,
  returnFigures,
  salesFigures,
} from './closing-report.queries';

const num = (d: Prisma.Decimal | number | null): number => (d == null ? 0 : Number(d));
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** The row key the counting screen and the lifecycle rules share. */
const keyOf = (c: { channel: string; accountId: string | null }) => `${c.channel}:${c.accountId ?? 'NONE'}`;

/** What a sale's auto-reopen inside its own transaction reports back. */
export interface AutoReopenResult {
  reopened: boolean;
  closingId: Buffer | null;
  reopenCount: number;
  at: Date | null;
}

interface RecordedCount {
  id: Buffer;
  channel: Channel;
  receivingAccountId: Buffer | null;
  counted: Prisma.Decimal | null;
  isSkipped: boolean;
  skipReason: string | null;
  countedById: Buffer | null;
  countedAt: Date | null;
  expected: Prisma.Decimal;
}

/** What the timeline needs from a closing row: its status, its close and its counts, with the people. */
interface TimelineClosing {
  status: string;
  firstClosedAt: Date | null;
  closedAt: Date;
  countedCash: Prisma.Decimal | null;
  difference: Prisma.Decimal | null;
  closedBy: { name: string } | null;
  channelCounts: {
    labelSnapshot: string;
    counted: Prisma.Decimal | null;
    isSkipped: boolean;
    countedAt: Date | null;
    countedBy: { name: string } | null;
  }[];
}

interface TimelineRow {
  kind: string;
  at: Date;
  actor: string | null;
  payload: Record<string, unknown>;
}

/**
 * The business day's closing (Milestone E, reopenable since 0076).
 *
 * Every figure keys on the STORED business date of each record, never on the
 * calendar day of its timestamp. The branch-day rollup is recomputed first so
 * it is the single authoritative source for revenue / COGS / gross / expenses /
 * net profit. One transaction writes the closing, its per-channel snapshot,
 * the digest and a `closing_events` row; then the Owner is told after commit.
 */
@Injectable()
export class ClosingService {
  private readonly logger = new Logger(ClosingService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly rollups: RollupService,
    private readonly businessDay: BusinessDayService,
    private readonly notices: ClosingNoticeService,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  // ── The business day itself ─────────────────────────────────────────────

  /** Which day it is at this branch, and how the previous one stands. */
  async businessDayView() {
    const branchId = this.tenant.requireBranchId();
    const described = await this.businessDay.describe(branchId);
    const previousDate = shiftDate(described.businessDate, -1);
    const [current, previous] = await Promise.all([
      this.db.dailyClosing.findUnique({
        where: { branchId_closingDate: { branchId, closingDate: dateValue(described.businessDate) } },
        select: { status: true },
      }),
      this.db.dailyClosing.findUnique({
        where: { branchId_closingDate: { branchId, closingDate: dateValue(previousDate) } },
        select: { status: true },
      }),
    ]);
    const previousActive = previous ? true : await dayActivity(this.db, this.tenant.companyId(), branchId, previousDate);
    const previousRow = previous ? { status: previous.status, businessDate: previousDate } : null;
    return {
      ...described,
      standing: standingOf(current ? { status: current.status, businessDate: described.businessDate } : null, described.businessDate),
      previousDay: {
        businessDate: previousDate,
        standing: standingOf(previousRow, described.businessDate, previousActive, previousDate),
        needsReview: previousDayNeedsReview(previousRow, previousActive),
      },
    };
  }

  private requireDate(raw: string | undefined, fallback: string): string {
    if (raw === undefined) return fallback;
    if (!isDateString(raw)) throw new BadRequestException('date must be YYYY-MM-DD');
    return raw;
  }

  // ── Closing ─────────────────────────────────────────────────────────────

  /**
   * Close the business day on the report the server built (docs/51 D2, D5).
   *
   * Physical checks are optional. A channel counted after any reopen is closed as
   * counted, with its difference and its discrepancy. Every other countable
   * channel is closed as NOT VERIFIED — never as counted, matched or zero — and
   * that requires the person closing to acknowledge it with a reason. The close
   * stores the whole report in its event, so every earlier close keeps the figures
   * it was made on, and it is safe to retry: the same `clientUuid` replays it.
   */
  async close(dto: CreateClosingDto) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const described = await this.businessDay.describe(branchId);
    const today = described.businessDate;
    const day = this.requireDate(dto.date, today);
    if (day > today) throw new BadRequestException('A business day cannot be closed before it begins');
    const dayDate = dateValue(day);
    const now = new Date();
    const userId = this.tenant.userId() ?? null;
    const perms = this.permissions();

    /**
     * A double tap, or a retry after a network failure whose first attempt did
     * land: the same idempotency key on a day it already closed returns that
     * close instead of a 409 the person cannot interpret.
     */
    const replayed = await this.replayClose(branchId, dayDate, dto.clientUuid, perms, day, today);
    if (replayed) return replayed;

    /**
     * A day being counted already has a closing row (E-CP1), so existence is not
     * the test — being LOCKED is. A locked day stays locked until it is reopened
     * (0076), and a reopened day closes again as a RECLOSE: the first snapshot
     * stays on the row and in its event.
     */
    let already = await this.db.dailyClosing.findUnique({
      where: { branchId_closingDate: { branchId, closingDate: dayDate } },
      include: { channelCounts: true },
    });
    if (already?.status === 'locked') {
      throw new ConflictException({ code: 'already_closed', message: `Day ${day} is already closed for this branch` });
    }
    const kind = closeKindOf(already);
    if (kind === 'already_locked') throw new ConflictException({ code: 'already_closed', message: `Day ${day} is already closed for this branch` });

    /**
     * The closing row exists before anything is locked, so a sale committing
     * during this close and the close itself lock the SAME row (docs/51 §12.6).
     */
    if (!already) {
      try {
        await this.db.dailyClosing.create({
          data: {
            id: newUuidV7Bin(),
            companyId,
            branchId,
            closingDate: dayDate,
            expectedCash: 0,
            countedCash: null,
            difference: null,
            totalSales: 0,
            totalProfit: 0,
            status: 'counting',
            isLocked: false,
          },
        });
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      }
      already = await this.db.dailyClosing.findUnique({
        where: { branchId_closingDate: { branchId, closingDate: dayDate } },
        include: { channelCounts: true },
      });
      if (!already) throw new ConflictException({ code: 'refresh_required', message: 'This day changed while you were closing it' });
      if (already.status === 'locked') throw new ConflictException({ code: 'already_closed', message: `Day ${day} is already closed for this branch` });
    }
    const closingId = already.id;

    // What moved, read BEFORE the report: anything landing after this is caught inside the transaction.
    const fingerprintBefore = await movementFingerprint(this.db, companyId, branchId, day);

    // The rollup is the digest's source; refresh it, then read the report.
    await this.rollups.recomputeDaily(companyId, branchId, day);
    const rollup = await this.db.dailyRollup.findUnique({
      where: { branchId_day: { branchId, day: dayDate } },
    });
    const built = await this.buildReport(companyId, branchId, day, today, described.timezone);
    if (built.invariantFailures.length > 0) {
      throw new ConflictException({
        code: 'report_integrity',
        message: 'The figures for this day do not add up, so it cannot be closed. Nothing was changed.',
        failures: built.invariantFailures,
      });
    }
    if (dto.reportVersion && dto.reportVersion !== built.version) {
      throw new ConflictException({
        code: 'report_changed',
        message: 'The figures changed while you were reviewing them. Review the new report before closing.',
        report: this.gatedFor(built.report, built.version, perms, day === today),
      });
    }

    const revenue = round2(num(rollup?.revenue ?? 0));
    const cogs = round2(num(rollup?.cogs ?? 0));
    const grossProfit = round2(num(rollup?.grossProfit ?? 0));
    const expenses = round2(num(rollup?.expenses ?? 0));
    const netProfit = round2(num(rollup?.netProfit ?? 0));
    const totalReturns = round2(num(rollup?.returnsRevenue ?? 0));
    const totalReturnsProfitImpact = round2(num(rollup?.returnsGrossProfit ?? 0));
    const totalReturnAdjustments = round2(num(rollup?.returnsAdjustments ?? 0));
    const totalReturnsCogsCredited = round2(num(rollup?.returnsCogs ?? 0));
    const refundsPaidTotal = round2(num(rollup?.refundsPaidTotal ?? 0));
    const refundsPaidCash = round2(num(rollup?.refundsPaidCash ?? 0));

    // Expected cash = cash RECEIVED on the business day at this branch, dated by
    // the stored business date of each payment (0074 dated it by `paid_at`;
    // 0076 stores the date that instant maps to). A balance collected a week
    // after its sale belongs in the drawer of the day it was handed over.
    const cash = await this.db.payment.aggregate({
      _sum: { amount: true },
      where: { method: 'cash', businessDate: dayDate, sale: { branchId } },
    });
    const refundedCash = round2(num(rollup?.refundsPaidCash ?? 0));
    const supplierPaid = await this.stockPaidOn(branchId, dayDate);
    const finalChannels = built.channels;
    const cashChannel = finalChannels.find((c) => c.channel === 'cash');
    // Corrections in cash, NET: money a correction brought back, minus a payment reclassified out of the drawer (0078).
    const correctedCash = round2((cashChannel?.correctionsIn ?? 0) - (cashChannel?.correctionsOut ?? 0));
    const expensesCash = round2(num(rollup?.expensesCash ?? 0));
    /**
     * What the drawer held when the day began (0076, D4): the counted cash at the
     * last close whose drawer was counted, plus the net cash movement since.
     * A balance carried forward, never income — it appears in no profit figure.
     */
    const openingCash = built.opening.amount;

    /**
     * **The reconciliation equation.** Every movement appears exactly once:
     *
     *   expected = opening balance
     *            + cash taken in
     *            − refunds paid in cash
     *            − supplier payments in cash
     *            − expenses paid in cash
     *            + corrections returned in cash (net of payments reclassified out)
     *
     * Pending reports appear nowhere — only confirmed movements are here.
     */
    const expectedCash = round2(
      openingCash + num(cash._sum.amount) - refundedCash - supplierPaid.cash - expensesCash + correctedCash,
    );
    if (Math.abs(expectedCash - built.report.expected.cash.expected) >= 0.005) {
      throw new ConflictException({
        code: 'report_integrity',
        message: 'The drawer figure does not agree with the report, so the day cannot be closed. Nothing was changed.',
        failures: [`expected cash ${expectedCash} ≠ report ${built.report.expected.cash.expected}`],
      });
    }

    /**
     * Which channels were physically checked (D2). A count taken after any reopen
     * is a verification; a person's skip, a count from before a reopen and a
     * channel nobody touched are not. The legacy one-step `countedCash` is a count
     * of the drawer and is recorded as one; it never replaces a count already made.
     */
    const reopenedAt = already.status === 'reopened' ? already.reopenedAt : null;
    const countsByChannel = new Map<string, RecordedCount>(
      already.channelCounts.map((c) => [
        keyOf({ channel: c.channel, accountId: c.receivingAccountId ? binToUuid(c.receivingAccountId) : null }),
        c,
      ]),
    );
    const verificationOfKey = (key: string): Verification => {
      const c = countsByChannel.get(key);
      return verificationOf(
        c ? { counted: c.counted == null ? null : num(c.counted), isSkipped: c.isSkipped, skipReason: c.skipReason, countedAt: c.countedAt } : null,
        reopenedAt,
      );
    };
    const cashVerification = verificationOfKey('cash:NONE');
    let oneStepCash: number | null = null;
    if (dto.countedCash != null) {
      if (cashVerification === 'counted') {
        const recorded = round2(num(countsByChannel.get('cash:NONE')!.counted));
        if (round2(dto.countedCash) !== recorded) {
          throw new ConflictException(
            `A cash count of ${recorded} was already recorded for ${day}; recount it rather than overriding it at sign-off`,
          );
        }
      } else {
        oneStepCash = round2(dto.countedCash);
      }
    }
    const unverified = built.report.close.unverified.filter((key) => !(key === 'cash:NONE' && oneStepCash !== null));
    const reason = dto.reason?.trim() ?? '';
    if (unverified.length > 0 && (dto.acknowledgeUnverified !== true || reason.length === 0)) {
      throw new BadRequestException({
        code: 'acknowledgement_required',
        message: 'Some balances were not physically checked. Confirm that, and say why, to close without them.',
        unverified,
      });
    }

    const cashCounted = cashVerification === 'counted' ? round2(num(countsByChannel.get('cash:NONE')!.counted)) : oneStepCash;
    const countedCash = cashCounted;
    const difference = countedCash === null ? null : round2(countedCash - expectedCash);

    const lines = await this.buildDigestLines(branchId, dayDate);
    const sinceFirst = kind === 'reclose' && already.firstClosedAt ? await this.movementSince(branchId, dayDate, already.firstClosedAt) : null;
    const verification = {
      verified: built.report.close.verified.concat(oneStepCash !== null ? ['cash:NONE'] : []),
      unverified,
      acknowledged: unverified.length > 0,
      reason: unverified.length > 0 ? reason : null,
    };
    /**
     * The report as this close records it. A balance nobody checked is stored as the
     * close leaves it — NOT verified — not as the "not counted yet" it read a moment
     * before: the stored report and the day read back afterwards must agree, or every
     * closed day with an unchecked account would claim its figures changed since.
     */
    const asClosed = (r: ClosingReport): ClosingReport => ({
      ...r,
      expected: {
        cash: unverified.includes('cash:NONE') ? { ...r.expected.cash, verification: 'not_verified' } : r.expected.cash,
        accounts: r.expected.accounts.map((a) => (unverified.includes(a.key) ? { ...a, verification: 'not_verified' as const } : a)),
      },
    });
    const frozenReport: ClosingReport = asClosed(
      oneStepCash === null
        ? built.report
        : {
            ...built.report,
            expected: {
              ...built.report.expected,
              cash: { ...built.report.expected.cash, counted: oneStepCash, difference, verification: 'counted', countedAt: now.toISOString() },
            },
            close: { ...built.report.close, unverified, verified: verification.verified, requiresAcknowledgement: unverified.length > 0 },
          },
    );
    const frozenVersion = reportVersion(frozenReport);
    const alreadyVersion = already.version;

    let result: { eventId: Buffer; reopenCount: number };
    try {
      result = await this.db.$transaction(async (tx) => {
        /**
         * Lock the row every sale and correction on this day also locks, then check
         * that nothing moved since the report was read. Anything that did is in the
         * fresh report the person is sent back to — never silently outside a close.
         */
        await tx.$queryRaw(Prisma.sql`
          SELECT id FROM daily_closings WHERE id = ${closingId} FOR UPDATE`);
        const fingerprintNow = await movementFingerprint(tx, companyId, branchId, day);
        if (fingerprintNow !== fingerprintBefore) {
          throw new ConflictException({
            code: 'report_changed',
            message: 'Something was recorded on this day while you were closing it. Review the new report before closing.',
          });
        }

        const snapshot = {
          expectedCash,
          countedCash,
          difference,
          totalSales: revenue,
          totalProfit: netProfit,
          totalReturns,
          totalReturnsProfitImpact,
          totalReturnAdjustments,
          totalReturnsCogsCredited,
          refundsPaidTotal,
          refundsPaidCash,
          supplierPaidTotal: supplierPaid.total,
          supplierPaidCash: supplierPaid.cash,
          correctionsTotal: round2(num(rollup?.correctionsTotal ?? 0)),
          correctionsCash: correctedCash,
          expensesCash,
          status: 'locked' as const,
          isLocked: true,
          closedById: userId,
          closedAt: now,
          // The first sign-off is written once and never moved (0076).
          ...(kind === 'first' ? { firstClosedAt: now, firstClosedById: userId } : {}),
        };
        /**
         * Guarded on the version AND on not already being locked, so two people
         * signing off the same day produce one closing and one 409 rather than
         * two conflicting snapshots.
         */
        const won = await tx.dailyClosing.updateMany({
          where: { id: closingId, version: alreadyVersion, status: { not: 'locked' } },
          data: { ...snapshot, version: { increment: 1 } },
        });
        if (won.count === 0) {
          throw new ConflictException({ code: 'refresh_required', message: 'This day was changed while you were closing it' });
        }

        /**
         * Freeze each channel as it stood at sign-off. A fresh count stays a count.
         * Every other countable channel becomes NOT VERIFIED — `counted` NULL, never
         * a zero or the expected figure — except a person's own skip, which keeps
         * their reason. A count from before a reopen is not reused: it described a
         * drawer that has since changed (its figure survives in its count event).
         */
        const frozenRows: { key: string; id: Buffer; difference: number | null }[] = [];
        for (const ch of finalChannels) {
          const key = keyOf(ch);
          const saved = countsByChannel.get(key);
          const v = key === 'cash:NONE' && oneStepCash !== null ? 'counted' : verificationOfKey(key);
          const countable = isCountable(ch);
          let counted: number | null = null;
          let isSkipped = false;
          let skipReason: string | null = null;
          let countedById: Buffer | null = saved?.countedById ?? null;
          let countedAt: Date | null = saved?.countedAt ?? null;
          if (v === 'counted') {
            counted = key === 'cash:NONE' && oneStepCash !== null ? oneStepCash : round2(num(saved!.counted));
            if (key === 'cash:NONE' && oneStepCash !== null) {
              countedById = userId;
              countedAt = now;
            }
          } else if (v === 'skipped') {
            isSkipped = true;
            skipReason = saved?.skipReason ?? NOT_VERIFIED_AT_CLOSE;
          } else if (countable) {
            isSkipped = true;
            skipReason = NOT_VERIFIED_AT_CLOSE;
            countedById = userId;
            countedAt = now;
          }
          const diff = counted === null ? null : round2(counted - ch.expected);
          const frozen = {
            labelSnapshot: ch.labelSnapshot,
            salesIn: ch.salesIn,
            refundsOut: ch.refundsOut,
            supplierOut: ch.supplierOut,
            expensesOut: ch.expensesOut,
            correctionsIn: ch.correctionsIn,
            correctionsOut: ch.correctionsOut,
            openingBalance: ch.openingBalance,
            expected: ch.expected,
            counted,
            difference: diff,
            isSkipped,
            skipReason,
            countedById,
            countedAt,
          };
          let rowId: Buffer;
          if (saved) {
            await tx.closingChannelCount.update({ where: { id: saved.id }, data: frozen });
            rowId = saved.id;
          } else {
            rowId = newUuidV7Bin();
            await tx.closingChannelCount.create({
              data: {
                id: rowId,
                companyId,
                closingId,
                channel: ch.channel,
                receivingAccountId: ch.accountId ? uuidToBin(ch.accountId) : null,
                ...frozen,
              },
            });
          }
          frozenRows.push({ key, id: rowId, difference: countable ? diff : null });
        }

        /**
         * A difference becomes a question, not a number (E-CP2), opened
         * `pending_investigation` and never assigned. A channel nobody checked at
         * this close answers nothing: an earlier question stays as it was (D2).
         */
        for (const row of frozenRows) {
          const existing = await tx.closingDiscrepancy.findMany({
            where: { closingId, channelCountId: row.id },
            orderBy: { openedAt: 'asc' },
          });
          const action = reconcileDiscrepancy(
            existing.map((d) => ({ status: d.status, amount: num(d.amount) })),
            row.difference,
          );
          const pending = existing.find((d) => d.status === 'pending_investigation') ?? null;
          if (action.kind === 'none') continue;
          if (action.kind === 'open') {
            await tx.closingDiscrepancy.create({
              data: { id: newUuidV7Bin(), companyId, branchId, closingId, channelCountId: row.id, amount: action.amount },
            });
          } else if (action.kind === 'update' && pending) {
            await tx.closingDiscrepancy.update({
              where: { id: pending.id },
              data: { amount: action.amount, version: { increment: 1 } },
            });
          } else if (action.kind === 'resolve_no_difference' && pending) {
            await tx.closingDiscrepancy.update({
              where: { id: pending.id },
              data: {
                status: 'resolved',
                resolution: 'error_corrected',
                resolutionReason: 'Reclosed after a reopen: no difference remains',
                resolvedById: userId,
                resolvedAt: now,
                version: { increment: 1 },
              },
            });
          }
        }

        // The digest: one per closing. A reclose rewrites it from the same lines;
        // each close's own report is kept whole in its event below.
        const existingDigest = await tx.dailyDigest.findUnique({ where: { closingId }, select: { id: true } });
        const digestId = existingDigest?.id ?? newUuidV7Bin();
        if (existingDigest) {
          await tx.dailyDigest.update({
            where: { id: digestId },
            data: { revenue, costOfGoodsSold: cogs, grossProfit },
          });
          await tx.digestLine.deleteMany({ where: { digestId } });
        } else {
          await tx.dailyDigest.create({
            data: { id: digestId, companyId, branchId, closingId, digestDate: dayDate, revenue, costOfGoodsSold: cogs, grossProfit },
          });
        }
        if (lines.length > 0) {
          await tx.digestLine.createMany({ data: lines.map((l) => ({ ...l, id: newUuidV7Bin(), companyId, digestId })) });
        }

        const eventId = newUuidV7Bin();
        const reopenCount = already!.reopenCount ?? 0;
        await tx.closingEvent.create({
          data: {
            id: eventId,
            companyId,
            branchId,
            businessDate: dayDate,
            closingId,
            kind: kind === 'first' ? 'closed' : 'reclosed',
            at: now,
            actorId: userId,
            dedupeKey: kind === 'first' ? `closing:${closingId.toString('hex')}:closed` : `closing:${closingId.toString('hex')}:reclosed:${reopenCount}`,
            payload: {
              expectedCash,
              countedCash,
              difference,
              openingCash,
              verified: unverified.length === 0,
              unverifiedCount: unverified.length,
              verification,
              clientUuid: dto.clientUuid ?? null,
              reportVersion: frozenVersion,
              report: frozenReport,
              ...(sinceFirst ? { sinceFirstCount: sinceFirst } : {}),
            } as unknown as Prisma.InputJsonValue,
          },
        });

        await this.audit.recordTx(tx, {
          entityType: 'DailyClosing',
          entityId: closingId,
          action: kind === 'first' ? 'create' : 'status_change',
          reason: unverified.length > 0 ? `closed_not_verified: ${reason}`.slice(0, 255) : kind === 'first' ? undefined : 'reclosed',
          after: { day, kind, expectedCash, countedCash, difference, verified: verification.verified, unverified, reportVersion: frozenVersion },
          branchId,
        });
        return { eventId, reopenCount };
      });
    } catch (e) {
      /**
       * Two taps at the same moment with the same key: the first closed the day, so
       * the second meets the lock and the version guard. That is not a failure —
       * it is the same close — so it is answered with it.
       */
      if (e instanceof ConflictException) {
        const again = await this.replayClose(branchId, dayDate, dto.clientUuid, perms, day, today);
        if (again) return again;
      }
      throw e;
    }

    if (kind === 'first') {
      // No figures in a broadcast (docs/51 §12.2): the report is one tap away, behind its own permissions.
      await this.notifications.emit({
        type: 'closing.completed',
        title: `Day ${day} closed`,
        body: unverified.length > 0 ? 'Closed without a physical check of every balance' : 'Closed with every balance counted',
        branchId,
      });
    } else {
      // After commit, never before: a delivery problem is not the close's problem.
      void this.tellOwner(companyId, branchId, day, result.eventId, (ctx) =>
        reclosedNotice(ctx, {
          closingIdHex: closingId.toString('hex'),
          reopenCount: result.reopenCount,
          at: now,
          sinceFirstCount: sinceFirst ?? { salesValue: 0, cashIn: 0, salesCount: 0 },
          wholeDay: { salesValue: built.report.sales.value, expectedCash, countedCash, difference },
        }),
      );
    }

    return {
      closingId: binToUuid(closingId),
      date: day,
      kind,
      replayed: false,
      verification,
      report: { ...this.gatedFor(frozenReport, frozenVersion, perms, day === today), source: 'snapshot' as const },
      digest: perms.costView && (perms.reportView || perms.perform) ? { revenue, costOfGoodsSold: cogs, grossProfit, expenses, netProfit, lineCount: lines.length } : null,
    };
  }

  /** The gated view of a report for this caller. */
  private gatedFor(report: ClosingReport, version: string, perms: ReportPermissions, isToday: boolean) {
    const canClose = perms.perform && isToday && report.close.kind !== 'already_locked';
    return { ...gateReport(report, perms, canClose), reportVersion: version };
  }

  /** The same idempotency key on a day it already closed returns that close. */
  private async replayClose(branchId: Buffer, dayDate: Date, clientUuid: string | undefined, perms: ReportPermissions, day: string, today: string) {
    if (!clientUuid) return null;
    const row = await this.db.dailyClosing.findUnique({
      where: { branchId_closingDate: { branchId, closingDate: dayDate } },
      select: { id: true, status: true },
    });
    if (!row || row.status !== 'locked') return null;
    const event = await this.db.closingEvent.findFirst({
      where: { closingId: row.id, kind: { in: ['closed', 'reclosed'] } },
      orderBy: { at: 'desc' },
      select: { kind: true, payload: true },
    });
    const p = (event?.payload ?? null) as Record<string, unknown> | null;
    if (!p || p.clientUuid !== clientUuid) return null;
    const stored = snapshotReport(p);
    if (!stored) return null;
    return {
      closingId: binToUuid(row.id),
      date: day,
      kind: event!.kind === 'closed' ? ('first' as const) : ('reclose' as const),
      replayed: true,
      verification: stored.verification,
      report: { ...this.gatedFor({ ...stored.report, today, isToday: day === today }, stored.version, perms, day === today), source: 'snapshot' as const },
      digest: null,
    };
  }

  // ── The Daily closing report (docs/51 D1, D6) ─────────────────────────────

  private permissions(): ReportPermissions {
    const held = this.cls.get('permissions');
    return {
      count: held?.has('closing.count') ?? false,
      reportView: held?.has('report.view') ?? false,
      perform: held?.has('closing.perform') ?? false,
      costView: held?.has('cost.view') ?? false,
    };
  }

  /**
   * The report of one business date at this branch, for this caller. A LOCKED day
   * is shown as it was closed — the report stored with its latest close — and
   * says so if its live figures have moved since. Any other day is live.
   */
  async report(date?: string) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const now = new Date();
    const described = await this.businessDay.describe(branchId, now);
    const today = described.businessDate;
    const day = this.requireDate(date, today);
    if (day > today) throw new BadRequestException('That business day has not begun');
    const built = await this.buildReport(companyId, branchId, day, today, described.timezone);
    const perms = this.permissions();
    const closing = built.closing;
    const snapshotEvent =
      closing?.status === 'locked'
        ? await this.db.closingEvent.findFirst({
            where: { closingId: closing.id, kind: { in: ['closed', 'reclosed'] } },
            orderBy: { at: 'desc' },
            select: { kind: true, at: true, payload: true, actor: { select: { name: true } } },
          })
        : null;
    const stored = snapshotReport(snapshotEvent?.payload);
    const shown: ClosingReport = stored ? { ...stored.report, today, isToday: day === today, standing: built.report.standing } : built.report;
    const warnings = [...shown.warnings];
    if (stored && stored.version !== built.version) warnings.push({ code: 'changed_since_close', severity: 'warning', section: 'day' });
    if (!stored && built.invariantFailures.length > 0) {
      warnings.push({ code: 'figures_disagree', severity: 'error', section: 'day', params: { count: built.invariantFailures.length } });
    }
    const canClose = perms.perform && day === today && built.report.close.kind !== 'already_locked';
    return {
      ...gateReport({ ...shown, warnings }, perms, canClose),
      reportVersion: stored ? stored.version : built.version,
      liveVersion: built.version,
      source: stored ? ('snapshot' as const) : ('live' as const),
      snapshot:
        stored && snapshotEvent
          ? {
              kind: snapshotEvent.kind,
              at: snapshotEvent.at,
              by: snapshotEvent.actor?.name ?? null,
              verification: stored.verification,
            }
          : null,
      generatedAt: now.toISOString(),
    };
  }

  /**
   * "Correct a transaction" (docs/51 D9): every source record of (branch, date)
   * with its date, amount, channel and status, and what can be done about it —
   * the existing flow it opens, or a refusal by name. Nothing here corrects
   * anything; it only says where the correction lives.
   */
  async sources(date?: string) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const held = this.cls.get('permissions');
    const canRequest = held?.has('financial.correction.request') ?? false;
    const canApprove = held?.has('financial.correction.approve') ?? false;
    const perform = held?.has('closing.perform') ?? false;
    if (!canRequest && !perform) {
      throw new ForbiddenException('Correcting a transaction needs the closing or the correction authority');
    }
    const now = new Date();
    const described = await this.businessDay.describe(branchId, now);
    const today = described.businessDate;
    const day = this.requireDate(date, today);
    if (day > today) throw new BadRequestException('That business day has not begun');
    const dayDate = dateValue(day);
    const tz = described.timezone;
    const corrected = { select: { id: true, status: true } } as const;

    const [sales, payments, refunds, expenses, purchases, corrections, pending] = await Promise.all([
      this.db.sale.findMany({
        where: { branchId, businessDate: dayDate },
        orderBy: { soldAt: 'asc' },
        select: {
          id: true,
          invoiceNo: true,
          total: true,
          soldAt: true,
          user: { select: { name: true } },
          customer: { select: { name: true } },
          counterparty: { select: { name: true } },
          corrections: corrected,
          returnRequests: { select: { status: true } },
          returnReversals: { select: { id: true } },
          returns: { select: { id: true } },
          items: { where: { voided: false }, select: { quantity: true, unit: { select: { status: true } } } },
          payments: { select: { corrections: corrected } },
        },
      }),
      this.db.payment.findMany({
        where: { businessDate: dayDate, sale: { branchId } },
        orderBy: { paidAt: 'asc' },
        select: {
          id: true,
          kind: true,
          method: true,
          amount: true,
          paidAt: true,
          accountLabelSnapshot: true,
          receivingAccountId: true,
          recordedBy: { select: { name: true } },
          sale: { select: { id: true, invoiceNo: true, businessDate: true, customerId: true, counterpartyId: true, corrections: corrected } },
          corrections: corrected,
        },
      }),
      this.db.refundPayout.findMany({
        where: { branchId, status: 'confirmed', confirmationDate: dayDate },
        select: { id: true, returnRequestId: true, method: true, reportedAmount: true, accountLabelSnapshot: true, confirmedAt: true, correctedById: true },
      }),
      this.db.expense.findMany({
        where: {
          branchId,
          status: 'confirmed',
          OR: [
            { expenseClass: 'variable', confirmationDate: dayDate },
            { expenseClass: 'fixed', dueDate: dayDate },
          ],
        },
        orderBy: { confirmedAt: 'asc' },
        select: { id: true, category: true, amount: true, method: true, accountLabelSnapshot: true, receivingAccountId: true, confirmedAt: true, expenseClass: true, corrections: corrected },
      }),
      this.db.supplierPayment.findMany({
        where: { businessDate: dayDate, purchase: { branchId } },
        orderBy: { paidAt: 'asc' },
        select: {
          id: true,
          amount: true,
          method: true,
          accountLabelSnapshot: true,
          receivingAccountId: true,
          paidAt: true,
          createdBy: { select: { name: true } },
          corrections: corrected,
          purchase: {
            select: {
              id: true,
              branchId: true,
              total: true,
              corrections: corrected,
              units: { select: { status: true, branchId: true } },
              _count: { select: { items: true } },
            },
          },
        },
      }),
      this.db.financialCorrection.findMany({
        where: { branchId, status: 'approved', correctionDate: dayDate },
        orderBy: { decidedAt: 'asc' },
        select: {
          id: true,
          targetKind: true,
          action: true,
          amount: true,
          method: true,
          toMethod: true,
          toAccountLabelSnapshot: true,
          accountLabelSnapshot: true,
          decidedAt: true,
          reason: true,
          legs: { select: { direction: true, amount: true } },
        },
      }),
      // What is waiting for the Owner at this branch, whatever day it concerns.
      this.db.financialCorrection.findMany({
        where: { branchId, status: 'requested' },
        orderBy: { requestedAt: 'asc' },
        take: 50,
        select: {
          id: true,
          targetKind: true,
          action: true,
          amount: true,
          method: true,
          accountLabelSnapshot: true,
          toMethod: true,
          toAccountLabelSnapshot: true,
          reason: true,
          requestedAt: true,
          version: true,
          requestedBy: { select: { name: true } },
          targetPayment: { select: { sale: { select: { invoiceNo: true } } } },
          targetSale: { select: { invoiceNo: true } },
          targetExpense: { select: { category: true } },
          // Whether the record already carries an approved correction: two requests raced in,
          // one was approved, and this one can only be rejected now.
          targetPaymentId: true,
          targetSaleId: true,
          targetExpenseId: true,
          targetSupplierPaymentId: true,
          targetPurchaseId: true,
        },
      }),
    ]);
    const targetOf = (c: { targetPaymentId: Buffer | null; targetSaleId: Buffer | null; targetExpenseId: Buffer | null; targetSupplierPaymentId: Buffer | null; targetPurchaseId: Buffer | null }) =>
      c.targetPaymentId ?? c.targetSaleId ?? c.targetExpenseId ?? c.targetSupplierPaymentId ?? c.targetPurchaseId;
    const pendingTargets = pending.map(targetOf).filter((t): t is Buffer => !!t);
    const decided = pendingTargets.length
      ? await this.db.financialCorrection.findMany({
          where: {
            status: 'approved',
            OR: [
              { targetPaymentId: { in: pendingTargets } },
              { targetSaleId: { in: pendingTargets } },
              { targetExpenseId: { in: pendingTargets } },
              { targetSupplierPaymentId: { in: pendingTargets } },
              { targetPurchaseId: { in: pendingTargets } },
            ],
          },
          select: { targetPaymentId: true, targetSaleId: true, targetExpenseId: true, targetSupplierPaymentId: true, targetPurchaseId: true },
        })
      : [];
    const alreadyCorrected = new Set(decided.map((d) => targetOf(d)!.toString('hex')));

    const time = (d: Date | null) => (d ? localTimeOf(d, tz) : null);
    const state = (rows: { status: string }[]) => ({
      approved: rows.some((c) => c.status === 'approved'),
      requested: rows.some((c) => c.status === 'requested'),
    });
    type Action = 'cancel_sale' | 'reverse_payment' | 'reclassify_payment' | 'reverse_expense' | 'reclassify_purchase_payment' | 'cancel_purchase';
    type SourceRow = {
      kind: 'sale' | 'payment' | 'refund' | 'expense' | 'purchase' | 'correction';
      id: string;
      at: Date | null;
      localTime: string | null;
      amount: number;
      channel: 'cash' | 'account' | null;
      accountLabel: string | null;
      status: string;
      detail: Record<string, unknown>;
      recordedBy: string | null;
      /** Every correction that applies to this record now; the preview has the last word. */
      actions: Action[];
      /** The record's own screen, where the flow that corrects it (a return) or its history lives. */
      open: 'sale' | 'return' | 'expense' | null;
      /** Why nothing can be done here, when nothing can. */
      refusal: string | null;
    };
    const why = (s: { approved: boolean; requested: boolean }, done: string) => (s.approved ? done : s.requested ? 'request_pending' : null);
    const channelOf = (method: string) => (method === 'cash' ? ('cash' as const) : ('account' as const));

    const rows: SourceRow[] = [
      ...sales.map((s): SourceRow => {
        const c = state(s.corrections);
        const hasReturn = s.returnRequests.some((r) => r.status !== 'rejected') || s.returnReversals.length > 0 || s.returns.length > 0;
        const moved = s.items.some((i) => i.unit && i.unit.status !== 'sold');
        const paymentPending = s.payments.some((p) => state(p.corrections).requested);
        const refusal = c.approved
          ? 'sale_cancelled'
          : c.requested
            ? 'request_pending'
            : !canRequest
              ? 'not_permitted'
              : hasReturn
                ? 'sale_has_return'
                : moved
                  ? 'unit_not_sold'
                  : paymentPending
                    ? 'payment_correction_pending'
                    : null;
        return {
          kind: 'sale',
          id: binToUuid(s.id),
          at: s.soldAt,
          localTime: time(s.soldAt),
          amount: round2(num(s.total)),
          channel: null,
          accountLabel: null,
          status: c.approved ? 'cancelled' : c.requested ? 'cancellation_requested' : 'recorded',
          detail: {
            invoiceNo: s.invoiceNo,
            items: s.items.reduce((n, i) => n + i.quantity, 0),
            debtor: s.customer?.name ?? s.counterparty?.name ?? null,
          },
          recordedBy: s.user?.name ?? null,
          actions: refusal ? [] : ['cancel_sale'],
          open: 'sale',
          refusal,
        };
      }),
      ...payments.map((p): SourceRow => {
        const saleState = state(p.sale.corrections);
        const own = state(p.corrections);
        const refusal = saleState.approved
          ? 'sale_cancelled'
          : saleState.requested
            ? 'sale_cancellation_pending'
            : why(own, 'already_corrected') ?? (!canRequest ? 'not_permitted' : null);
        const hasDebtor = !!(p.sale.customerId || p.sale.counterpartyId);
        return {
          kind: 'payment',
          id: binToUuid(p.id),
          at: p.paidAt,
          localTime: time(p.paidAt),
          amount: round2(num(p.amount)),
          channel: channelOf(p.method),
          accountLabel: p.method === 'cash' ? null : p.accountLabelSnapshot,
          status: saleState.approved ? 'sale_cancelled' : own.approved ? 'corrected' : own.requested ? 'correction_requested' : 'recorded',
          detail: {
            saleId: binToUuid(p.sale.id),
            invoiceNo: p.sale.invoiceNo,
            paymentKind: p.kind,
            olderSale: dateKey(p.sale.businessDate) < day,
            accountId: p.method === 'cash' ? null : p.receivingAccountId ? binToUuid(p.receivingAccountId) : null,
            // Without a customer to owe it, a payment never received means the sale itself was wrong.
            reversible: hasDebtor,
          },
          recordedBy: p.recordedBy?.name ?? null,
          actions: refusal ? [] : hasDebtor ? ['reclassify_payment', 'reverse_payment'] : ['reclassify_payment'],
          open: 'sale',
          refusal,
        };
      }),
      ...refunds.map((r): SourceRow => ({
        kind: 'refund',
        id: binToUuid(r.id),
        at: r.confirmedAt,
        localTime: time(r.confirmedAt),
        amount: round2(num(r.reportedAmount)),
        channel: r.method === 'cash' ? 'cash' : 'account',
        accountLabel: r.accountLabelSnapshot,
        status: r.correctedById ? 'corrected' : 'confirmed',
        detail: { returnId: binToUuid(r.returnRequestId) },
        recordedBy: null,
        // The Milestone B correction of a refund lives on the return itself.
        actions: [],
        open: 'return',
        refusal: r.correctedById ? 'already_corrected' : null,
      })),
      ...expenses.map((e): SourceRow => {
        const own = state(e.corrections);
        const refusal = why(own, 'already_corrected') ?? (!canRequest ? 'not_permitted' : null);
        return {
          kind: 'expense',
          id: binToUuid(e.id),
          at: e.confirmedAt,
          localTime: time(e.confirmedAt),
          amount: round2(num(e.amount)),
          channel: e.method === 'cash' ? 'cash' : 'account',
          accountLabel: e.method === 'cash' ? null : e.accountLabelSnapshot,
          status: own.approved ? 'corrected' : own.requested ? 'correction_requested' : 'confirmed',
          detail: { category: e.category, expenseClass: e.expenseClass },
          recordedBy: null,
          actions: refusal ? [] : ['reverse_expense'],
          open: 'expense',
          refusal,
        };
      }),
      ...purchases.map((sp): SourceRow => {
        const own = state(sp.corrections);
        const purchase = sp.purchase!;
        const cancel = state(purchase.corrections);
        const moved = purchase.units.some((u) => u.status !== 'in_stock' || !u.branchId.equals(purchase.branchId));
        const refusal = cancel.approved
          ? 'purchase_cancelled'
          : cancel.requested
            ? 'purchase_cancellation_pending'
            : !canRequest
              ? 'not_permitted'
              : null;
        const actions: Action[] = refusal ? [] : [...(own.approved || own.requested ? [] : (['reclassify_purchase_payment'] as Action[])), ...(moved || own.requested ? [] : (['cancel_purchase'] as Action[]))];
        return {
          kind: 'purchase',
          id: binToUuid(sp.id),
          at: sp.paidAt,
          localTime: time(sp.paidAt),
          amount: round2(num(sp.amount)),
          channel: channelOf(sp.method),
          accountLabel: sp.method === 'cash' ? null : sp.accountLabelSnapshot,
          status: cancel.approved ? 'cancelled' : cancel.requested ? 'cancellation_requested' : own.approved ? 'corrected' : own.requested ? 'correction_requested' : 'paid',
          detail: {
            purchaseId: binToUuid(purchase.id),
            total: round2(num(purchase.total)),
            items: purchase._count.items,
            accountId: sp.method === 'cash' ? null : sp.receivingAccountId ? binToUuid(sp.receivingAccountId) : null,
            goodsMoved: moved,
          },
          recordedBy: sp.createdBy?.name ?? null,
          actions,
          open: null,
          refusal: refusal ?? (actions.length === 0 ? (own.requested ? 'request_pending' : moved ? 'goods_moved' : 'already_corrected') : null),
        };
      }),
      ...corrections.map((c): SourceRow => {
        const legsIn = round2(c.legs.filter((l) => l.direction === 'incoming').reduce((n, l) => n + num(l.amount), 0));
        const legsOut = round2(c.legs.filter((l) => l.direction === 'outgoing').reduce((n, l) => n + num(l.amount), 0));
        return {
          kind: 'correction',
          id: binToUuid(c.id),
          at: c.decidedAt,
          localTime: time(c.decidedAt),
          amount: round2(num(c.amount)),
          channel: c.action === 'reclassify' ? ((c.toMethod as 'cash' | 'account' | null) ?? null) : ((c.method as 'cash' | 'account' | null) ?? null),
          accountLabel: c.action === 'reclassify' ? c.toAccountLabelSnapshot : c.accountLabelSnapshot,
          status: 'approved',
          detail: { targetKind: c.targetKind, action: c.action, fromMethod: c.method, fromAccountLabel: c.accountLabelSnapshot, moneyIn: legsIn, moneyOut: legsOut, reason: c.reason },
          recordedBy: null,
          actions: [],
          open: null,
          refusal: null,
        };
      }),
    ];
    rows.sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));

    return {
      date: day,
      today,
      canRequest,
      canApprove,
      rows,
      /** Requests at this branch waiting for the Owner, whatever day they concern (approved or rejected in place). */
      pending: pending.map((c) => ({
        id: binToUuid(c.id),
        targetKind: c.targetKind,
        action: c.action,
        amount: round2(num(c.amount)),
        method: c.method,
        accountLabel: c.accountLabelSnapshot,
        to: c.action === 'reclassify' ? { method: c.toMethod, accountLabel: c.toAccountLabelSnapshot } : null,
        reason: c.reason,
        requestedBy: c.requestedBy?.name ?? null,
        requestedAt: c.requestedAt.toISOString(),
        version: c.version,
        label: c.targetSale?.invoiceNo ?? c.targetPayment?.sale.invoiceNo ?? c.targetExpense?.category ?? null,
        /** Another request for the same record was approved first: this one can only be rejected. */
        superseded: !!targetOf(c) && alreadyCorrected.has(targetOf(c)!.toString('hex')),
      })),
    };
  }

  /** Reads every figure of (branch, date) and assembles the full, ungated report. */
  private async buildReport(companyId: Buffer, branchId: Buffer, day: string, today: string, timezone: string) {
    const dayDate = dateValue(day);
    const closing = await this.db.dailyClosing.findUnique({
      where: { branchId_closingDate: { branchId, closingDate: dayDate } },
      include: { channelCounts: true },
    });
    const opening = await this.openingCashDetail(companyId, branchId, day);
    const [channels, splits, sales, returns, cancellations, collected, expenses, expenseReversals, pending, discrepancies, active] = await Promise.all([
      this.expectedChannels(companyId, branchId, day, day, opening.amount),
      channelSplits(this.db, companyId, branchId, day),
      salesFigures(this.db, companyId, branchId, day),
      returnFigures(this.db, companyId, branchId, day),
      cancellationFigures(this.db, companyId, branchId, day),
      collectedForSales(this.db, companyId, branchId, day),
      expenseLines(this.db, companyId, branchId, day),
      expenseReversalLines(this.db, companyId, branchId, day),
      day === today ? pendingReports(this.db, companyId, branchId) : Promise.resolve(null),
      openDiscrepancies(this.db, companyId, branchId),
      closing ? Promise.resolve(true) : day < today ? dayActivity(this.db, companyId, branchId, day) : Promise.resolve(true),
    ]);
    const reopenedAt = closing?.status === 'reopened' ? closing.reopenedAt : null;
    const counts = new Map<string, ChannelCountState>();
    for (const c of closing?.channelCounts ?? []) {
      const key = keyOf({ channel: c.channel, accountId: c.receivingAccountId ? binToUuid(c.receivingAccountId) : null });
      const counted = c.counted == null ? null : round2(num(c.counted));
      counts.set(key, {
        verification: verificationOf({ counted, isSkipped: c.isSkipped, skipReason: c.skipReason, countedAt: c.countedAt }, reopenedAt),
        counted,
        countedAt: c.countedAt,
        skipReason: c.skipReason,
      });
    }
    const standing = standingOf(closing ? { status: closing.status, businessDate: day } : null, today, active, day);
    const previousDate = shiftDate(day, -1);
    let previousDay: { businessDate: string; standing: DayStanding; needsReview: boolean } | null = null;
    if (day === today) {
      const prev = await this.db.dailyClosing.findUnique({
        where: { branchId_closingDate: { branchId, closingDate: dateValue(previousDate) } },
        select: { status: true },
      });
      const prevActive = prev ? true : await dayActivity(this.db, companyId, branchId, previousDate);
      const row = prev ? { status: prev.status, businessDate: previousDate } : null;
      previousDay = { businessDate: previousDate, standing: standingOf(row, today, prevActive, previousDate), needsReview: previousDayNeedsReview(row, prevActive) };
    }
    const window = dayWindowOf(day, timezone);
    const report = assembleReport({
      date: day,
      today,
      timezone,
      window,
      standing,
      sales,
      returns,
      cancellations,
      collected,
      channels,
      splits,
      expenses,
      expenseReversals,
      counts,
      opening,
      pending,
      openDiscrepancies: discrepancies,
      previousDay,
      closeKind: closeKindOf(closing),
    });
    const invariantFailures = reportInvariants(report, channels, splits, cancellations.ofTheseSales);
    if (invariantFailures.length > 0) {
      this.logger.error(`Daily closing report for ${day} does not reconcile: ${invariantFailures.join('; ')}`);
    }
    return { report, version: reportVersion(report), invariantFailures, channels, closing, opening };
  }

  // ── Reopening ───────────────────────────────────────────────────────────

  /**
   * Reopen the current business day, or — the Owner alone, before 06:00 —
   * start the next one now (docs/50 §3.2).
   */
  async reopen(dto: ReopenClosingDto) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.userId() ?? null;
    const now = new Date();
    const described = await this.businessDay.describe(branchId, now);
    const day = this.requireDate(dto.date, described.businessDate);
    const mode = dto.mode ?? 'continue';

    if (mode === 'start_new') {
      this.requireEarlyStartAuthority();
      // Already started early: a retry or a second tap changes nothing.
      if (described.startedEarly) return this.businessDayView();
      if (day !== described.businessDate) {
        throw new BadRequestException('Only the current business day can be ended early');
      }
      this.assertBeforeDayStart(described.canStartEarly);
      await this.startNextDayEarly({ companyId, branchId, userId, now, day });
      return this.businessDayView();
    }

    const row = await this.db.dailyClosing.findUnique({
      where: { branchId_closingDate: { branchId, closingDate: dateValue(day) } },
    });
    const verdict = canReopen(row ? { status: row.status, businessDate: day } : null, described.businessDate);
    if (!verdict.ok) {
      throw new ConflictException({
        code: `reopen_${verdict.why}`,
        message:
          verdict.why === 'not_closed'
            ? `Day ${day} is not closed`
            : verdict.why === 'past_day'
              ? `Day ${day} is behind the business day boundary; correct it through a financial correction`
              : `Day ${day} has not begun`,
      });
    }
    const closing = row!;
    const n = closing.reopenCount + 1;
    const eventId = newUuidV7Bin();
    await this.db.$transaction(async (tx) => {
      const won = await tx.dailyClosing.updateMany({
        where: { id: closing.id, status: 'locked', version: closing.version },
        data: {
          status: 'reopened',
          isLocked: false,
          reopenedAt: now,
          reopenedById: userId,
          reopenCount: n,
          version: { increment: 1 },
        },
      });
      if (won.count === 0) throw new ConflictException('refresh_required: this day changed while you were reopening it');
      await tx.closingEvent.create({
        data: {
          id: eventId,
          companyId,
          branchId,
          businessDate: dateValue(day),
          closingId: closing.id,
          kind: 'reopened',
          at: now,
          actorId: userId,
          dedupeKey: `closing:${closing.id.toString('hex')}:reopened:${n}`,
          payload: { mode: 'continue', automatic: false, reopenCount: n } as Prisma.InputJsonValue,
        },
      });
      await this.audit.recordTx(tx, {
        entityType: 'DailyClosing',
        entityId: closing.id,
        action: 'status_change',
        reason: 'reopened',
        after: { day, reopenCount: n, firstClosedAt: closing.firstClosedAt?.toISOString() ?? null },
        branchId,
      });
    });

    void this.tellOwner(companyId, branchId, day, eventId, (ctx) =>
      reopenedNotice(ctx, { closingIdHex: closing.id.toString('hex'), reopenCount: n, at: now, mode: 'continue', automatic: false }),
    );
    return this.openView(day);
  }

  private requireEarlyStartAuthority(): void {
    if (!(this.cls.get('permissions')?.has('closing.start_early') ?? false)) {
      throw new ForbiddenException('Only the Owner may start the next business day early');
    }
  }

  private assertBeforeDayStart(canStartEarly: boolean): void {
    if (!canStartEarly) {
      throw new ConflictException({
        code: 'not_before_day_start',
        message: 'The next business day can only be started between midnight and 06:00',
      });
    }
  }

  /**
   * The Owner's early start (docs/50 §3.2): a `day_started_early` event for the
   * date after `day`, from which every new record carries that date. Nothing
   * already recorded moves. Idempotent — a retry or a second tap finds the
   * event already there, and the intent is satisfied.
   */
  private async startNextDayEarly(args: { companyId: Buffer; branchId: Buffer; userId: Buffer | null; now: Date; day: string }): Promise<string> {
    const { companyId, branchId, userId, now, day } = args;
    const next = shiftDate(day, 1);
    try {
      await this.db.closingEvent.create({
        data: {
          id: newUuidV7Bin(),
          companyId,
          branchId,
          businessDate: dateValue(next),
          closingId: null,
          kind: 'day_started_early',
          at: now,
          actorId: userId,
          dedupeKey: `early:${branchId.toString('hex')}:${next}`,
          payload: { previousDate: day, startedAt: now.toISOString() } as Prisma.InputJsonValue,
        },
      });
      await this.audit.record({
        entityType: 'BusinessDay',
        entityId: branchId,
        action: 'create',
        reason: 'day_started_early',
        after: { businessDate: next, previousDate: day, at: now.toISOString() },
        branchId,
      });
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    }
    return next;
  }

  /**
   * "Open the boutique" (docs/50 §6, 0077): the physical opening — an explicit,
   * dated, attributed event that the 06:00 boundary never invents. Recorded by
   * whoever opens, under the counting permission. A closed day is not opened
   * but reopened, with the closing authority, so that is refused and named.
   *
   * Before 06:00 the business date is still the previous calendar day, and the
   * opening says which day was chosen (docs/56): `continue` opens that day —
   * the default, and all anybody but the Owner can do; `start_new` first starts
   * the next business date (the Owner's early start, same event as a reopen's)
   * and then opens it. Both leave every record already written where it is.
   */
  async open(dto: OpenDayDto) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.userId() ?? null;
    const now = new Date();
    let described = await this.businessDay.describe(branchId, now);
    const mode = dto.mode ?? 'continue';
    /** The store's calendar date has moved on but its business date has not: the moment a choice exists. */
    const beforeDayStart = described.localDate !== described.businessDate;
    if (mode === 'start_new') {
      this.requireEarlyStartAuthority();
      if (!described.startedEarly) {
        // The day named, if any, is the one being left behind.
        const leaving = this.requireDate(dto.date, described.businessDate);
        if (leaving !== described.businessDate) throw new BadRequestException('Only the current business day can be ended early');
        this.assertBeforeDayStart(described.canStartEarly);
        await this.startNextDayEarly({ companyId, branchId, userId, now, day: leaving });
        described = await this.businessDay.describe(branchId, now);
      }
    }
    const day = mode === 'start_new' ? described.businessDate : this.requireDate(dto.date, described.businessDate);
    /** Recorded only when the person actually chose between two days, so a plain opening never claims a choice. */
    const choice = mode === 'start_new' || beforeDayStart ? mode : null;
    const dayDate = dateValue(day);
    const [row, events] = await Promise.all([
      this.db.dailyClosing.findUnique({
        where: { branchId_closingDate: { branchId, closingDate: dayDate } },
        select: { id: true, status: true },
      }),
      this.db.closingEvent.findMany({ where: { branchId, businessDate: dayDate }, orderBy: { at: 'asc' }, select: { kind: true } }),
    ]);
    const verdict = canOpen(row ? { status: row.status, businessDate: day } : null, doorState(events), day, described.businessDate);
    if (!verdict.ok) {
      throw new ConflictException({
        code: `open_${verdict.why}`,
        message:
          verdict.why === 'already_open'
            ? `Day ${day} is already open`
            : verdict.why === 'day_closed'
              ? `Day ${day} is closed — reopening it needs the closing authority`
              : verdict.why === 'past_day'
                ? `Day ${day} is behind the business day boundary; only the current day can be opened`
                : `Day ${day} has not begun`,
      });
    }
    const n = events.filter((e) => e.kind === 'opened').length + 1;
    try {
      await this.db.closingEvent.create({
        data: {
          id: newUuidV7Bin(),
          companyId,
          branchId,
          businessDate: dayDate,
          closingId: row?.id ?? null,
          kind: 'opened',
          at: now,
          actorId: userId,
          dedupeKey: `closing:open:${branchId.toString('hex')}:${day}:${n}`,
          payload: {
            openedAt: now.toISOString(),
            localTime: localTimeOf(now, described.timezone),
            nth: n,
            ...(choice ? { choice, calendarDate: described.localDate } : {}),
          } as Prisma.InputJsonValue,
        },
      });
      await this.audit.record({
        entityType: 'BusinessDay',
        entityId: branchId,
        action: 'create',
        reason: 'opened',
        after: { businessDate: day, at: now.toISOString(), nth: n, ...(choice ? { choice, calendarDate: described.localDate } : {}) },
        branchId,
      });
    } catch (e) {
      // Two taps at once: the first opened the boutique; the second changes nothing.
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    }
    return this.openView(day);
  }

  /**
   * A sale after the close reopens the day by itself, inside the sale's own
   * transaction (docs/50 §3.2). Never refuses: a close is a counted snapshot
   * and a history event, not a lock on selling. The notices go out after the
   * caller commits, through `afterSaleCommitted`.
   */
  async autoReopenTx(
    tx: Pick<TenantPrisma, 'auditLog' | 'dailyClosing' | 'closingEvent' | '$queryRaw'>,
    args: { branchId: Buffer; businessDate: string; cause: { kind: 'sale' | 'payment' | 'purchase'; id: Buffer } },
  ): Promise<AutoReopenResult> {
    const companyId = this.tenant.companyId();
    const dayDate = dateValue(args.businessDate);
    /**
     * The same row lock the close takes (docs/51 §12.6). A close holding it makes
     * this wait, then see the day locked and reopen it; this holding it makes the
     * close wait, then see the movement and refuse with the fresh report. Either
     * way the money is in exactly one snapshot or in the reopened day — never lost
     * in a day that locked without it.
     */
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM daily_closings
       WHERE company_id = ${companyId} AND branch_id = ${args.branchId} AND closing_date = ${args.businessDate}
       FOR UPDATE`);
    const row = await tx.dailyClosing.findUnique({
      where: { branchId_closingDate: { branchId: args.branchId, closingDate: dayDate } },
    });
    if (!row) return { reopened: false, closingId: null, reopenCount: 0, at: null };
    if (row.status !== 'locked') return { reopened: false, closingId: row.id, reopenCount: row.reopenCount, at: row.reopenedAt };
    const now = new Date();
    const n = row.reopenCount + 1;
    const userId = this.tenant.userId() ?? null;
    await tx.dailyClosing.update({
      where: { id: row.id },
      data: { status: 'reopened', isLocked: false, reopenedAt: now, reopenedById: userId, reopenCount: n, version: { increment: 1 } },
    });
    await tx.closingEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId,
        branchId: args.branchId,
        businessDate: dayDate,
        closingId: row.id,
        kind: 'auto_reopened',
        at: now,
        actorId: userId,
        dedupeKey: `closing:${row.id.toString('hex')}:reopened:${n}`,
        payload: { mode: 'continue', automatic: true, cause: args.cause.kind, causeId: binToUuid(args.cause.id), reopenCount: n } as Prisma.InputJsonValue,
      },
    });
    await this.audit.recordTx(tx, {
      entityType: 'DailyClosing',
      entityId: row.id,
      action: 'status_change',
      reason: `auto_reopened_by_${args.cause.kind}`,
      after: { day: args.businessDate, reopenCount: n, cause: args.cause.kind, causeId: binToUuid(args.cause.id) },
      branchId: args.branchId,
    });
    return { reopened: true, closingId: row.id, reopenCount: n, at: now };
  }

  /**
   * The Owner notices for a sale made after a counted close: the reopen this
   * sale caused, if it did, then the sale itself. Fire-and-forget; never throws.
   */
  async afterSaleCommitted(saleId: Buffer, reopen: AutoReopenResult): Promise<void> {
    try {
      const companyId = this.tenant.companyId();
      const sale = await this.db.sale.findUnique({
        where: { id: saleId },
        select: {
          id: true,
          branchId: true,
          soldAt: true,
          businessDate: true,
          total: true,
          amountPaid: true,
          balanceDue: true,
          items: {
            where: { voided: false },
            select: {
              quantity: true,
              product: { select: { brand: true, model: true } },
              unit: { select: { product: { select: { brand: true, model: true } } } },
            },
          },
        },
      });
      if (!sale) return;
      const day = dateKey(sale.businessDate);
      const closing = await this.db.dailyClosing.findUnique({
        where: { branchId_closingDate: { branchId: sale.branchId, closingDate: sale.businessDate } },
        select: { id: true, status: true, firstClosedAt: true, reopenCount: true },
      });
      // Only a day that was counted-closed and is open again is worth a notice.
      if (!closing || closing.status !== 'reopened' || !closing.firstClosedAt || sale.soldAt < closing.firstClosedAt) return;

      if (reopen.reopened) {
        await this.tellOwner(companyId, sale.branchId, day, null, (ctx) =>
          reopenedNotice(ctx, {
            closingIdHex: closing.id.toString('hex'),
            reopenCount: reopen.reopenCount,
            at: reopen.at ?? new Date(),
            mode: 'continue',
            automatic: true,
          }),
        );
      }
      const first = sale.items[0];
      const product = first?.product ?? first?.unit?.product ?? null;
      await this.tellOwner(companyId, sale.branchId, day, null, (ctx) =>
        saleNotice(ctx, {
          saleIdHex: sale.id.toString('hex'),
          soldAt: sale.soldAt,
          total: num(sale.total),
          amountPaid: num(sale.amountPaid),
          balanceDue: num(sale.balanceDue),
          itemLabel: product ? `${product.brand} ${product.model}`.trim() : 'Sale',
          itemCount: sale.items.reduce((n, it) => n + it.quantity, 0),
        }),
      );
    } catch (e) {
      this.logger.warn(`Post-sale closing notices skipped for ${binToUuid(saleId)}: ${(e as Error).message}`);
    }
  }

  /** A later payment that reopened the day: the Owner is told about the reopen alone. Never throws. */
  async afterReopenCommitted(branchId: Buffer, businessDate: string, reopen: AutoReopenResult): Promise<void> {
    if (!reopen.reopened || !reopen.closingId) return;
    const companyId = this.tenant.companyId();
    const closingIdHex = reopen.closingId.toString('hex');
    await this.tellOwner(companyId, branchId, businessDate, null, (ctx) =>
      reopenedNotice(ctx, { closingIdHex, reopenCount: reopen.reopenCount, at: reopen.at ?? new Date(), mode: 'continue', automatic: true }),
    );
  }

  /** Build a notice in the Owner's language and deliver it; record the outcome on the event when there is one. */
  private async tellOwner(
    companyId: Buffer,
    branchId: Buffer,
    businessDate: string,
    eventId: Buffer | null,
    build: (ctx: Awaited<ReturnType<ClosingNoticeService['context']>>) => Notice,
  ): Promise<NoticeOutcome | null> {
    try {
      const ctx = { ...(await this.notices.context(companyId, branchId)), businessDate };
      const notice = build(ctx);
      notice.payload.language = ctx.language;
      const outcome = await this.notices.deliver(companyId, branchId, notice);
      if (eventId) {
        const row = await this.db.closingEvent.findUnique({ where: { id: eventId }, select: { payload: true } });
        const payload = (row?.payload && typeof row.payload === 'object' ? row.payload : {}) as Record<string, unknown>;
        await this.db.closingEvent.update({
          where: { id: eventId },
          data: { payload: { ...payload, notice: { ...outcome, template: notice.template } } as Prisma.InputJsonValue },
        });
      }
      return outcome;
    } catch (e) {
      this.logger.warn(`Owner notice for ${businessDate} not delivered: ${(e as Error).message}`);
      return null;
    }
  }

  // ── Reads ───────────────────────────────────────────────────────────────

  async getClosing(date: string) {
    const branchId = this.tenant.requireBranchId();
    if (!isDateString(date)) throw new BadRequestException('date must be YYYY-MM-DD');
    const closing = await this.db.dailyClosing.findUnique({
      where: { branchId_closingDate: { branchId, closingDate: dateValue(date) } },
    });
    if (!closing) throw new NotFoundException(`No closing for ${date}`);
    return closing;
  }

  async getDigest(date: string) {
    const branchId = this.tenant.requireBranchId();
    if (!isDateString(date)) throw new BadRequestException('date must be YYYY-MM-DD');
    const dayDate = dateValue(date);
    const digest = await this.db.dailyDigest.findUnique({
      where: { branchId_digestDate: { branchId, digestDate: dayDate } },
      include: { lines: true },
    });
    if (!digest) throw new NotFoundException(`No digest for ${date}`);
    const rollup = await this.db.dailyRollup.findUnique({ where: { branchId_day: { branchId, day: dayDate } } });
    return {
      date,
      revenue: round2(num(digest.revenue)),
      costOfGoodsSold: round2(num(digest.costOfGoodsSold)),
      grossProfit: round2(num(digest.grossProfit)),
      expenses: round2(num(rollup?.expenses ?? 0)),
      netProfit: round2(num(rollup?.netProfit ?? 0)),
      lines: digest.lines.map((l) => ({
        identifier: l.identifier,
        productLabel: l.productLabel,
        salePrice: num(l.salePrice),
        purchaseCost: num(l.purchaseCost),
        profit: num(l.profit),
        soldAt: l.soldAt,
        employeeId: l.employeeId ? binToUuid(l.employeeId) : null,
      })),
      comparison: await this.historicalComparison(branchId, dayDate),
    };
  }

  /**
   * Recorded money movement per channel over an inclusive range of business
   * dates — the closing's own movement query, so Money and the closing cannot
   * disagree. No opening balance here: a period's "net" is what moved.
   */
  async periodMovements(from: string, to: string) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    if (!isDateString(from) || !isDateString(to) || from > to) {
      throw new BadRequestException('from and to must be YYYY-MM-DD, with from on or before to');
    }
    const channels = await this.expectedChannels(companyId, branchId, from, to);
    return {
      from,
      to,
      channels: channels.map((ch) => ({
        channel: ch.channel,
        accountId: ch.accountId,
        label: ch.labelSnapshot,
        isUnattributed: ch.isUnattributed,
        moneyIn: round2(ch.salesIn + ch.correctionsIn),
        moneyOut: round2(ch.refundsOut + ch.supplierOut + ch.expensesOut + ch.correctionsOut),
        net: ch.expected,
      })),
    };
  }

  /**
   * The Money screen in one read (0074): cash in the drawer now (the closing's
   * own expected figure for the current business day, opening balance
   * included), what moved through each account today, the period's sales by
   * their business date, collected by the date the money arrived, and today's
   * expenses.
   */
  async overview(from: string, to: string) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    if (!isDateString(from) || !isDateString(to) || from > to) {
      throw new BadRequestException('from and to must be YYYY-MM-DD, with from on or before to');
    }
    const today = await this.businessDay.today(branchId);
    const range = { gte: dateValue(from), lte: dateValue(to) };
    const openingToday = await this.openingCash(companyId, branchId, today);

    const todayDate = dateValue(today);
    const [todayChannels, periodChannels, sales, dated, owedAll, expenses, reversals] = await Promise.all([
      this.expectedChannels(companyId, branchId, today, today, openingToday),
      this.expectedChannels(companyId, branchId, from, to),
      this.db.sale.aggregate({
        where: { branchId, isReversed: false, businessDate: range },
        _sum: { balanceDue: true },
      }),
      // Invoices, cancellations and returns, each on the date that carries it (docs/53 D29).
      periodFigures(this.db, companyId, branchId, from, to),
      this.db.sale.aggregate({
        where: { branchId, isReversed: false, balanceDue: { gt: 0 } },
        _sum: { balanceDue: true },
        _count: true,
      }),
      // Today's expenses by the Daily closing's rule: a variable one on its confirmation date, a fixed one on its due date.
      this.db.expense.findMany({
        where: {
          branchId,
          status: 'confirmed',
          OR: [
            { expenseClass: 'variable', confirmationDate: todayDate },
            { expenseClass: 'fixed', dueDate: todayDate },
          ],
        },
        select: {
          id: true,
          category: true,
          amount: true,
          method: true,
          accountLabelSnapshot: true,
          reference: true,
          receiptKey: true,
          confirmedAt: true,
        },
        orderBy: { confirmedAt: 'desc' },
      }),
      // And each reversal approved today, as its own negative row.
      this.db.financialCorrection.findMany({
        where: { branchId, targetKind: 'expense', status: 'approved', correctionDate: todayDate },
        select: {
          id: true,
          amount: true,
          method: true,
          accountLabelSnapshot: true,
          decidedAt: true,
          targetExpense: { select: { id: true, category: true } },
        },
        orderBy: { decidedAt: 'desc' },
      }),
    ]);

    const cash = todayChannels.find((c) => c.channel === 'cash');
    const collected = periodChannels.reduce((n, c) => n + c.salesIn, 0);
    const refunds = periodChannels.reduce((n, c) => n + c.refundsOut, 0);

    return {
      from,
      to,
      today,
      cashNow: round2(cash?.expected ?? 0),
      cashOpening: round2(cash?.openingBalance ?? 0),
      accountsToday: todayChannels
        .filter((c) => c.channel !== 'cash')
        .map((c) => ({
          accountId: c.accountId,
          label: c.labelSnapshot,
          isUnattributed: c.isUnattributed,
          moneyIn: round2(c.salesIn + c.correctionsIn),
          moneyOut: round2(c.refundsOut + c.supplierOut + c.expensesOut + c.correctionsOut),
          net: c.expected,
        })),
      period: {
        /** Phones on the invoices less phones on cancelled invoices (docs/53 R6); returned phones are `returns.phones`. */
        phonesSold: dated.net.phones,
        /** Every item on the invoices less items on cancelled invoices (R6) — what "Items sold" shows; returned items are `returns.count`. */
        unitsSold: dated.net.units,
        /** Invoices less whole-sale cancellations (R5); returns are counted apart. */
        salesCount: dated.net.salesCount,
        /** The invoices of the period, on their sale dates. */
        salesValue: dated.invoices.value,
        /** Cancellations and returns approved in the period, on their own dates — negative adjustments to the value above. */
        cancellations: { count: dated.cancellations.count, value: dated.cancellations.value, phones: dated.cancellations.phones },
        returns: { count: dated.returns.count, value: dated.returns.value, phones: dated.returns.phones },
        /** cancellations + returns: what comes off the value above — given, so the phone adds nothing up. */
        adjusted: Math.round((dated.cancellations.value + dated.returns.value) * 100) / 100,
        /** value − returns − cancellations: the Daily closing's net sales over the period. */
        netSalesValue: dated.net.salesValue,
        collected: round2(collected),
        outstanding: round2(num(sales._sum.balanceDue)),
        /** Refunds CONFIRMED in the period — money leaving on the confirmation date, no profit effect. */
        refunds: round2(refunds),
      },
      outstandingAll: { amount: round2(num(owedAll._sum.balanceDue)), sales: owedAll._count },
      expensesToday: expensesTodayOf(expenses, reversals),
    };
  }

  /**
   * The business day as it stands right now (E-CP1, extended in 0076): the
   * live per-channel figures, where the day is in its lifecycle, whether a
   * reopen is possible and with which choices, and the day's history — every
   * count, close and reopen, and each sale made after the first close.
   */
  async openView(date?: string) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const now = new Date();
    const described = await this.businessDay.describe(branchId, now);
    const today = described.businessDate;
    const day = this.requireDate(date, today);
    const dayDate = dateValue(day);

    const closing = await this.db.dailyClosing.findUnique({
      where: { branchId_closingDate: { branchId, closingDate: dayDate } },
      include: { channelCounts: { include: { countedBy: { select: { name: true } } } }, closedBy: { select: { name: true } } },
    });
    const openingCash = await this.openingCash(companyId, branchId, day);
    const channels = await this.expectedChannels(companyId, branchId, day, day, openingCash);
    const recorded = new Map<string, RecordedCount>(
      (closing?.channelCounts ?? []).map((c) => [
        keyOf({ channel: c.channel, accountId: c.receivingAccountId ? binToUuid(c.receivingAccountId) : null }),
        c,
      ]),
    );

    const rows = channels.map((ch) => {
      const saved = recorded.get(keyOf(ch));
      const counted = saved?.counted == null ? null : round2(num(saved.counted));
      return {
        ...ch,
        countable: isCountable(ch),
        counted,
        // Recomputed against the CURRENT expected figure: while the day is
        // open the expected figure still moves, so a stored difference is stale.
        difference: counted == null ? null : round2(counted - ch.expected),
        isSkipped: saved?.isSkipped ?? false,
        skipReason: saved?.skipReason ?? null,
        countedAt: saved?.countedAt ?? null,
        /** True when this count predates the reopen and must be taken again. */
        stale: !!(closing?.status === 'reopened' && saved && saved.countedAt && closing.reopenedAt && saved.countedAt < closing.reopenedAt),
      };
    });

    const fresh = freshCounts(
      rows.map((r) => ({ key: keyOf(r), countable: r.countable, counted: r.counted, isSkipped: r.isSkipped, countedAt: r.countedAt })),
      closing?.status === 'reopened' ? closing.reopenedAt : null,
    );
    const cashRow = rows.find((r) => r.channel === 'cash');
    const savedCash = recorded.get('cash:NONE');
    // A day behind the boundary with no closing row needs review if anything happened on it, and is inactive if nothing did (D8).
    const active = closing ? true : day < today ? await dayActivity(this.db, companyId, branchId, day) : true;
    const standing: DayStanding = standingOf(closing ? { status: closing.status, businessDate: day } : null, today, active, day);
    const reopenVerdict = canReopen(closing ? { status: closing.status, businessDate: day } : null, today);
    const mayStartEarly = this.cls.get('permissions')?.has('closing.start_early') ?? false;
    const timeline = await this.timeline(branchId, dayDate, described.timezone, closing);
    const openVerdict = canOpen(closing ? { status: closing.status, businessDate: day } : null, timeline.door, day, today);

    return {
      date: day,
      businessDate: day,
      today,
      timezone: described.timezone,
      standing,
      status: closing?.status ?? 'counting',
      isLocked: closing?.isLocked ?? false,
      channels: rows,
      outstanding: rows.filter((r) => r.countable && r.counted === null && !r.isSkipped).length,
      complete: countingComplete(rows) && fresh.complete,
      freshCountRequired: closing?.status === 'reopened' && !fresh.complete,
      stale: fresh.stale,
      expectedCash: round2(cashRow?.expected ?? 0),
      openingCash,
      /** Movement since the last cash count: today's expected minus what it was when counted. */
      sinceLastCount: savedCash?.counted != null ? round2((cashRow?.expected ?? 0) - num(savedCash.expected)) : null,
      lastCountedAt: closing?.countedAt ?? null,
      lastCountedLocalTime: closing?.countedAt ? localTimeOf(closing.countedAt, described.timezone) : null,
      firstClosedAt: closing?.firstClosedAt ?? null,
      closedAt: closing?.status === 'locked' ? closing.closedAt : null,
      reopenedAt: closing?.status === 'reopened' ? closing.reopenedAt : null,
      reopenCount: closing?.reopenCount ?? 0,
      canReopen: reopenVerdict.ok,
      reopenRefusal: reopenVerdict.ok ? null : reopenVerdict.why,
      reopenChoices: reopenChoices(described.canStartEarly && day === today, mayStartEarly),
      /** What "Open the boutique" may choose (docs/56): the same two days, under the same rule, before the opening is recorded. */
      openChoices: openChoices(described.canStartEarly && day === today, mayStartEarly),
      nextDate: shiftDate(day, 1),
      history: timeline.rows,
      /** Whether the boutique is physically open on this date, from its recorded openings and closes (0077). */
      door: timeline.door,
      /** The latest recorded opening of the date — explicit or a reopen — or null: "No opening time recorded". */
      opening: timeline.opening,
      canOpen: openVerdict.ok,
      openRefusal: openVerdict.ok ? null : openVerdict.why,
      /** The store's wall clock now — what a sheet shows as "at 07:25", never the phone's clock. */
      localNow: localTimeOf(now, described.timezone),
      localNowDate: localParts(now, described.timezone).date,
      previousDay:
        day === today
          ? await (async () => {
              const previousDate = shiftDate(today, -1);
              const prev = await this.db.dailyClosing.findUnique({
                where: { branchId_closingDate: { branchId, closingDate: dateValue(previousDate) } },
                select: { status: true },
              });
              const row = prev ? { status: prev.status, businessDate: previousDate } : null;
              const prevActive = prev ? true : await dayActivity(this.db, companyId, branchId, previousDate);
              return {
                businessDate: previousDate,
                standing: standingOf(row, today, prevActive, previousDate),
                needsReview: previousDayNeedsReview(row, prevActive),
              };
            })()
          : null,
    };
  }

  /**
   * The day's timeline (docs/50 §6): every event, the first sale as "First
   * activity", and — after the first close — each sale made since, in time
   * order, each with its store-local date and time. A day closed before the
   * timeline existed has no events, so its closing row and channel counts are
   * read back as the events they were; nothing recorded is ever dropped.
   */
  private async timeline(branchId: Buffer, dayDate: Date, timezone: string, closing: TimelineClosing | null) {
    const events = await this.db.closingEvent.findMany({
      where: { branchId, businessDate: dayDate },
      orderBy: { at: 'asc' },
      select: { id: true, kind: true, at: true, payload: true, actor: { select: { name: true } } },
    });
    const saleSelect = {
      id: true,
      soldAt: true,
      total: true,
      amountPaid: true,
      balanceDue: true,
      user: { select: { name: true } },
      payments: { select: { method: true, amount: true } },
      items: {
        where: { voided: false },
        select: {
          quantity: true,
          product: { select: { brand: true, model: true } },
          unit: { select: { product: { select: { brand: true, model: true } } } },
        },
      },
    } satisfies Prisma.SaleSelect;
    const firstSale = await this.db.sale.findFirst({
      where: { branchId, businessDate: dayDate, isReversed: false },
      orderBy: { soldAt: 'asc' },
      select: saleSelect,
    });
    const firstClosedAt = closing?.firstClosedAt ?? null;
    const later = firstClosedAt
      ? await this.db.sale.findMany({
          where: {
            branchId,
            businessDate: dayDate,
            isReversed: false,
            soldAt: { gte: firstClosedAt },
            ...(firstSale ? { id: { not: firstSale.id } } : {}),
          },
          orderBy: { soldAt: 'asc' },
          select: saleSelect,
        })
      : [];
    type SaleRow = NonNullable<typeof firstSale>;
    const salePayload = (s: SaleRow): Record<string, unknown> => {
      const first = s.items[0];
      const product = first?.product ?? first?.unit?.product ?? null;
      return {
        saleId: binToUuid(s.id),
        item: product ? `${product.brand} ${product.model}`.trim() : null,
        itemCount: s.items.reduce((n, it) => n + it.quantity, 0),
        total: num(s.total),
        collected: num(s.amountPaid),
        owed: num(s.balanceDue),
        cashIn: round2(s.payments.filter((p) => p.method === 'cash').reduce((n, p) => n + num(p.amount), 0)),
      };
    };
    const rows: TimelineRow[] = [
      ...events.map((e) => ({
        kind: e.kind as string,
        at: e.at,
        actor: e.actor?.name ?? null,
        payload: timelinePayload(e.kind as string, e.payload),
      })),
      ...(firstSale ? [{ kind: 'first_activity', at: firstSale.soldAt, actor: firstSale.user?.name ?? null, payload: salePayload(firstSale) }] : []),
      ...later.map((sale) => ({ kind: 'sale', at: sale.soldAt, actor: sale.user?.name ?? null, payload: salePayload(sale) })),
    ];
    // A day closed before the timeline existed: its row and its counts, as the events they were.
    if (closing && closing.status === 'locked' && !events.some((e) => e.kind === 'closed' || e.kind === 'reclosed')) {
      rows.push({
        kind: 'closed',
        at: closing.closedAt,
        actor: closing.closedBy?.name ?? null,
        payload: { countedCash: num(closing.countedCash), difference: num(closing.difference), fromRow: true },
      });
    }
    if (closing && !events.some((e) => e.kind === 'count_saved')) {
      for (const c of closing.channelCounts) {
        if (!c.countedAt) continue;
        rows.push({
          kind: 'count_saved',
          at: c.countedAt,
          actor: c.countedBy?.name ?? null,
          payload: { label: c.labelSnapshot, counted: c.counted == null ? null : num(c.counted), skipped: c.isSkipped, fromRow: true },
        });
      }
    }
    rows.sort((a, b) => a.at.getTime() - b.at.getTime());
    const opening = openingOf(events);
    return {
      rows: rows.map((r) => ({ ...r, localDate: localParts(r.at, timezone).date, localTime: localTimeOf(r.at, timezone) })),
      door: doorState(events),
      opening: opening
        ? {
            kind: opening.kind as string,
            at: opening.at,
            actor: opening.actor?.name ?? null,
            localDate: localParts(opening.at, timezone).date,
            localTime: localTimeOf(opening.at, timezone),
          }
        : null,
    };
  }

  /** Sales and cash taken since an instant within a business day — the reclose's "since the first count". */
  private async movementSince(branchId: Buffer, dayDate: Date, since: Date) {
    const [sales, cash] = await Promise.all([
      this.db.sale.aggregate({
        where: { branchId, businessDate: dayDate, isReversed: false, soldAt: { gte: since } },
        _sum: { total: true },
        _count: true,
      }),
      this.db.payment.aggregate({
        where: { method: 'cash', businessDate: dayDate, paidAt: { gte: since }, sale: { branchId } },
        _sum: { amount: true },
      }),
    ]);
    return { salesCount: sales._count, salesValue: round2(num(sales._sum.total)), cashIn: round2(num(cash._sum.amount)) };
  }

  /**
   * Record one channel's count (E-CP1) — the `closing.count` path. The day
   * stays open and fully correctable until somebody with `closing.perform`
   * signs it off. On a reopened day the count is the fresh one the reclose
   * needs (0076).
   */
  async recordCount(dto: RecordCountDto) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const today = await this.businessDay.today(branchId);
    const day = this.requireDate(dto.date, today);
    const dayDate = dateValue(day);
    const now = new Date();

    if (dto.skip) {
      if (dto.counted != null) {
        throw new BadRequestException('A channel is either counted or skipped, never both');
      }
      if (!dto.skipReason?.trim()) {
        throw new BadRequestException('Skipping a channel requires a reason');
      }
    } else if (dto.counted == null) {
      throw new BadRequestException('Provide a counted amount, or skip the channel with a reason');
    }
    if (dto.channel === 'account' && !dto.accountId) {
      throw new BadRequestException('An account channel must say which account');
    }
    if (dto.channel === 'cash' && dto.accountId) {
      throw new BadRequestException('Cash belongs to no account');
    }

    const existing = await this.db.dailyClosing.findUnique({
      where: { branchId_closingDate: { branchId, closingDate: dayDate } },
    });
    /**
     * A locked day is signed off. Reopening it is an explicit act (0076) or a
     * sale's; a count does neither, so it is refused until then.
     */
    if (existing?.status === 'locked') {
      throw new ConflictException(`Day ${day} is already closed for this branch`);
    }

    const openingCash = await this.openingCash(companyId, branchId, day);
    const channels = await this.expectedChannels(companyId, branchId, day, day, openingCash);
    const target = channels.find(
      (c) => c.channel === dto.channel && (c.accountId ?? null) === (dto.accountId ?? null),
    );
    if (!target) {
      throw new NotFoundException('That channel is not part of this day at this branch');
    }
    if (!isCountable(target)) {
      throw new BadRequestException('Unattributed money has no balance to count against');
    }

    if (dto.channel === 'cash' && dto.counted != null && dto.counted < 0) {
      throw new BadRequestException('A drawer cannot hold less than nothing');
    }
    const counted = dto.counted == null ? null : round2(dto.counted);
    const difference = counted == null ? null : round2(counted - target.expected);
    const userId = this.tenant.userId() ?? null;

    const closingId = existing
      ? existing.id
      : await this.db.dailyClosing
          .create({
            data: {
              id: newUuidV7Bin(),
              companyId,
              branchId,
              closingDate: dayDate,
              // Nothing is counted until somebody counts (0078): NULL, never a placeholder zero.
              expectedCash: 0,
              countedCash: null,
              difference: null,
              totalSales: 0,
              totalProfit: 0,
              status: 'counting',
              isLocked: false,
            },
          })
          .then((c) => c.id);

    const accountBin = dto.accountId ? uuidToBin(dto.accountId) : null;
    const prior = await this.db.closingChannelCount.findFirst({
      where: { closingId, channel: dto.channel, receivingAccountId: accountBin },
    });

    const payload = {
      labelSnapshot: target.labelSnapshot,
      salesIn: target.salesIn,
      refundsOut: target.refundsOut,
      supplierOut: target.supplierOut,
      expensesOut: target.expensesOut,
      correctionsIn: target.correctionsIn,
      correctionsOut: target.correctionsOut,
      openingBalance: target.openingBalance,
      expected: target.expected,
      counted,
      difference,
      isSkipped: dto.skip ?? false,
      skipReason: dto.skip ? (dto.skipReason?.trim() ?? null) : null,
      countedById: userId,
      countedAt: now,
    };

    if (prior) {
      await this.db.closingChannelCount.update({ where: { id: prior.id }, data: payload });
    } else {
      await this.db.closingChannelCount.create({
        data: {
          id: newUuidV7Bin(),
          companyId,
          closingId,
          channel: dto.channel,
          receivingAccountId: accountBin,
          ...payload,
        },
      });
    }

    /**
     * `counted` once nothing countable is outstanding — a signal to whoever
     * signs the day off, never a lock. A reopened day stays `reopened` until it
     * is closed again; only `counting` moves forward here.
     */
    const view = await this.openView(day);
    const nextStatus = existing?.status === 'reopened' ? 'reopened' : view.complete ? 'counted' : 'counting';
    await this.db.dailyClosing.update({
      where: { id: closingId },
      data: {
        status: nextStatus,
        countedById: userId,
        countedAt: now,
        version: { increment: 1 },
      },
    });

    await this.db.closingEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId,
        branchId,
        businessDate: dayDate,
        closingId,
        kind: 'count_saved',
        at: now,
        actorId: userId,
        payload: {
          channel: dto.channel,
          accountId: dto.accountId ?? null,
          label: target.labelSnapshot,
          counted,
          expected: target.expected,
          difference,
          skipped: dto.skip ?? false,
        } as Prisma.InputJsonValue,
      },
    });

    await this.audit.record({
      entityType: 'ClosingChannelCount',
      entityId: closingId,
      action: prior ? 'update' : 'create',
      after: {
        day,
        channel: dto.channel,
        account: dto.accountId ?? null,
        counted,
        expected: target.expected,
        difference,
        skipped: dto.skip ?? false,
      },
      branchId,
    });

    return { ...(await this.openView(day)), status: nextStatus };
  }

  // --- helpers --------------------------------------------------------------

  /**
   * Every channel this branch has to account for, with the components behind
   * each expected figure. Reads the movements, then hands the rules to the pure
   * `buildChannels` — which decides membership and applies the SAME signs the
   * cash equation uses. There is one equation here, not two.
   */
  private async expectedChannels(
    companyId: Buffer,
    branchId: Buffer,
    fromDay: string,
    toDay: string,
    cashOpening = 0,
  ): Promise<ChannelRow[]> {
    const [movements, accounts] = await Promise.all([
      this.channelMovements(companyId, branchId, fromDay, toDay),
      this.db.receivingAccount.findMany({
        select: { id: true, label: true, isActive: true, sortOrder: true },
        orderBy: { sortOrder: 'asc' },
      }),
    ]);
    return buildChannels(
      movements,
      accounts.map((a) => ({
        id: binToUuid(a.id),
        label: a.label,
        isActive: a.isActive,
        sortOrder: a.sortOrder,
      })),
      cashOpening,
    );
  }

  /**
   * What the drawer held when a business day began (0076, D4).
   *
   * The counted cash at the most recent locked close whose drawer was actually
   * COUNTED, plus the net cash movement of every day between that close and this
   * one — the same movements the closing counts, over that range. A locked day
   * closed without a physical check anchors nothing: it is carried forward by its
   * recorded movement like an unclosed day. A shop that has never counted a
   * closed drawer starts from zero; the first counted close anchors the chain.
   */
  private async openingCash(companyId: Buffer, branchId: Buffer, day: string): Promise<number> {
    return (await this.openingCashDetail(companyId, branchId, day)).amount;
  }

  private async openingCashDetail(companyId: Buffer, branchId: Buffer, day: string): Promise<OpeningCash> {
    const last = await this.db.dailyClosing.findFirst({
      where: { branchId, status: 'locked', countedCash: { not: null }, closingDate: { lt: dateValue(day) } },
      orderBy: { closingDate: 'desc' },
      select: { closingDate: true, countedCash: true },
    });
    if (!last) return { amount: 0, anchorDate: null, anchorVerified: false, carriedDays: 0 };
    const lastDay = dateKey(last.closingDate);
    const from = shiftDate(lastDay, 1);
    const to = shiftDate(day, -1);
    if (from > to) return { amount: round2(num(last.countedCash)), anchorDate: lastDay, anchorVerified: true, carriedDays: 0 };
    const between = await this.expectedChannels(companyId, branchId, from, to);
    const cash = between.find((c) => c.channel === 'cash');
    const carriedDays = Math.round((dateValue(to).getTime() - dateValue(from).getTime()) / 86_400_000) + 1;
    return { amount: round2(num(last.countedCash) + (cash?.expected ?? 0)), anchorDate: lastDay, anchorVerified: true, carriedDays };
  }

  /**
   * Everything paid for stock at a branch on one business day, split total / cash:
   * confirmed supplier settlements (keyed on their confirmation day) and
   * purchase payments made at receipt (keyed on their stored business date).
   */
  private async stockPaidOn(branchId: Buffer, dayDate: Date) {
    const companyId = this.tenant.companyId();
    const rows = await this.db.$queryRaw<{ is_cash: number; total: Prisma.Decimal }[]>(Prisma.sql`
      SELECT (method = 'cash') AS is_cash, COALESCE(SUM(amount), 0) AS total
        FROM supplier_settlements
       WHERE company_id = ${companyId} AND branch_id = ${branchId}
         AND status = 'confirmed' AND confirmation_date = ${dayDate}
       GROUP BY (method = 'cash')
      UNION ALL
      SELECT (sp.method = 'cash') AS is_cash, COALESCE(SUM(sp.amount), 0) AS total
        FROM supplier_payments sp
        JOIN purchases p ON p.id = sp.purchase_id
       WHERE sp.company_id = ${companyId} AND p.branch_id = ${branchId}
         AND sp.business_date = ${dayDate}
       GROUP BY (sp.method = 'cash')`);
    const total = round2(rows.reduce((a, r) => a + num(r.total), 0));
    const cash = round2(rows.filter((r) => Number(r.is_cash) === 1).reduce((a, r) => a + num(r.total), 0));
    return { total, cash };
  }

  /**
   * The money movements of an inclusive range of business dates, split by the
   * channel each one actually used. Every part keys on a stored DATE column —
   * the business date a payment was assigned when it was written, or the
   * confirmation / correction / due date the other records already carried —
   * so a channel figure and the day's analytics cannot disagree about which
   * day a movement belongs to. Corrected payouts and settlements stay in their
   * own day's figures; the correction is a separate movement on its own day.
   */
  private async channelMovements(
    companyId: Buffer,
    branchId: Buffer,
    fromDay: string,
    toDay: string,
  ): Promise<MovementRow[]> {
    const rows = await this.db.$queryRaw<
      { channel: string; account_id: Buffer | null; component: string; amount: unknown }[]
    >(Prisma.sql`
      -- Money received from sales, dated by the business date the money arrived on.
      SELECT 'cash' AS channel, NULL AS account_id, 'salesIn' AS component, SUM(p.amount) AS amount
      FROM payments p
      JOIN sales s ON s.id = p.sale_id
      WHERE p.company_id = ${companyId} AND s.branch_id = ${branchId}
        AND p.business_date BETWEEN ${fromDay} AND ${toDay} AND p.method = 'cash'
      UNION ALL
      SELECT 'account', p.receiving_account_id, 'salesIn', SUM(p.amount)
      FROM payments p
      JOIN sales s ON s.id = p.sale_id
      WHERE p.company_id = ${companyId} AND s.branch_id = ${branchId}
        AND p.business_date BETWEEN ${fromDay} AND ${toDay} AND p.method <> 'cash'
      GROUP BY p.receiving_account_id

      UNION ALL
      -- Refunds CONFIRMED in the range (I3), keyed on the confirmation day.
      SELECT IF(method = 'cash', 'cash', 'account'),
             IF(method = 'cash', NULL, receiving_account_id),
             'refundsOut', SUM(reported_amount)
      FROM refund_payouts
      WHERE company_id = ${companyId} AND branch_id = ${branchId}
        AND status = 'confirmed' AND confirmation_date BETWEEN ${fromDay} AND ${toDay}
      GROUP BY method, receiving_account_id

      UNION ALL
      -- Supplier payments CONFIRMED in the range (J1). A balance-sheet movement.
      SELECT IF(method = 'cash', 'cash', 'account'),
             IF(method = 'cash', NULL, receiving_account_id),
             'supplierOut', SUM(amount)
      FROM supplier_settlements
      WHERE company_id = ${companyId} AND branch_id = ${branchId}
        AND status = 'confirmed' AND confirmation_date BETWEEN ${fromDay} AND ${toDay}
      GROUP BY method, receiving_account_id

      UNION ALL
      -- Purchases paid at receipt, by their stored business date.
      SELECT IF(sp.method = 'cash', 'cash', 'account'),
             IF(sp.method = 'cash', NULL, sp.receiving_account_id),
             'supplierOut', SUM(sp.amount)
      FROM supplier_payments sp
      JOIN purchases p ON p.id = sp.purchase_id
      WHERE sp.company_id = ${companyId} AND p.branch_id = ${branchId}
        AND sp.business_date BETWEEN ${fromDay} AND ${toDay}
      GROUP BY IF(sp.method = 'cash', 'cash', 'account'), IF(sp.method = 'cash', NULL, sp.receiving_account_id)

      UNION ALL
      -- Expenses CONFIRMED in the range (D): a variable expense on its
      -- confirmation day, a fixed one on its due date, as the rollup keys them.
      SELECT IF(method = 'cash', 'cash', 'account'),
             IF(method = 'cash', NULL, receiving_account_id),
             'expensesOut', SUM(amount)
      FROM expenses
      WHERE company_id = ${companyId} AND branch_id = ${branchId} AND status = 'confirmed'
        AND IF(expense_class = 'fixed', due_date, confirmation_date) BETWEEN ${fromDay} AND ${toDay}
      GROUP BY method, receiving_account_id

      UNION ALL
      -- Corrections APPROVED in the range (B): money coming back, so added. The
      -- account comes from the payout or settlement being corrected.
      SELECT IF(fc.method = 'cash', 'cash', 'account'),
             IF(fc.method = 'cash', NULL, COALESCE(rp.receiving_account_id, ss.receiving_account_id)),
             'correctionsIn', SUM(fc.amount)
      FROM financial_corrections fc
      LEFT JOIN refund_payouts rp ON rp.id = fc.target_refund_payout_id
      LEFT JOIN supplier_settlements ss ON ss.id = fc.target_supplier_settlement_id
      WHERE fc.company_id = ${companyId} AND fc.branch_id = ${branchId}
        AND fc.target_kind IN ('refund_payout', 'supplier_settlement')
        AND fc.status = 'approved' AND fc.correction_date BETWEEN ${fromDay} AND ${toDay}
      GROUP BY fc.method, COALESCE(rp.receiving_account_id, ss.receiving_account_id)

      UNION ALL
      -- Every leg of every other correction approved in the range (0078, 0079): money
      -- reaching or leaving one channel — a payment moved or never received, a sale
      -- cancelled, an expense reversed, a purchase payment moved or a purchase
      -- cancelled. The corrected record is never written; its own day's figures and
      -- snapshots stay as they were.
      SELECT IF(l.method = 'cash', 'cash', 'account'),
             IF(l.method = 'cash', NULL, l.receiving_account_id),
             IF(l.direction = 'in', 'correctionsIn', 'correctionsOut'),
             SUM(l.amount)
      FROM financial_correction_legs l
      JOIN financial_corrections fc ON fc.id = l.correction_id
      WHERE fc.company_id = ${companyId} AND fc.branch_id = ${branchId}
        AND fc.status = 'approved' AND fc.correction_date BETWEEN ${fromDay} AND ${toDay}
      GROUP BY l.method, l.receiving_account_id, l.direction
    `);

    return rows
      .filter((r) => r.amount != null)
      .map((r) => ({
        channel: r.channel as Channel,
        accountId: r.account_id ? binToUuid(r.account_id) : null,
        component: r.component as Component,
        amount: round2(num(r.amount as Prisma.Decimal)),
      }));
  }

  private async buildDigestLines(branchId: Buffer, dayDate: Date) {
    const items = await this.db.saleItem.findMany({
      where: { voided: false, sale: { branchId, businessDate: dayDate } },
      include: {
        unit: { select: { imeiPrimary: true, serialNo: true, product: { select: { brand: true, model: true, variant: true } } } },
        product: { select: { brand: true, model: true, variant: true } },
        sale: { select: { userId: true, soldAt: true, total: true } },
      },
    });
    const label = (p?: { brand: string; model: string; variant: string | null } | null) =>
      p ? `${p.brand} ${p.model}${p.variant ? ` ${p.variant}` : ''}` : null;
    // Each line at its share of its invoice's recorded total, as the rollup values it (docs/54 D36).
    const shares = sharesBySale(items.map((it) => ({ id: it.id, saleId: it.saleId, price: it.price, quantity: it.quantity, discount: it.discount, saleTotal: it.sale.total })));

    return items.map((it) => {
      const salePrice = fromCents(shares.get(it.id.toString('hex')) ?? 0n);
      const purchaseCost = round2(num(it.cost) * it.quantity);
      return {
        identifier: it.unit ? it.unit.imeiPrimary ?? it.unit.serialNo : null,
        productLabel: label(it.unit?.product ?? it.product),
        employeeId: it.sale.userId,
        salePrice,
        purchaseCost,
        profit: round2(salePrice - purchaseCost),
        method: null,
        soldAt: it.sale.soldAt,
      };
    });
  }

  private async historicalComparison(branchId: Buffer, dayDate: Date) {
    const yesterday = new Date(dayDate.getTime() - 86_400_000);
    const lastWeek = new Date(dayDate.getTime() - 7 * 86_400_000);
    const monthStart = dateValue(`${dateKey(dayDate).slice(0, 8)}01`);

    const dayFig = async (d: Date) => {
      const r = await this.db.dailyRollup.findUnique({ where: { branchId_day: { branchId, day: d } } });
      return { revenue: round2(num(r?.revenue ?? 0)), netProfit: round2(num(r?.netProfit ?? 0)) };
    };
    const mtd = await this.db.dailyRollup.aggregate({
      _sum: { revenue: true, netProfit: true },
      where: { branchId, day: { gte: monthStart, lte: dayDate } },
    });

    return {
      today: await dayFig(dayDate),
      yesterday: await dayFig(yesterday),
      sameDayLastWeek: await dayFig(lastWeek),
      monthToDate: { revenue: round2(num(mtd._sum.revenue)), netProfit: round2(num(mtd._sum.netProfit)) },
    };
  }
}

/**
 * What the timeline shows of an event's payload (docs/51 §12.1). The stored payload
 * of a close carries the whole report — sales, profit — and the timeline is read by
 * anyone who may count; so only the fields that line needs leave the server.
 */
const TIMELINE_FIELDS: Record<string, readonly string[]> = {
  count_saved: ['channel', 'accountId', 'label', 'counted', 'expected', 'difference', 'skipped', 'fromRow'],
  closed: ['expectedCash', 'countedCash', 'difference', 'verified', 'unverifiedCount', 'fromRow'],
  reclosed: ['expectedCash', 'countedCash', 'difference', 'verified', 'unverifiedCount'],
  reopened: ['mode', 'automatic', 'reopenCount'],
  auto_reopened: ['mode', 'automatic', 'cause', 'reopenCount'],
  day_started_early: ['previousDate', 'startedAt'],
  opened: ['openedAt', 'localTime', 'nth'],
};

export function timelinePayload(kind: string, payload: unknown): Record<string, unknown> {
  const source = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const allowed = TIMELINE_FIELDS[kind] ?? [];
  const out: Record<string, unknown> = {};
  for (const k of allowed) if (k in source) out[k] = source[k];
  return out;
}

/** The report stored with a close, when the close stored one (every close since 0078 does). */
function snapshotReport(payload: unknown): {
  report: ClosingReport;
  version: string;
  verification: { verified: string[]; unverified: string[]; acknowledged: boolean; reason: string | null };
} | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (!p.report || typeof p.report !== 'object' || typeof p.reportVersion !== 'string') return null;
  const v = (p.verification ?? {}) as Record<string, unknown>;
  return {
    report: p.report as ClosingReport,
    version: p.reportVersion,
    verification: {
      verified: Array.isArray(v.verified) ? (v.verified as string[]) : [],
      unverified: Array.isArray(v.unverified) ? (v.unverified as string[]) : [],
      acknowledged: v.acknowledged === true,
      reason: typeof v.reason === 'string' ? v.reason : null,
    },
  };
}

function dayWindowOf(day: string, timezone: string): { startsAt: string; endsAt: string } {
  const w = dayWindow(day, timezone);
  return { startsAt: w.start.toISOString(), endsAt: w.end.toISOString() };
}
