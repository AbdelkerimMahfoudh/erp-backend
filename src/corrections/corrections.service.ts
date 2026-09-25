import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { AppClsStore } from '../common/context/request-context';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { binToUuid, isUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { dayKey } from '../common/utils/date.util';
import { BusinessDayService, dateValue } from '../common/business-day/business-day.service';
import { RollupService } from '../analytics/rollup.service';
import { ROLLUP_QUEUE, RollupQueue } from '../analytics/rollup-queue';
import { receiveQuantityAtCost } from '../inventory/stock-cost';
import {
  actionOf,
  assertDayOpen,
  assertDecidable,
  assertNoOpenRequest,
  assertNotAlreadyCorrected,
  assertReasonGiven,
  assertTargetCorrectable,
  fingerprintCorrection,
  type CorrectionAction,
  type CorrectionKind,
} from './correction-rules';
import { planFor, type CorrectionDb, type PlanContext, type PlanInput, type TargetPlan } from './correction-targets';
import {
  DecideCorrectionDto,
  ListCorrectionsDto,
  RequestCorrectionDto,
  PreviewCorrectionDto,
} from './dto/correction.dto';

const num = (d: Prisma.Decimal | number | null | undefined): number => (d == null ? 0 : Number(d));
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** The kinds planned by `correction-targets.ts` (0078, 0079); the two older ones are made on their own record. */
const PLANNED: ReadonlySet<CorrectionKind> = new Set(['sale_payment', 'sale', 'expense', 'supplier_payment', 'purchase']);

/**
 * Correcting a confirmed financial record (Milestone B, 0078, 0079 — docs/51 §15).
 *
 * **Nothing here rewrites the record being corrected.** Not a payment's amount or
 * channel, not a sale's lines or totals, not an expense, not a purchase. A
 * correction is an append-only record beside it, approved by the Owner, and what
 * it moves is written as its own rows:
 *
 *   **Money** — the legs (`financial_correction_legs`): each is money reaching or
 *   leaving one channel on the correction day. The closing reads them there.
 *
 *   **The original day is untouched.** Its rollup, its closing and every stored
 *   snapshot stay as they were; the correction posts to the CURRENT open business
 *   day of the record's branch, and waits while that day is closed.
 *
 *   **State that follows the correction** — a sale's receivable caches, a phone's
 *   status, a quantity on the shelf, a line's release from sold-once — is written
 *   in the approval's transaction with a before and after in the audit, exactly as
 *   the flows that first set them do.
 *
 *   **Once.** The database refuses a second approved correction per record, and the
 *   approval re-checks the record inside its transaction after locking it, so a
 *   return, a sale or a transfer that landed in between refuses it by name.
 */
@Injectable()
export class CorrectionsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly rollups: RollupService,
    private readonly cls: ClsService<AppClsStore>,
    private readonly businessDay: BusinessDayService,
    @Inject(ROLLUP_QUEUE) private readonly queue: RollupQueue,
  ) {}

  // ─────────────────────────────── request ───────────────────────────────

  /**
   * Ask for a correction. **Moves nothing.** It records that somebody believes a
   * confirmed record was wrong, and waits for the Owner.
   */
  async request(dto: RequestCorrectionDto) {
    const companyId = this.tenant.companyId();
    const userId = this.tenant.userId();
    const reason = assertReasonGiven(dto.reason);
    const hasDestination = dto.toMethod !== undefined || dto.toAccountId !== undefined;
    const action = actionOf(dto.targetKind, dto.action, hasDestination);
    if (!PLANNED.has(dto.targetKind) && (hasDestination || dto.amount !== undefined)) {
      throw new BadRequestException({
        code: 'not_a_reclassification',
        message: 'A refund or a supplier settlement is corrected as a whole.',
      });
    }
    const fingerprint = fingerprintCorrection({
      targetKind: dto.targetKind,
      action,
      targetId: dto.targetId,
      reason,
      supportingReference: dto.supportingReference,
      toMethod: dto.toMethod ?? null,
      toAccountId: dto.toAccountId ?? null,
      amount: dto.amount ?? null,
    });

    /**
     * The idempotent replay, checked first. Same key and same payload returns the
     * original; same key and a different payload is a conflict, because that is a
     * second correction wearing the first one's id.
     */
    const replay = await this.db.financialCorrection.findFirst({ where: { companyId, clientUuid: uuidToBin(dto.clientUuid) } });
    if (replay) {
      if (replay.clientRequestHash !== fingerprint) {
        throw new ConflictException({ code: 'idempotency_conflict', message: 'That request id was already used for a different correction.' });
      }
      return this.detail(binToUuid(replay.id));
    }

    if (PLANNED.has(dto.targetKind)) {
      const plan = await planFor(this.db as unknown as CorrectionDb, await this.planContext(), this.inputOf(dto, action));
      if (plan.refusal) throw new ConflictException(plan.refusal);
      const id = newUuidV7Bin();
      try {
        await this.db.financialCorrection.create({
          data: {
            id,
            companyId,
            // The branch whose drawer the record's money is in: the record's own branch.
            branchId: plan.branchId,
            targetKind: plan.kind,
            action: plan.action,
            ...plan.target,
            status: 'requested',
            reason,
            supportingReference: dto.supportingReference?.trim() || null,
            amount: plan.amount,
            method: plan.method,
            accountLabelSnapshot: plan.accountLabel,
            toMethod: plan.to?.method ?? null,
            toReceivingAccountId: plan.to?.accountId ? uuidToBin(plan.to.accountId) : null,
            toAccountLabelSnapshot: plan.to?.label ?? null,
            requestedById: userId ?? null,
            clientUuid: uuidToBin(dto.clientUuid),
            clientRequestHash: fingerprint,
          },
        });
      } catch (e) {
        // Two identical requests racing: the loser answers with the winner.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          const winner = await this.db.financialCorrection.findFirst({ where: { companyId, clientUuid: uuidToBin(dto.clientUuid) } });
          if (winner && winner.clientRequestHash === fingerprint) return this.detail(binToUuid(winner.id));
        }
        throw e;
      }
      await this.audit.record({
        entityType: 'FinancialCorrection',
        entityId: id,
        action: 'create',
        reason,
        after: this.jsonOf({ targetKind: plan.kind, action: plan.action, targetId: dto.targetId, amount: plan.amount, ...plan.summary }),
        branchId: plan.branchId,
      });
      return this.detail(binToUuid(id));
    }

    // Milestone B: a confirmed refund payout or supplier settlement, corrected as a whole.
    const target = await this.loadTarget(dto.targetKind as 'refund_payout' | 'supplier_settlement', dto.targetId);
    assertTargetCorrectable(target);
    const existing = await this.db.financialCorrection.findMany({
      where:
        dto.targetKind === 'refund_payout'
          ? { targetRefundPayoutId: uuidToBin(dto.targetId) }
          : { targetSupplierSettlementId: uuidToBin(dto.targetId) },
      select: { status: true },
    });
    assertNotAlreadyCorrected(existing);
    assertNoOpenRequest(existing);

    const id = newUuidV7Bin();
    await this.db.financialCorrection.create({
      data: {
        id,
        companyId,
        /**
         * The branch that MADE the payment, not the caller's active branch. A
         * correction has to put the money back in the drawer it left, and an
         * owner may well be standing in a different shop when they ask.
         */
        branchId: target!.branchId,
        targetKind: dto.targetKind,
        action: 'reverse',
        targetRefundPayoutId: dto.targetKind === 'refund_payout' ? uuidToBin(dto.targetId) : null,
        targetSupplierSettlementId: dto.targetKind === 'supplier_settlement' ? uuidToBin(dto.targetId) : null,
        status: 'requested',
        reason,
        supportingReference: dto.supportingReference?.trim() || null,
        // Copied, never accepted from the client — see the DTO.
        amount: target!.amount,
        method: target!.method,
        accountLabelSnapshot: target!.accountLabel,
        requestedById: userId ?? null,
        clientUuid: uuidToBin(dto.clientUuid),
        clientRequestHash: fingerprint,
      },
    });

    await this.audit.record({
      entityType: 'FinancialCorrection',
      entityId: id,
      // `create`: the correction record is created. The audit enum is fixed and
      // deliberately not widened for this — a new value would need its own
      // migration, and "created a correction" is exactly what happened.
      action: 'create',
      reason,
      after: {
        targetKind: dto.targetKind,
        targetId: dto.targetId,
        amount: num(target!.amount),
        branchId: binToUuid(target!.branchId),
      },
    });
    return this.detail(binToUuid(id));
  }

  // ─────────────────────────────── preview ───────────────────────────────

  /**
   * What a correction would do — without writing anything: the record before and
   * after, every leg and the day it posts to, what goes back on the shelf, and
   * whether that day is closed (the approval would then wait). A record that may
   * not be corrected this way answers with its refusal, not an error, so the phone
   * can say why.
   */
  async preview(dto: PreviewCorrectionDto) {
    const hasDestination = dto.toMethod !== undefined || dto.toAccountId !== undefined;
    const action = actionOf(dto.targetKind, dto.action, hasDestination);
    const plan = await planFor(this.db as unknown as CorrectionDb, await this.planContext(), this.inputOf(dto, action));
    const day = await this.businessDay.today(plan.branchId);
    const closing = await this.db.dailyClosing.findUnique({
      where: { branchId_closingDate: { branchId: plan.branchId, closingDate: dateValue(day) } },
      select: { isLocked: true },
    });
    return {
      targetKind: plan.kind,
      action: plan.action,
      amount: plan.amount,
      ...plan.summary,
      legs: plan.legs.map((l) => ({ direction: l.direction, method: l.method, accountId: l.accountId, accountLabel: l.label, amount: l.amount })),
      /** The record, its own day and every close stay exactly as they are; the movement posts here. */
      correctionDate: day,
      dayClosed: closing?.isLocked ?? false,
      refusal: plan.refusal?.code ?? null,
      refusalMessage: plan.refusal?.message ?? null,
    };
  }

  // ─────────────────────────────── decide ────────────────────────────────

  /**
   * Approve. **This is the moment anything moves** — the only one.
   *
   * Owner-only at the route. The Owner may have requested it themselves in a
   * one-person shop, and that is allowed, but the request still had to exist:
   * requester and approver are recorded separately even when they are the same
   * person, so the record never reads as though a correction happened without
   * anybody asking for one.
   */
  async approve(idStr: string, dto: DecideCorrectionDto) {
    const correction = await this.load(idStr);
    assertDecidable(correction);

    /**
     * Everything posts to the current open business day at the record's branch —
     * never to the original record's day. If that day is closed, the correction
     * waits rather than a filed closing being reopened.
     */
    const day = await this.businessDay.today(correction.branchId);
    const correctionDate = dateValue(day);
    const userId = this.tenant.userId();
    const companyId = this.tenant.companyId();
    const ctx = await this.planContext(correction.branchId);
    let stockChanged = false;

    try {
      /**
       * One transaction, and the day's closing row locked the way a close locks it
       * (docs/51 §12.6): a close and an approval on the same day cannot interleave —
       * either the correction lands before the close reads its figures, or it waits
       * for the next open day. Optimistic concurrency still decides between two
       * owners approving the same request: the loser changes nothing.
       */
      await this.db.$transaction(
        async (tx) => {
          await tx.$queryRaw(Prisma.sql`
            SELECT id FROM daily_closings
             WHERE company_id = ${companyId} AND branch_id = ${correction.branchId} AND closing_date = ${day}
             FOR UPDATE`);
          const closing = await tx.dailyClosing.findUnique({
            where: { branchId_closingDate: { branchId: correction.branchId, closingDate: correctionDate } },
          });
          assertDayOpen(closing, day);

          // Lock what the correction changes, then plan again: the record as it is NOW decides.
          const plan = PLANNED.has(correction.targetKind as CorrectionKind)
            ? await this.lockAndPlan(tx as unknown as CorrectionDb, ctx, correction)
            : null;
          if (plan?.refusal) throw new ConflictException(plan.refusal);

          const moved = await tx.financialCorrection.updateMany({
            where: { id: correction.id, companyId, version: dto.expectedVersion, status: 'requested' },
            data: { status: 'approved', decidedById: userId ?? null, decidedAt: new Date(), correctionDate, version: { increment: 1 } },
          });
          if (moved.count === 0) {
            throw new ConflictException({ code: 'refresh_required', message: 'This correction changed while you were looking at it. Open it again.' });
          }

          let before: Record<string, unknown> = {};
          let after: Record<string, unknown> = { correctionDate: day, amount: num(correction.amount) };
          if (plan) {
            const applied = await this.applyPlan(tx as unknown as CorrectionDb, correction.id, correction.reason, plan);
            before = applied.before;
            after = { ...after, ...applied.after };
            stockChanged = applied.stockChanged;
          } else if (correction.targetRefundPayoutId) {
            /**
             * Mark the payout as superseded, so a REPLACEMENT can be reported.
             *
             * Found by the live lifecycle test: `0038` made `return_request_id` unique
             * because a return is settled once or not at all, which meant a corrected
             * refund could never be paid again — the brief requires that it can.
             *
             * This writes ONE back-reference and no financial field.
             */
            await tx.refundPayout.updateMany({
              where: { id: correction.targetRefundPayoutId, correctedById: null },
              data: { correctedById: correction.id },
            });
          }

          await this.audit.recordTx(tx, {
            entityType: 'FinancialCorrection',
            entityId: correction.id,
            // The status change IS the event: requested → approved is the moment anything moves.
            action: 'status_change',
            reason: correction.reason,
            before: this.jsonOf(before),
            after: this.jsonOf(after),
            branchId: correction.branchId,
          });
        },
        { timeout: 20_000 },
      );
    } catch (e) {
      // A second approved correction for the same record: the database's one-per-record key.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({ code: 'already_corrected', message: 'This record has already been corrected.' });
      }
      throw e;
    }

    /**
     * Recompute the day's figures. Without this the movement never reaches the
     * rollup or expected cash — the correction would restore the liability and
     * leave the till reporting a shortage that no longer exists.
     */
    await this.rollups.recomputeDaily(companyId, correction.branchId, day);
    if (stockChanged) this.queue.enqueueBranchRefresh({ companyId, branchId: correction.branchId });

    return this.detail(idStr);
  }

  /** Reject. Changes nothing financial; the record stands as confirmed. */
  async reject(idStr: string, dto: DecideCorrectionDto) {
    const correction = await this.load(idStr);
    assertDecidable(correction);

    const moved = await this.db.financialCorrection.updateMany({
      where: { id: correction.id, companyId: this.tenant.companyId(), version: dto.expectedVersion, status: 'requested' },
      data: { status: 'rejected', decidedById: this.tenant.userId() ?? null, decidedAt: new Date(), version: { increment: 1 } },
    });
    if (moved.count === 0) {
      throw new ConflictException({ code: 'refresh_required', message: 'This correction changed while you were looking at it. Open it again.' });
    }

    await this.audit.record({
      entityType: 'FinancialCorrection',
      entityId: correction.id,
      action: 'status_change',
      reason: dto.note?.trim() || correction.reason,
      branchId: correction.branchId,
    });

    return this.detail(idStr);
  }

  // ──────────────────────────── approval internals ────────────────────────────

  /**
   * Lock the rows a correction changes, in one order (the record, then its phones,
   * then its stock), and plan it again against what is there now.
   */
  private async lockAndPlan(tx: CorrectionDb, ctx: PlanContext, c: Awaited<ReturnType<CorrectionsService['load']>>): Promise<TargetPlan> {
    const companyId = ctx.companyId;
    if (c.targetPaymentId) {
      await tx.$queryRaw(Prisma.sql`
        SELECT s.id FROM sales s JOIN payments p ON p.sale_id = s.id
         WHERE s.company_id = ${companyId} AND p.id = ${c.targetPaymentId} FOR UPDATE`);
    }
    if (c.targetSaleId) {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM sales WHERE company_id = ${companyId} AND id = ${c.targetSaleId} FOR UPDATE`);
      await tx.$queryRaw(Prisma.sql`
        SELECT u.id FROM units u JOIN sale_items si ON si.unit_id = u.id
         WHERE u.company_id = ${companyId} AND si.sale_id = ${c.targetSaleId} ORDER BY u.id FOR UPDATE`);
    }
    if (c.targetExpenseId) {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM expenses WHERE company_id = ${companyId} AND id = ${c.targetExpenseId} FOR UPDATE`);
    }
    if (c.targetSupplierPaymentId) {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM supplier_payments WHERE company_id = ${companyId} AND id = ${c.targetSupplierPaymentId} FOR UPDATE`);
    }
    if (c.targetPurchaseId) {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM purchases WHERE company_id = ${companyId} AND id = ${c.targetPurchaseId} FOR UPDATE`);
      await tx.$queryRaw(Prisma.sql`SELECT id FROM units WHERE company_id = ${companyId} AND purchase_id = ${c.targetPurchaseId} ORDER BY id FOR UPDATE`);
      await tx.$queryRaw(Prisma.sql`
        SELECT si.id FROM stock_items si
         WHERE si.company_id = ${companyId} AND si.branch_id = ${c.branchId}
           AND si.product_id IN (SELECT pi.product_id FROM purchase_items pi WHERE pi.purchase_id = ${c.targetPurchaseId})
         ORDER BY si.product_id FOR UPDATE`);
    }
    const targetId = c.targetPaymentId ?? c.targetSaleId ?? c.targetExpenseId ?? c.targetSupplierPaymentId ?? c.targetPurchaseId;
    return planFor(tx, { ...ctx, branchId: c.branchId, ignoreCorrectionId: c.id }, {
      kind: c.targetKind as CorrectionKind,
      action: c.action as CorrectionAction,
      targetId: binToUuid(targetId!),
      // What was asked for is what is done: the amount and the destination the request carried.
      amount: c.targetKind === 'sale' || c.targetKind === 'purchase' ? undefined : num(c.amount),
      toMethod: (c.toMethod as 'cash' | 'account' | null) ?? undefined,
      toAccountId: c.toReceivingAccountId ? binToUuid(c.toReceivingAccountId) : undefined,
    });
  }

  /**
   * Write what an approved correction moves: its legs, then the state that follows
   * it. Never the corrected record itself.
   */
  private async applyPlan(tx: CorrectionDb, correctionId: Buffer, reason: string, plan: TargetPlan) {
    const companyId = this.tenant.companyId();
    const userId = this.tenant.userId() ?? null;
    if (plan.legs.length > 0) {
      await tx.financialCorrectionLeg.createMany({
        data: plan.legs.map((l) => ({
          id: newUuidV7Bin(),
          companyId,
          correctionId,
          direction: l.direction === 'in' ? 'incoming' : 'outgoing',
          method: l.method,
          receivingAccountId: l.method === 'cash' || !l.accountId ? null : uuidToBin(l.accountId),
          accountLabelSnapshot: l.label,
          amount: l.amount,
          sourcePaymentId: l.sourcePaymentId ?? null,
          sourceSupplierPaymentId: l.sourceSupplierPaymentId ?? null,
          sourceExpenseId: l.sourceExpenseId ?? null,
        })),
      });
    }

    const e = plan.effects;
    const before: Record<string, unknown> = { ...plan.summary };
    const after: Record<string, unknown> = {
      targetKind: plan.kind,
      action: plan.action,
      legs: plan.legs.map((l) => ({ direction: l.direction, method: l.method, accountLabel: l.label, amount: l.amount })),
    };

    // The sale's receivable caches, exactly as a collection writes them — never its lines, totals or payments.
    if (e.sale) {
      await tx.sale.update({ where: { id: e.sale.id }, data: { amountPaid: e.sale.collected, balanceDue: e.sale.owed, payStatus: e.sale.payStatus } });
      const delta = round2(e.sale.owed - e.sale.owedBefore);
      if (e.sale.customerId && Math.abs(delta) >= 0.005) {
        await tx.customer.update({ where: { id: e.sale.customerId }, data: { balance: { increment: delta } } });
      }
      after.sale = { collected: e.sale.collected, owed: e.sale.owed, payStatus: e.sale.payStatus };
    }

    for (const u of e.units ?? []) {
      const moved = await tx.unit.updateMany({
        where: { id: u.id, status: u.from },
        data: { status: u.to, ...(u.to === 'in_stock' ? { dateSold: null } : {}), updatedById: userId },
      });
      if (moved.count !== 1) {
        throw new ConflictException({ code: 'unit_moved', message: 'A phone changed while this was being approved. Open it again.' });
      }
      // The phone's own history: the timeline reads status changes from the audit log.
      await this.audit.recordTx(tx as unknown as Parameters<AuditService['recordTx']>[0], {
        entityType: 'Unit',
        entityId: u.id,
        action: 'status_change',
        reason: plan.kind === 'sale' ? `Sale cancelled: ${reason}` : `Purchase cancelled: ${reason}`,
        before: { status: u.from },
        after: { status: u.to, correctionId: binToUuid(correctionId) },
        branchId: plan.branchId,
      });
    }

    if (e.releaseLines?.length) {
      await tx.saleItem.updateMany({ where: { id: { in: e.releaseLines }, releasedByCorrectionId: null }, data: { releasedByCorrectionId: correctionId } });
    }

    for (const r of e.restock ?? []) {
      await receiveQuantityAtCost(tx, { companyId, productId: r.productId, branchId: plan.branchId, received: r.quantity, unitCost: r.unitCost });
    }

    for (const d of e.destock ?? []) {
      const changed = await tx.stockItem.updateMany({
        where: { productId: d.productId, branchId: plan.branchId },
        data: { quantity: d.quantity, cost: d.cost },
      });
      if (changed.count !== 1) {
        throw new ConflictException({ code: 'stock_short', message: 'The shop no longer holds everything this purchase brought.' });
      }
    }

    return {
      before,
      after,
      stockChanged: (e.units?.length ?? 0) > 0 || (e.restock?.length ?? 0) > 0 || (e.destock?.length ?? 0) > 0,
    };
  }

  // ──────────────────────────────── reads ────────────────────────────────

  async list(query: ListCorrectionsDto) {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
    const rows = await this.db.financialCorrection.findMany({
      where: { ...(query.status ? { status: query.status } : {}) },
      ...(query.cursor ? { cursor: { id: uuidToBin(query.cursor) }, skip: 1 } : {}),
      orderBy: { id: 'desc' },
      take: limit + 1,
      include: this.includes(),
    });
    const page = rows.slice(0, limit);
    return {
      rows: page.map((r) => this.shape(r)),
      nextCursor: rows.length > limit ? binToUuid(page[page.length - 1]!.id) : null,
    };
  }

  async detail(idStr: string) {
    const row = await this.loadFull(idStr);
    return this.shape(row);
  }

  // ─────────────────────────────── internals ─────────────────────────────

  private async planContext(branchId?: Buffer): Promise<PlanContext> {
    const branch = branchId ?? this.tenant.requireBranchId();
    return {
      companyId: this.tenant.companyId(),
      branchId: branch,
      today: await this.businessDay.today(branch),
      costView: this.cls.get('permissions')?.has('cost.view') ?? false,
    };
  }

  private inputOf(dto: RequestCorrectionDto | PreviewCorrectionDto, action: CorrectionAction): PlanInput {
    return { kind: dto.targetKind, action, targetId: dto.targetId, toMethod: dto.toMethod, toAccountId: dto.toAccountId, amount: dto.amount };
  }

  /** Audit JSON: Buffers never reach it (ids are UUID strings everywhere a plan shows them). */
  private jsonOf(v: Record<string, unknown>): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(v, (_k, value) => (value && value.type === 'Buffer' && Array.isArray(value.data) ? binToUuid(Buffer.from(value.data)) : value))) as Prisma.InputJsonValue;
  }

  private includes() {
    return {
      requestedBy: { select: { name: true } },
      decidedBy: { select: { name: true } },
      legs: { select: { direction: true, method: true, accountLabelSnapshot: true, amount: true } },
    } as const;
  }

  /**
   * A malformed id is a 404, not a 500.
   *
   * `uuidToBin` throws on anything that is not a UUID, and without this guard
   * the global filter turns that into a server error. This project has now
   * shipped that exact defect twice — in sales (I1) and in suppliers (J1) — so
   * it is guarded here before anybody can find it a third time.
   */
  private async loadFull(idStr: string) {
    if (!isUuid(idStr)) throw new NotFoundException('Correction not found');
    const row = await this.db.financialCorrection.findFirst({ where: { id: uuidToBin(idStr) }, include: this.includes() });
    if (!row) throw new NotFoundException('Correction not found');
    return row;
  }

  private async load(idStr: string) {
    if (!isUuid(idStr)) throw new NotFoundException('Correction not found');
    const row = await this.db.financialCorrection.findFirst({ where: { id: uuidToBin(idStr) } });
    if (!row) throw new NotFoundException('Correction not found');
    return row;
  }

  /**
   * The target, normalised to the handful of fields a correction copies.
   *
   * Both are read through the tenant client, so another company's payment is
   * simply not found — the same 404 an unknown id produces.
   */
  private async loadTarget(kind: 'refund_payout' | 'supplier_settlement', idStr: string) {
    if (!isUuid(idStr)) return null;
    const id = uuidToBin(idStr);

    if (kind === 'refund_payout') {
      const p = await this.db.refundPayout.findFirst({ where: { id } });
      return p
        ? { status: p.status as string, branchId: p.branchId, amount: p.reportedAmount, method: p.method, accountLabel: p.accountLabelSnapshot }
        : null;
    }

    const s = await this.db.supplierSettlement.findFirst({ where: { id } });
    return s ? { status: s.status as string, branchId: s.branchId, amount: s.amount, method: s.method, accountLabel: s.accountLabelSnapshot } : null;
  }

  private shape(r: {
    id: Buffer;
    targetKind: string;
    action: string;
    targetRefundPayoutId: Buffer | null;
    targetSupplierSettlementId: Buffer | null;
    targetPaymentId: Buffer | null;
    targetSaleId: Buffer | null;
    targetExpenseId: Buffer | null;
    targetSupplierPaymentId: Buffer | null;
    targetPurchaseId: Buffer | null;
    toMethod: string | null;
    toAccountLabelSnapshot: string | null;
    status: string;
    reason: string;
    supportingReference: string | null;
    amount: Prisma.Decimal;
    method: string | null;
    accountLabelSnapshot: string | null;
    requestedAt: Date;
    decidedAt: Date | null;
    correctionDate: Date | null;
    version: number;
    requestedBy?: { name: string } | null;
    decidedBy?: { name: string } | null;
    legs?: { direction: string; method: string; accountLabelSnapshot: string | null; amount: Prisma.Decimal }[];
  }) {
    const target =
      r.targetRefundPayoutId ?? r.targetSupplierSettlementId ?? r.targetPaymentId ?? r.targetSaleId ?? r.targetExpenseId ?? r.targetSupplierPaymentId ?? r.targetPurchaseId;
    return {
      id: binToUuid(r.id),
      targetKind: r.targetKind,
      action: r.action,
      targetId: target ? binToUuid(target) : null,
      /** A reclassification's destination; null for everything else. */
      to: r.action === 'reclassify' ? { method: r.toMethod ?? null, accountLabel: r.toAccountLabelSnapshot ?? null } : null,
      status: r.status,
      reason: r.reason,
      supportingReference: r.supportingReference,
      amount: num(r.amount),
      method: r.method,
      accountLabel: r.accountLabelSnapshot,
      requestedBy: r.requestedBy?.name ?? null,
      requestedAt: r.requestedAt.toISOString(),
      decidedBy: r.decidedBy?.name ?? null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      /** The business day everything posts to. */
      correctionDate: r.correctionDate ? dayKey(r.correctionDate) : null,
      /** The money it moved, once approved: each leg's channel, direction and amount. */
      legs: (r.legs ?? []).map((l) => ({
        direction: l.direction === 'incoming' ? 'in' : 'out',
        method: l.method,
        accountLabel: l.accountLabelSnapshot,
        amount: num(l.amount),
      })),
      version: r.version,
    };
  }
}
