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
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { isDateString, shiftDate } from '../common/business-day';
import { BusinessDayService, dateKey, dateValue } from '../common/business-day/business-day.service';
import { CreateClosingDto } from './dto/create-closing.dto';
import { RecordCountDto } from './dto/record-count.dto';
import { ReopenClosingDto } from './dto/reopen-closing.dto';
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
  canReopen,
  closeKindOf,
  freshCounts,
  previousDayNeedsReview,
  reconcileDiscrepancy,
  reopenChoices,
  standingOf,
  type DayStanding,
} from './closing-lifecycle';
import { reclosedNotice, reopenedNotice, saleNotice, type Notice } from './closing-notices';
import { ClosingNoticeService, type NoticeOutcome } from './closing-notice.service';

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
    return {
      ...described,
      standing: standingOf(current ? { status: current.status, businessDate: described.businessDate } : null, described.businessDate),
      previousDay: {
        businessDate: previousDate,
        standing: standingOf(previous ? { status: previous.status, businessDate: previousDate } : null, described.businessDate),
        needsReview: previousDayNeedsReview(previous ? { status: previous.status, businessDate: previousDate } : null),
      },
    };
  }

  private requireDate(raw: string | undefined, fallback: string): string {
    if (raw === undefined) return fallback;
    if (!isDateString(raw)) throw new BadRequestException('date must be YYYY-MM-DD');
    return raw;
  }

  // ── Closing ─────────────────────────────────────────────────────────────

  async close(dto: CreateClosingDto) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const today = await this.businessDay.today(branchId);
    const day = this.requireDate(dto.date, today);
    if (day > today) throw new BadRequestException('A business day cannot be closed before it begins');
    const dayDate = dateValue(day);
    const now = new Date();
    const userId = this.tenant.userId() ?? null;

    /**
     * A day being counted already has a closing row (E-CP1), so existence is not
     * the test — being LOCKED is. A locked day stays locked until it is reopened
     * (0076), and a reopened day closes again as a RECLOSE: the first snapshot
     * stays on the row and in its event; a fresh count is required.
     */
    const already = await this.db.dailyClosing.findUnique({
      where: { branchId_closingDate: { branchId, closingDate: dayDate } },
      include: { channelCounts: true },
    });
    if (already?.status === 'locked') {
      throw new ConflictException(`Day ${day} is already closed for this branch`);
    }
    const kind = closeKindOf(already);
    if (kind === 'already_locked') throw new ConflictException(`Day ${day} is already closed for this branch`);

    // Authoritative aggregation: refresh then read the branch-day rollup.
    await this.rollups.recomputeDaily(companyId, branchId, day);
    const rollup = await this.db.dailyRollup.findUnique({
      where: { branchId_day: { branchId, day: dayDate } },
    });
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
    const correctedCash = round2(num(rollup?.correctionsCash ?? 0));
    const expensesCash = round2(num(rollup?.expensesCash ?? 0));
    /**
     * What the drawer held when the day began (0076): the counted cash at the
     * last locked close plus the net cash movement of any unclosed day between.
     * A balance carried forward, never income — it appears in no profit figure.
     */
    const openingCash = await this.openingCash(companyId, branchId, day);

    /**
     * **The reconciliation equation.** Every movement appears exactly once:
     *
     *   expected = opening balance
     *            + cash taken in
     *            − refunds paid in cash
     *            − supplier payments in cash
     *            − expenses paid in cash
     *            + corrections returned in cash
     *
     * Pending reports appear nowhere — only confirmed movements are here.
     */
    const expectedCash = round2(
      openingCash + num(cash._sum.amount) - refundedCash - supplierPaid.cash - expensesCash + correctedCash,
    );

    /**
     * Where the counted cash comes from (E-CP1). A count entered through
     * `closing.count` by the person holding the drawer is the record; signing
     * the day off must not quietly replace it. On a reclose the count must be
     * FRESH — taken after the reopen — or it describes a drawer that has since
     * changed (0076).
     */
    const finalChannels = await this.expectedChannels(companyId, branchId, day, day, openingCash);
    const countsByChannel = new Map<string, RecordedCount>(
      (already?.channelCounts ?? []).map((c) => [
        keyOf({ channel: c.channel, accountId: c.receivingAccountId ? binToUuid(c.receivingAccountId) : null }),
        c,
      ]),
    );
    if (kind === 'reclose') {
      const fresh = freshCounts(
        finalChannels.map((ch) => {
          const saved = countsByChannel.get(keyOf(ch));
          return {
            key: keyOf(ch),
            countable: isCountable(ch),
            counted: saved?.counted == null ? null : num(saved.counted),
            isSkipped: saved?.isSkipped ?? false,
            countedAt: saved?.countedAt ?? null,
          };
        }),
        already?.reopenedAt ?? null,
      );
      if (!fresh.complete) {
        throw new ConflictException({
          code: 'fresh_count_required',
          message: 'This day was reopened; count every channel again before closing it',
          stale: fresh.stale,
          outstanding: fresh.outstanding,
        });
      }
    }
    const recordedCash = countsByChannel.get('cash:NONE');
    const hasRecordedCash = !!recordedCash && !recordedCash.isSkipped && recordedCash.counted != null;
    if (hasRecordedCash) {
      const recorded = round2(num(recordedCash!.counted));
      if (dto.countedCash != null && round2(dto.countedCash) !== recorded) {
        throw new ConflictException(
          `A cash count of ${recorded} was already recorded for ${day}; recount it rather than overriding it at sign-off`,
        );
      }
    } else if (dto.countedCash == null || kind === 'reclose') {
      throw new BadRequestException('Nobody has counted the cash for this day yet');
    }
    const countedCash = hasRecordedCash ? round2(num(recordedCash!.counted)) : round2(dto.countedCash as number);
    const difference = round2(countedCash - expectedCash);

    const lines = await this.buildDigestLines(branchId, dayDate);
    const sinceFirst = kind === 'reclose' && already?.firstClosedAt ? await this.movementSince(branchId, dayDate, already.firstClosedAt) : null;

    const result = await this.db.$transaction(async (tx) => {
      const closingId = already?.id ?? newUuidV7Bin();
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

      if (already) {
        /**
         * Guarded on the version AND on not already being locked, so two people
         * signing off the same day produce one closing and one 409 rather than
         * two conflicting snapshots.
         */
        const won = await tx.dailyClosing.updateMany({
          where: { id: closingId, version: already.version, status: { not: 'locked' } },
          data: { ...snapshot, version: { increment: 1 } },
        });
        if (won.count === 0) {
          throw new ConflictException('refresh_required: this day was changed while you were closing it');
        }
      } else {
        await tx.dailyClosing.create({
          data: { id: closingId, companyId, branchId, closingDate: dayDate, ...snapshot },
        });
      }

      // Freeze each channel as it stood at sign-off, carrying whatever count or
      // recorded skip it already had.
      const frozenRows: { key: string; id: Buffer; counted: number | null; isSkipped: boolean; difference: number | null }[] = [];
      for (const ch of finalChannels) {
        const saved = countsByChannel.get(keyOf(ch));
        const counted = saved?.counted == null ? null : round2(num(saved.counted));
        const frozen = {
          labelSnapshot: ch.labelSnapshot,
          salesIn: ch.salesIn,
          refundsOut: ch.refundsOut,
          supplierOut: ch.supplierOut,
          expensesOut: ch.expensesOut,
          correctionsIn: ch.correctionsIn,
          openingBalance: ch.openingBalance,
          expected: ch.expected,
          counted,
          difference: counted == null ? null : round2(counted - ch.expected),
          isSkipped: saved?.isSkipped ?? false,
          skipReason: saved?.skipReason ?? null,
          countedById: saved?.countedById ?? null,
          countedAt: saved?.countedAt ?? null,
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
        frozenRows.push({ key: keyOf(ch), id: rowId, counted, isSkipped: frozen.isSkipped, difference: frozen.difference });
      }

      /**
       * A difference becomes a question, not a number (E-CP2). Opened
       * `pending_investigation` and never assigned to anybody. On a reclose
       * (0076) an undecided question follows the new figure and a decided one
       * stays decided — `reconcileDiscrepancy` says which.
       */
      for (const row of frozenRows) {
        const existing = await tx.closingDiscrepancy.findFirst({
          where: { closingId, channelCountId: row.id },
          orderBy: { openedAt: 'desc' },
        });
        const shaped = { counted: row.counted, isSkipped: row.isSkipped, difference: row.difference };
        const wanted = opensDiscrepancy(shaped) ? row.difference : null;
        const action = reconcileDiscrepancy(
          existing ? { status: existing.status, amount: num(existing.amount) } : null,
          wanted,
        );
        if (action.kind === 'none') continue;
        if (action.kind === 'open' || action.kind === 'open_delta') {
          await tx.closingDiscrepancy.create({
            data: { id: newUuidV7Bin(), companyId, branchId, closingId, channelCountId: row.id, amount: action.amount },
          });
        } else if (action.kind === 'update' && existing) {
          await tx.closingDiscrepancy.update({
            where: { id: existing.id },
            data: { amount: action.amount, version: { increment: 1 } },
          });
        } else if (action.kind === 'resolve_no_difference' && existing) {
          await tx.closingDiscrepancy.update({
            where: { id: existing.id },
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

      // The digest: one per closing. A reclose rewrites it from the same lines.
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

      const frozenSummary = finalChannels.map((ch) => {
        const saved = countsByChannel.get(keyOf(ch));
        const counted = saved?.counted == null ? null : round2(num(saved.counted));
        return { key: keyOf(ch), label: ch.labelSnapshot, expected: ch.expected, counted, skipped: saved?.isSkipped ?? false };
      });
      const eventId = newUuidV7Bin();
      const reopenCount = already?.reopenCount ?? 0;
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
            totalSales: revenue,
            netProfit,
            channels: frozenSummary,
            ...(sinceFirst ? { sinceFirstCount: sinceFirst } : {}),
          } as Prisma.InputJsonValue,
        },
      });

      await this.audit.recordTx(tx, {
        entityType: 'DailyClosing',
        entityId: closingId,
        action: kind === 'first' ? 'create' : 'status_change',
        reason: kind === 'first' ? undefined : 'reclosed',
        after: { day, revenue, netProfit, difference, kind },
        branchId,
      });
      return { closingId, digestId, eventId, reopenCount };
    });

    if (kind === 'first') {
      await this.notifications.emit({
        type: 'closing.completed',
        title: `Day ${day} closed`,
        body: `Revenue ${revenue} · Net profit ${netProfit}`,
        branchId,
      });
    } else {
      // After commit, never before: a delivery problem is not the close's problem.
      void this.tellOwner(companyId, branchId, day, result.eventId, (ctx) =>
        reclosedNotice(ctx, {
          closingIdHex: result.closingId.toString('hex'),
          reopenCount: result.reopenCount,
          at: now,
          sinceFirstCount: sinceFirst ?? { salesValue: 0, cashIn: 0, salesCount: 0 },
          wholeDay: { salesValue: revenue, expectedCash, countedCash, difference },
        }),
      );
    }

    const comparison = await this.historicalComparison(branchId, dayDate);
    return {
      closingId: binToUuid(result.closingId),
      date: day,
      kind,
      digest: { revenue, costOfGoodsSold: cogs, grossProfit, expenses, netProfit, lineCount: lines.length },
      cash: { expected: expectedCash, counted: countedCash, difference, opening: openingCash },
      channels: finalChannels.map((ch) => {
        const saved = countsByChannel.get(keyOf(ch));
        const counted = saved?.counted == null ? null : round2(num(saved.counted));
        return {
          channel: ch.channel,
          accountId: ch.accountId,
          label: ch.labelSnapshot,
          isUnattributed: ch.isUnattributed,
          openingBalance: ch.openingBalance,
          expected: ch.expected,
          counted,
          difference: counted == null ? null : round2(counted - ch.expected),
          skipped: saved?.isSkipped ?? false,
          skipReason: saved?.skipReason ?? null,
        };
      }),
      paidOut: {
        refundsTotal: refundsPaidTotal,
        refundsCash: refundsPaidCash,
        supplierTotal: supplierPaid.total,
        supplierCash: supplierPaid.cash,
      },
      sinceFirstCount: sinceFirst,
      comparison,
    };
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
      if (!(this.cls.get('permissions')?.has('closing.start_early') ?? false)) {
        throw new ForbiddenException('Only the Owner may start the next business day early');
      }
      // Already started early: a retry or a second tap changes nothing.
      if (described.startedEarly) return this.businessDayView();
      if (day !== described.businessDate) {
        throw new BadRequestException('Only the current business day can be ended early');
      }
      if (!described.canStartEarly) {
        throw new ConflictException({
          code: 'not_before_day_start',
          message: 'The next business day can only be started between midnight and 06:00',
        });
      }
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
        // Started already — by a retry or a second tap. The intent is satisfied.
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      }
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

  /**
   * A sale after the close reopens the day by itself, inside the sale's own
   * transaction (docs/50 §3.2). Never refuses: a close is a counted snapshot
   * and a history event, not a lock on selling. The notices go out after the
   * caller commits, through `afterSaleCommitted`.
   */
  async autoReopenTx(
    tx: Pick<TenantPrisma, 'auditLog' | 'dailyClosing' | 'closingEvent'>,
    args: { branchId: Buffer; businessDate: string; cause: { kind: 'sale' | 'payment'; id: Buffer } },
  ): Promise<AutoReopenResult> {
    const companyId = this.tenant.companyId();
    const dayDate = dateValue(args.businessDate);
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
        moneyOut: round2(ch.refundsOut + ch.supplierOut + ch.expensesOut),
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

    const [todayChannels, periodChannels, sales, phones, owedAll, expenses] = await Promise.all([
      this.expectedChannels(companyId, branchId, today, today, openingToday),
      this.expectedChannels(companyId, branchId, from, to),
      this.db.sale.aggregate({
        where: { branchId, isReversed: false, businessDate: range },
        _sum: { total: true, balanceDue: true },
        _count: true,
      }),
      this.db.saleItem.count({
        where: {
          voided: false,
          unit: { product: { trackingType: 'imei' } },
          sale: { branchId, isReversed: false, businessDate: range },
        },
      }),
      this.db.sale.aggregate({
        where: { branchId, isReversed: false, balanceDue: { gt: 0 } },
        _sum: { balanceDue: true },
        _count: true,
      }),
      this.db.expense.findMany({
        where: { branchId, status: 'confirmed', confirmationDate: dateValue(today) },
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
          moneyOut: round2(c.refundsOut + c.supplierOut + c.expensesOut),
          net: c.expected,
        })),
      period: {
        phonesSold: phones,
        salesCount: sales._count,
        salesValue: round2(num(sales._sum.total)),
        collected: round2(collected),
        outstanding: round2(num(sales._sum.balanceDue)),
        refunds: round2(refunds),
      },
      outstandingAll: { amount: round2(num(owedAll._sum.balanceDue)), sales: owedAll._count },
      expensesToday: {
        total: round2(expenses.reduce((n, e) => n + num(e.amount), 0)),
        rows: expenses.map((e) => ({
          id: binToUuid(e.id),
          description: e.category,
          amount: num(e.amount),
          method: e.method,
          accountLabel: e.accountLabelSnapshot,
          reference: e.reference,
          hasReceipt: e.receiptKey !== null,
          paidAt: e.confirmedAt,
        })),
      },
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
      include: { channelCounts: true },
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
    const standing: DayStanding = standingOf(closing ? { status: closing.status, businessDate: day } : null, today);
    const reopenVerdict = canReopen(closing ? { status: closing.status, businessDate: day } : null, today);
    const mayStartEarly = this.cls.get('permissions')?.has('closing.start_early') ?? false;
    const history = await this.history(branchId, dayDate, closing?.firstClosedAt ?? null);

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
      firstClosedAt: closing?.firstClosedAt ?? null,
      closedAt: closing?.status === 'locked' ? closing.closedAt : null,
      reopenedAt: closing?.status === 'reopened' ? closing.reopenedAt : null,
      reopenCount: closing?.reopenCount ?? 0,
      canReopen: reopenVerdict.ok,
      reopenRefusal: reopenVerdict.ok ? null : reopenVerdict.why,
      reopenChoices: reopenChoices(described.canStartEarly && day === today, mayStartEarly),
      nextDate: shiftDate(day, 1),
      history,
      previousDay:
        day === today
          ? await (async () => {
              const previousDate = shiftDate(today, -1);
              const prev = await this.db.dailyClosing.findUnique({
                where: { branchId_closingDate: { branchId, closingDate: dateValue(previousDate) } },
                select: { status: true },
              });
              const row = prev ? { status: prev.status, businessDate: previousDate } : null;
              return { businessDate: previousDate, standing: standingOf(row, today), needsReview: previousDayNeedsReview(row) };
            })()
          : null,
    };
  }

  /** The day's events and, after the first close, the sales made since — in time order. */
  private async history(branchId: Buffer, dayDate: Date, firstClosedAt: Date | null) {
    const events = await this.db.closingEvent.findMany({
      where: { branchId, businessDate: dayDate },
      orderBy: { at: 'asc' },
      select: { id: true, kind: true, at: true, payload: true, actor: { select: { name: true } } },
    });
    const sales = firstClosedAt
      ? await this.db.sale.findMany({
          where: { branchId, businessDate: dayDate, isReversed: false, soldAt: { gte: firstClosedAt } },
          orderBy: { soldAt: 'asc' },
          select: {
            id: true,
            soldAt: true,
            total: true,
            amountPaid: true,
            balanceDue: true,
            payments: { select: { method: true, amount: true } },
            items: {
              where: { voided: false },
              select: {
                quantity: true,
                product: { select: { brand: true, model: true } },
                unit: { select: { product: { select: { brand: true, model: true } } } },
              },
            },
          },
        })
      : [];
    const rows: { kind: string; at: Date; actor: string | null; payload: Record<string, unknown> }[] = [
      ...events.map((e) => ({
        kind: e.kind,
        at: e.at,
        actor: e.actor?.name ?? null,
        payload: (e.payload && typeof e.payload === 'object' ? e.payload : {}) as Record<string, unknown>,
      })),
      ...sales.map((s) => {
        const first = s.items[0];
        const product = first?.product ?? first?.unit?.product ?? null;
        return {
          kind: 'sale',
          at: s.soldAt,
          actor: null,
          payload: {
            saleId: binToUuid(s.id),
            item: product ? `${product.brand} ${product.model}`.trim() : null,
            itemCount: s.items.reduce((n, it) => n + it.quantity, 0),
            total: num(s.total),
            collected: num(s.amountPaid),
            owed: num(s.balanceDue),
            cashIn: round2(s.payments.filter((p) => p.method === 'cash').reduce((n, p) => n + num(p.amount), 0)),
          },
        };
      }),
    ];
    return rows.sort((a, b) => a.at.getTime() - b.at.getTime());
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
              // The snapshot columns stay at zero until the day is locked.
              expectedCash: 0,
              countedCash: 0,
              difference: 0,
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
   * What the drawer held when a business day began (0076).
   *
   * The counted cash at the most recent LOCKED close before the day, plus the
   * net cash movement of every unclosed day between that close and this one —
   * the same movements the closing counts, over that range. A shop that has
   * never locked a day starts from zero, exactly as before; the first close
   * anchors the chain.
   */
  private async openingCash(companyId: Buffer, branchId: Buffer, day: string): Promise<number> {
    const last = await this.db.dailyClosing.findFirst({
      where: { branchId, status: 'locked', closingDate: { lt: dateValue(day) } },
      orderBy: { closingDate: 'desc' },
      select: { closingDate: true, countedCash: true },
    });
    if (!last) return 0;
    const lastDay = dateKey(last.closingDate);
    const from = shiftDate(lastDay, 1);
    const to = shiftDate(day, -1);
    if (from > to) return round2(num(last.countedCash));
    const between = await this.expectedChannels(companyId, branchId, from, to);
    const cash = between.find((c) => c.channel === 'cash');
    return round2(num(last.countedCash) + (cash?.expected ?? 0));
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
        AND fc.status = 'approved' AND fc.correction_date BETWEEN ${fromDay} AND ${toDay}
      GROUP BY fc.method, COALESCE(rp.receiving_account_id, ss.receiving_account_id)
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
        sale: { select: { userId: true, soldAt: true } },
      },
    });
    const label = (p?: { brand: string; model: string; variant: string | null } | null) =>
      p ? `${p.brand} ${p.model}${p.variant ? ` ${p.variant}` : ''}` : null;

    return items.map((it) => {
      const salePrice = round2(num(it.price) * it.quantity - num(it.discount));
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
