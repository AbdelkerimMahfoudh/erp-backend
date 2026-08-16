import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RollupService } from '../analytics/rollup.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { dayKey } from '../common/utils/date.util';
import { CreateClosingDto } from './dto/create-closing.dto';
import { RecordCountDto } from './dto/record-count.dto';
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

const num = (d: Prisma.Decimal | number | null): number => (d == null ? 0 : Number(d));
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Daily closing + digest. The branch-day rollup is recomputed first so it is
 * the single authoritative source for revenue / COGS / gross / expenses / net
 * profit — all tracking-type independent. One transaction writes the closing,
 * the digest, and its per-line detail; then an in-app notification and a
 * historical comparison are returned.
 */
@Injectable()
export class ClosingService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly rollups: RollupService,
    private readonly suppliers: SuppliersService,
  ) {}

  async close(dto: CreateClosingDto) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const day = dto.date ?? dayKey(new Date());
    const dayDate = new Date(`${day}T00:00:00.000Z`);
    const start = dayDate;
    const end = new Date(dayDate.getTime() + 86_400_000);

    /**
     * A day being counted already has a closing row (E-CP1), so existence is no
     * longer the test — being LOCKED is. A locked day stays locked: correcting
     * one goes through Milestone B's append-only workflow, never by reopening.
     */
    const already = await this.db.dailyClosing.findUnique({
      where: { branchId_closingDate: { branchId, closingDate: dayDate } },
      include: { channelCounts: true },
    });
    if (already?.status === 'locked') {
      throw new ConflictException(`Day ${day} is already closed for this branch`);
    }

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
    // Returns approved on THIS day, snapshotted into the locked record so a
    // closing written after an approval carries it. Positive magnitudes; the
    // rollup has already subtracted them from netProfit.
    const totalReturns = round2(num(rollup?.returnsRevenue ?? 0));
    const totalReturnsProfitImpact = round2(num(rollup?.returnsGrossProfit ?? 0));
    const totalReturnAdjustments = round2(num(rollup?.returnsAdjustments ?? 0));
    const totalReturnsCogsCredited = round2(num(rollup?.returnsCogs ?? 0));
    // Refunds settled on the day this closing locks. Cash movement, not profit.
    const refundsPaidTotal = round2(num(rollup?.refundsPaidTotal ?? 0));
    const refundsPaidCash = round2(num(rollup?.refundsPaidCash ?? 0));

    // Expected cash = cash payments taken on the day at this branch.
    const cash = await this.db.payment.aggregate({
      _sum: { amount: true },
      where: { method: 'cash', sale: { branchId, soldAt: { gte: start, lt: end } } },
    });
    /**
     * Cash refunds CONFIRMED today left the till, so the drawer should hold
     * less. Before I3 this was cash in only, and a day with a confirmed cash
     * refund would have reported a shortage that was not a shortage — the
     * money was handed back on purpose.
     *
     * Taken from the payout record rather than from `payments`, because a
     * refund is not a sale payment (docs/27 §17).
     */
    const refundedCash = round2(num(rollup?.refundsPaidCash ?? 0));

    /**
     * Supplier payments CONFIRMED today also left the till, and had no
     * figure here before J1 — so a day where the shop paid a supplier
     * reported a shortage that was not a shortage. Only the cash part is
     * subtracted: an account transfer never touched the drawer.
     *
     * This is a balance-sheet movement, not an expense and not COGS. It
     * appears nowhere in the profit figures below, deliberately — inventory
     * cost reaches profit through COGS when the goods sell.
     */
    const supplierPaid = await this.suppliers.paidOn(branchId, dayDate);

    /**
     * Money that came BACK today because a confirmed payment was corrected
     * (Milestone B). It is ADDED, not subtracted: a correction is the opposite
     * movement to the payment it reverses, so on the correction day the drawer
     * holds more than the day's sales alone would explain.
     *
     * Only the cash part. An account correction never touched the drawer, the
     * same rule refunds and supplier payments already follow.
     *
     * Added once, from the rollup, for the same reason `refundedCash` is: the
     * rollup is the single place these components are computed, so a figure
     * cannot drift between the closing and the day's analytics.
     */
    const correctedCash = round2(num(rollup?.correctionsCash ?? 0));

    /**
     * Cash expenses CONFIRMED today (Milestone D). The D0 audit's second
     * finding: expenses fed net profit but never reached this figure, so a shop
     * that paid for electricity out of the drawer reported a shortage that was
     * not a shortage — the same defect J1 fixed for supplier payments, still
     * present here.
     *
     * Cash only. An account transfer never touched the till, which is why the
     * rollup separates the two.
     *
     * From the rollup, like every other component, so a figure cannot drift
     * between the closing and the day's analytics.
     */
    const expensesCash = round2(num(rollup?.expensesCash ?? 0));

    /**
     * **The reconciliation equation.** Every movement appears exactly once:
     *
     *   expected = cash taken in
     *            − refunds paid in cash
     *            − supplier payments in cash
     *            − expenses paid in cash
     *            + corrections returned in cash
     *
     * Pending reports appear nowhere — only confirmed movements are here.
     */
    const expectedCash = round2(
      num(cash._sum.amount) - refundedCash - supplierPaid.cash - expensesCash + correctedCash,
    );
    /**
     * Where the counted cash comes from (E-CP1).
     *
     * A count entered through `closing.count` by the person holding the drawer
     * is the record. Signing the day off must not be able to quietly replace
     * it — if the two disagree, that is a recount, and a recount goes back
     * through the counting endpoint where it is attributed to whoever made it.
     */
    const recordedCash = already?.channelCounts.find((c) => c.channel === 'cash' && !c.isSkipped);
    if (recordedCash?.counted != null) {
      const recorded = round2(num(recordedCash.counted));
      if (dto.countedCash != null && round2(dto.countedCash) !== recorded) {
        throw new ConflictException(
          `A cash count of ${recorded} was already recorded for ${day}; recount it rather than overriding it at sign-off`,
        );
      }
    } else if (dto.countedCash == null) {
      throw new BadRequestException('Nobody has counted the cash for this day yet');
    }
    const countedCash =
      recordedCash?.counted != null ? round2(num(recordedCash.counted)) : round2(dto.countedCash as number);
    const difference = round2(countedCash - expectedCash);

    const lines = await this.buildDigestLines(companyId, branchId, start, end);
    /**
     * Frozen at sign-off, from the same builder the counting screen used, so
     * the locked per-channel rows are a snapshot of the day and not a view that
     * drifts afterwards — the property `reconciliation.spec.ts` already pins
     * for cash.
     */
    const finalChannels = await this.expectedChannels(companyId, branchId, day, dayDate);
    const countsByChannel = new Map(
      (already?.channelCounts ?? []).map((c) => [
        `${c.channel}:${c.receivingAccountId ? binToUuid(c.receivingAccountId) : 'NONE'}`,
        c,
      ]),
    );

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
        // Snapshotted like every other component, so the closed day can
        // explain its own expected cash without recomputing anything.
        correctionsTotal: round2(num(rollup?.correctionsTotal ?? 0)),
        correctionsCash: correctedCash,
        expensesCash,
        status: 'locked' as const,
        isLocked: true,
        closedById: this.tenant.userId() ?? null,
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
      for (const ch of finalChannels) {
        const saved = countsByChannel.get(`${ch.channel}:${ch.accountId ?? 'NONE'}`);
        const counted = saved?.counted == null ? null : round2(num(saved.counted));
        const frozen = {
          labelSnapshot: ch.labelSnapshot,
          salesIn: ch.salesIn,
          refundsOut: ch.refundsOut,
          supplierOut: ch.supplierOut,
          expensesOut: ch.expensesOut,
          correctionsIn: ch.correctionsIn,
          expected: ch.expected,
          counted,
          difference: counted == null ? null : round2(counted - ch.expected),
          isSkipped: saved?.isSkipped ?? false,
          skipReason: saved?.skipReason ?? null,
          countedById: saved?.countedById ?? null,
          countedAt: saved?.countedAt ?? null,
        };
        if (saved) {
          await tx.closingChannelCount.update({ where: { id: saved.id }, data: frozen });
        } else {
          await tx.closingChannelCount.create({
            data: {
              id: newUuidV7Bin(),
              companyId,
              closingId,
              channel: ch.channel,
              receivingAccountId: ch.accountId ? uuidToBin(ch.accountId) : null,
              ...frozen,
            },
          });
        }
      }

      /**
       * A difference becomes a question, not a number (E-CP2).
       *
       * Opened `pending_investigation` and **never** assigned to anybody. The
       * system observes that a channel is out; it does not accuse the person
       * who happened to be counting. Only the Owner may decide responsibility,
       * and `debt.manage` — which no Manager holds — is what gates it.
       *
       * A skipped or uncounted channel opens nothing: nobody claimed a figure,
       * so there is nothing to disagree with.
       */
      const frozenRows = await tx.closingChannelCount.findMany({ where: { closingId } });
      for (const row of frozenRows) {
        const shaped = {
          counted: row.counted == null ? null : num(row.counted),
          isSkipped: row.isSkipped,
          difference: row.difference == null ? null : num(row.difference),
        };
        if (!opensDiscrepancy(shaped)) continue;
        const already = await tx.closingDiscrepancy.findFirst({
          where: { closingId, channelCountId: row.id },
        });
        if (already) continue;
        await tx.closingDiscrepancy.create({
          data: {
            id: newUuidV7Bin(),
            companyId,
            branchId,
            closingId,
            channelCountId: row.id,
            amount: shaped.difference as number,
          },
        });
      }

      const digestId = newUuidV7Bin();
      await tx.dailyDigest.create({
        data: {
          id: digestId,
          companyId,
          branchId,
          closingId,
          digestDate: dayDate,
          revenue,
          costOfGoodsSold: cogs,
          grossProfit,
        },
      });
      if (lines.length > 0) {
        await tx.digestLine.createMany({ data: lines.map((l) => ({ ...l, id: newUuidV7Bin(), companyId, digestId })) });
      }

      await this.audit.recordTx(tx, {
        entityType: 'DailyClosing',
        entityId: closingId,
        action: 'create',
        after: { day, revenue, netProfit, difference },
        branchId,
      });
      return { closingId, digestId };
    });

    await this.notifications.emit({
      type: 'closing.completed',
      title: `Day ${day} closed`,
      body: `Revenue ${revenue} · Net profit ${netProfit}`,
      branchId,
    });

    const comparison = await this.historicalComparison(branchId, dayDate);
    return {
      closingId: binToUuid(result.closingId),
      date: day,
      digest: { revenue, costOfGoodsSold: cogs, grossProfit, expenses, netProfit, lineCount: lines.length },
      cash: { expected: expectedCash, counted: countedCash, difference },
      /**
       * Every channel the branch had to account for, frozen. A skipped or
       * uncounted channel reports as such rather than as balanced — the shop
       * should be able to see what was never checked.
       */
      channels: finalChannels.map((ch) => {
        const saved = countsByChannel.get(`${ch.channel}:${ch.accountId ?? 'NONE'}`);
        const counted = saved?.counted == null ? null : round2(num(saved.counted));
        return {
          channel: ch.channel,
          accountId: ch.accountId,
          label: ch.labelSnapshot,
          isUnattributed: ch.isUnattributed,
          expected: ch.expected,
          counted,
          difference: counted == null ? null : round2(counted - ch.expected),
          skipped: saved?.isSkipped ?? false,
          skipReason: saved?.skipReason ?? null,
        };
      }),
      /**
       * What left the till today and why. Reported separately from profit,
       * because neither a refund nor a supplier payment is an expense.
       */
      paidOut: {
        refundsTotal: refundsPaidTotal,
        refundsCash: refundsPaidCash,
        supplierTotal: supplierPaid.total,
        supplierCash: supplierPaid.cash,
      },
      comparison,
    };
  }

  async getClosing(date: string) {
    const branchId = this.tenant.requireBranchId();
    const closing = await this.db.dailyClosing.findUnique({
      where: { branchId_closingDate: { branchId, closingDate: new Date(`${date}T00:00:00.000Z`) } },
    });
    if (!closing) throw new NotFoundException(`No closing for ${date}`);
    return closing;
  }

  async getDigest(date: string) {
    const branchId = this.tenant.requireBranchId();
    const dayDate = new Date(`${date}T00:00:00.000Z`);
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
   * The day as it stands right now, per channel (E-CP1).
   *
   * A live view, not a snapshot: the figures move as the day's work is
   * confirmed, which is the entire point of counting progressively. Nothing is
   * written, so an Employee looking at what is outstanding cannot accidentally
   * commit anything.
   */
  async openView(date?: string) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const day = date ?? dayKey(new Date());
    const dayDate = new Date(`${day}T00:00:00.000Z`);

    const closing = await this.db.dailyClosing.findUnique({
      where: { branchId_closingDate: { branchId, closingDate: dayDate } },
      include: { channelCounts: true },
    });

    const channels = await this.expectedChannels(companyId, branchId, day, dayDate);
    const recorded = new Map(
      (closing?.channelCounts ?? []).map((c) => [
        `${c.channel}:${c.receivingAccountId ? binToUuid(c.receivingAccountId) : 'NONE'}`,
        c,
      ]),
    );

    const rows = channels.map((ch) => {
      const saved = recorded.get(`${ch.channel}:${ch.accountId ?? 'NONE'}`);
      const counted = saved?.counted == null ? null : round2(num(saved.counted));
      return {
        ...ch,
        countable: isCountable(ch),
        counted,
        /**
         * Recomputed against the CURRENT expected figure rather than read from
         * the stored one. While the day is open the expected figure still
         * moves, so a difference saved an hour ago is already stale — showing
         * it would tell somebody they are short when they are not.
         */
        difference: counted == null ? null : round2(counted - ch.expected),
        isSkipped: saved?.isSkipped ?? false,
        skipReason: saved?.skipReason ?? null,
        countedAt: saved?.countedAt ?? null,
      };
    });

    return {
      date: day,
      status: closing?.status ?? 'counting',
      isLocked: closing?.isLocked ?? false,
      channels: rows,
      /** What is still outstanding, so the screen never has to work it out. */
      outstanding: rows.filter((r) => r.countable && r.counted === null && !r.isSkipped).length,
      complete: countingComplete(rows),
    };
  }

  /**
   * Record one channel's count (E-CP1) — the `closing.count` path.
   *
   * The E0 audit's first finding: `closing.perform` both recorded the count and
   * locked the day, and only Owner and Manager held it. So the Employee holding
   * the drawer could not report what was in it without somebody senior standing
   * there. This records the count and nothing else — the day stays open and
   * fully correctable until somebody with `closing.perform` signs it off.
   */
  async recordCount(dto: RecordCountDto) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const day = dto.date ?? dayKey(new Date());
    const dayDate = new Date(`${day}T00:00:00.000Z`);

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
     * A locked day is signed off. Correcting one goes through Milestone B's
     * append-only correction workflow, exactly as every other confirmed
     * financial record does — reopening it would make a signed-off day mean
     * nothing.
     */
    if (existing?.status === 'locked') {
      throw new ConflictException(`Day ${day} is already closed for this branch`);
    }

    const channels = await this.expectedChannels(companyId, branchId, day, dayDate);
    const target = channels.find(
      (c) => c.channel === dto.channel && (c.accountId ?? null) === (dto.accountId ?? null),
    );
    if (!target) {
      throw new NotFoundException('That channel is not part of this day at this branch');
    }
    if (!isCountable(target)) {
      /**
       * The unattributed bucket. There is no account behind it, so there is no
       * balance to compare a count against — confirming a number that means
       * nothing is worse than leaving it visibly unreconciled.
       */
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
              // The snapshot columns stay at zero until the day is locked. A
              // closing that has not been signed off is not a snapshot of
              // anything yet, and writing figures that still move would make it
              // look like one.
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
      expected: target.expected,
      counted,
      difference,
      isSkipped: dto.skip ?? false,
      skipReason: dto.skip ? (dto.skipReason?.trim() ?? null) : null,
      countedById: userId,
      countedAt: new Date(),
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
     * signs the day off, never a lock. The transition is only ever forward from
     * `counting`, because a locked day is not reopened here.
     */
    const view = await this.openView(day);
    const nextStatus = view.complete ? 'counted' : 'counting';
    await this.db.dailyClosing.update({
      where: { id: closingId },
      data: {
        status: nextStatus,
        countedById: userId,
        countedAt: new Date(),
        version: { increment: 1 },
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
   * Every channel this branch has to account for today, with the components
   * behind each expected figure.
   *
   * Reads the movements, then hands the rules to the pure `buildChannels` —
   * which decides membership and applies the SAME five signs the cash equation
   * uses. There is one equation here, not two.
   */
  private async expectedChannels(
    companyId: Buffer,
    branchId: Buffer,
    day: string,
    dayDate: Date,
  ): Promise<ChannelRow[]> {
    const [movements, accounts] = await Promise.all([
      this.channelMovements(companyId, branchId, day, dayDate),
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
    );
  }

  /**
   * The day's money movements, split by the channel each one actually used.
   *
   * Every part keys on the same day column the rollup keys on, so a channel
   * figure and the day's analytics cannot disagree about which day a movement
   * belongs to.
   *
   * Note what is deliberately NOT filtered: corrected payouts and settlements
   * stay in their own day's figures. The original payment genuinely happened on
   * its day, and the correction is a separate movement on a separate day —
   * removing both would take the money out twice. That is the same reasoning
   * `rollup.service.ts` records, and `correction-sql.ts` names the queries this
   * applies to.
   */
  private async channelMovements(
    companyId: Buffer,
    branchId: Buffer,
    day: string,
    dayDate: Date,
  ): Promise<MovementRow[]> {
    const start = dayDate;
    const end = new Date(dayDate.getTime() + 86_400_000);

    const rows = await this.db.$queryRaw<
      { channel: string; account_id: Buffer | null; component: string; amount: unknown }[]
    >(Prisma.sql`
      -- Sales taken in. Cash lands in the drawer; anything else lands in the
      -- account it named, or in the unattributed bucket if it named none.
      SELECT 'cash' AS channel, NULL AS account_id, 'salesIn' AS component, SUM(p.amount) AS amount
      FROM payments p
      JOIN sales s ON s.id = p.sale_id
      WHERE p.company_id = ${companyId} AND s.branch_id = ${branchId}
        AND s.sold_at >= ${start} AND s.sold_at < ${end} AND p.method = 'cash'
      UNION ALL
      SELECT 'account', p.receiving_account_id, 'salesIn', SUM(p.amount)
      FROM payments p
      JOIN sales s ON s.id = p.sale_id
      WHERE p.company_id = ${companyId} AND s.branch_id = ${branchId}
        AND s.sold_at >= ${start} AND s.sold_at < ${end} AND p.method <> 'cash'
      GROUP BY p.receiving_account_id

      UNION ALL
      -- Refunds CONFIRMED today (I3), keyed on the confirmation day like the
      -- rollup — the approval that reversed the profit was a different day.
      SELECT IF(method = 'cash', 'cash', 'account'),
             IF(method = 'cash', NULL, receiving_account_id),
             'refundsOut', SUM(reported_amount)
      FROM refund_payouts
      WHERE company_id = ${companyId} AND branch_id = ${branchId}
        AND status = 'confirmed' AND confirmation_date = ${day}
      GROUP BY method, receiving_account_id

      UNION ALL
      -- Supplier payments CONFIRMED today (J1). A balance-sheet movement, never
      -- an expense and never COGS.
      SELECT IF(method = 'cash', 'cash', 'account'),
             IF(method = 'cash', NULL, receiving_account_id),
             'supplierOut', SUM(amount)
      FROM supplier_settlements
      WHERE company_id = ${companyId} AND branch_id = ${branchId}
        AND status = 'confirmed' AND confirmation_date = ${day}
      GROUP BY method, receiving_account_id

      UNION ALL
      -- Expenses CONFIRMED today (D). A variable expense belongs to its
      -- confirmation day and a fixed one to its due date, exactly as the rollup
      -- keys them — the same expense must not land on two different days
      -- depending on which figure is asking.
      SELECT IF(method = 'cash', 'cash', 'account'),
             IF(method = 'cash', NULL, receiving_account_id),
             'expensesOut', SUM(amount)
      FROM expenses
      WHERE company_id = ${companyId} AND branch_id = ${branchId} AND status = 'confirmed'
        AND IF(expense_class = 'fixed', due_date, confirmation_date) = ${day}
      GROUP BY method, receiving_account_id

      UNION ALL
      /*
       * Corrections APPROVED today (B) — money coming back, so it is added.
       *
       * The account is taken from the payout or settlement being corrected
       * rather than from the correction row, which carries only a method and a
       * label. A correction returns money to wherever the original payment
       * left from, by definition, so deriving it from the target is both
       * correct and impossible to get out of step.
       */
      SELECT IF(fc.method = 'cash', 'cash', 'account'),
             IF(fc.method = 'cash', NULL, COALESCE(rp.receiving_account_id, ss.receiving_account_id)),
             'correctionsIn', SUM(fc.amount)
      FROM financial_corrections fc
      LEFT JOIN refund_payouts rp ON rp.id = fc.target_refund_payout_id
      LEFT JOIN supplier_settlements ss ON ss.id = fc.target_supplier_settlement_id
      WHERE fc.company_id = ${companyId} AND fc.branch_id = ${branchId}
        AND fc.status = 'approved' AND fc.correction_date = ${day}
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


  private async buildDigestLines(companyId: Buffer, branchId: Buffer, start: Date, end: Date) {
    const items = await this.db.saleItem.findMany({
      where: { voided: false, sale: { branchId, soldAt: { gte: start, lt: end } } },
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
    const monthStart = new Date(`${dayKey(dayDate).slice(0, 8)}01T00:00:00.000Z`);

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
