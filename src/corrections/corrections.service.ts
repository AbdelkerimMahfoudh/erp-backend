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
import {
  assertDayOpen,
  assertDecidable,
  assertNoOpenRequest,
  assertNotAlreadyCorrected,
  assertReasonGiven,
  assertTargetCorrectable,
  fingerprintCorrection,
  assertReclassifiable,
} from './correction-rules';
import {
  DecideCorrectionDto,
  ListCorrectionsDto,
  RequestCorrectionDto,
  PreviewCorrectionDto,
} from './dto/correction.dto';

const num = (d: Prisma.Decimal | number | null | undefined): number => (d == null ? 0 : Number(d));
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Correcting a payment that was already confirmed (Milestone B).
 *
 * **Nothing here rewrites the payment being corrected.** Not its amount, not
 * its status, not its receipt. A correction is an append-only record beside it,
 * and the liability comes back because every derivation of "what is owed"
 * excludes a target carrying an approved correction — see `correction-sql.ts`.
 *
 * Three things follow from that, and they are the whole design:
 *
 *   **The original day is untouched.** The payment really did happen when it
 *   happened, its rollup recorded it, and its closing may be locked. The
 *   compensating movement lands on the CURRENT open day instead.
 *
 *   **The liability returns exactly once**, because it is derived rather than
 *   decremented. There is no counter to get wrong, and the database refuses a
 *   second approved correction per target.
 *
 *   **No profit moves.** Profit was reversed at return approval, or never
 *   involved at all for a supplier payment. A correction moves cash and
 *   liability only — it is not a sale, not an expense, and not a second
 *   return effect.
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
  ) {}

  // ─────────────────────────────── request ───────────────────────────────

  /**
   * Ask for a correction. **Moves no money.** It records that somebody believes
   * a confirmed payment was wrong, and waits for an owner.
   */
  async request(dto: RequestCorrectionDto) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.userId();

    const reason = assertReasonGiven(dto.reason);
    const fingerprint = fingerprintCorrection({
      targetKind: dto.targetKind,
      targetId: dto.targetId,
      reason,
      supportingReference: dto.supportingReference,
      toMethod: dto.toMethod ?? null,
      toAccountId: dto.toAccountId ?? null,
      amount: dto.amount ?? null,
    });

    /**
     * The idempotent replay, checked first. Same key and same payload returns
     * the original; same key and a different payload is a conflict, because
     * that is a second correction wearing the first one's id.
     */
    const replay = await this.db.financialCorrection.findFirst({
      where: { companyId, clientUuid: uuidToBin(dto.clientUuid) },
    });
    if (replay) {
      if (replay.clientRequestHash !== fingerprint) {
        throw new ConflictException({
          code: 'idempotency_conflict',
          message: 'That request id was already used for a different correction.',
        });
      }
      return this.detail(binToUuid(replay.id));
    }

    if (dto.targetKind === 'sale_payment') {
      return this.requestReclassification(dto, reason, fingerprint);
    }
    if (dto.toMethod !== undefined || dto.toAccountId !== undefined || dto.amount !== undefined) {
      throw new BadRequestException({
        code: 'not_a_reclassification',
        message: 'Only a sale payment can be moved to another channel. A refund or a supplier payment is corrected as a whole.',
      });
    }
    const target = await this.loadTarget(dto.targetKind, dto.targetId);
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
        targetRefundPayoutId:
          dto.targetKind === 'refund_payout' ? uuidToBin(dto.targetId) : null,
        targetSupplierSettlementId:
          dto.targetKind === 'supplier_settlement' ? uuidToBin(dto.targetId) : null,
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

    // Unused here, but keeps the branch-scoped reader honest about context.
    void branchId;
    return this.detail(binToUuid(id));
  }

  // ─────────────────────────────── decide ────────────────────────────────

  /**
   * Approve. **This is the moment money moves back** — the only one.
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
     * The compensating movement belongs to the current open business day at the
     * branch that paid — never to the original payment's day. If that day is
     * closed, the correction waits rather than a filed closing being reopened.
     */
    const day = await this.businessDay.today(correction.branchId);
    const correctionDate = dateValue(day);
    const userId = this.tenant.userId();
    const companyId = this.tenant.companyId();
    const before = correction.targetKind === 'sale_payment' && correction.targetPaymentId
      ? await this.db.payment.findFirst({
          where: { id: correction.targetPaymentId },
          select: { method: true, amount: true, receivingAccountId: true, accountLabelSnapshot: true, businessDate: true },
        })
      : null;

    /**
     * One transaction, and the day's closing row locked the way a close locks it
     * (docs/51 §12.6): a close and an approval on the same day cannot interleave —
     * either the correction lands before the close reads its figures, or it waits
     * for the next open day. Optimistic concurrency still decides between two
     * owners approving the same request: the loser changes nothing.
     */
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT id FROM daily_closings
         WHERE company_id = ${companyId} AND branch_id = ${correction.branchId} AND closing_date = ${day}
         FOR UPDATE`);
      const closing = await tx.dailyClosing.findUnique({
        where: { branchId_closingDate: { branchId: correction.branchId, closingDate: correctionDate } },
      });
      assertDayOpen(closing, day);

      const moved = await tx.financialCorrection.updateMany({
        where: {
          id: correction.id,
          companyId,
          version: dto.expectedVersion,
          status: 'requested',
        },
        data: {
          status: 'approved',
          decidedById: userId ?? null,
          decidedAt: new Date(),
          correctionDate,
          version: { increment: 1 },
        },
      });
      if (moved.count === 0) {
        throw new ConflictException({
          code: 'refresh_required',
          message: 'This correction changed while you were looking at it. Open it again.',
        });
      }

      /**
       * Mark the payout as superseded, so a REPLACEMENT can be reported.
       *
       * Found by the live lifecycle test: `0038` made `return_request_id` unique
       * because a return is settled once or not at all, which meant a corrected
       * refund could never be paid again — the brief requires that it can.
       *
       * This writes ONE back-reference and no financial field. A reclassified
       * payment gets nothing at all: its row is never written (0078).
       */
      if (correction.targetRefundPayoutId) {
        await tx.refundPayout.updateMany({
          where: { id: correction.targetRefundPayoutId, correctedById: null },
          data: { correctedById: correction.id },
        });
      }

      await this.audit.recordTx(tx, {
        entityType: 'FinancialCorrection',
        entityId: correction.id,
        // The status change IS the event: requested → approved is the moment money moves.
        action: 'status_change',
        reason: correction.reason,
        ...(before
          ? {
              before: {
                paymentId: binToUuid(correction.targetPaymentId!),
                method: before.method,
                account: before.accountLabelSnapshot,
                amount: num(before.amount),
                paymentDay: dayKey(before.businessDate),
              },
            }
          : {}),
        after: {
          correctionDate: day,
          amount: num(correction.amount),
          ...(correction.targetKind === 'sale_payment'
            ? { from: { method: correction.method, account: correction.accountLabelSnapshot }, to: { method: correction.toMethod, account: correction.toAccountLabelSnapshot } }
            : {}),
        },
        branchId: correction.branchId,
      });
    });

    /**
     * Recompute the day's figures. Without this the compensating movement never
     * reaches the rollup or expected cash — the correction would restore the
     * liability and leave the till reporting a shortage that no longer exists.
     * The live test caught exactly that.
     */
    await this.rollups.recomputeDaily(companyId, correction.branchId, day);

    return this.detail(idStr);
  }

  /** Reject. Changes nothing financial; the payment stands as confirmed. */
  async reject(idStr: string, dto: DecideCorrectionDto) {
    const correction = await this.load(idStr);
    assertDecidable(correction);

    const moved = await this.db.financialCorrection.updateMany({
      where: {
        id: correction.id,
        companyId: this.tenant.companyId(),
        version: dto.expectedVersion,
        status: 'requested',
      },
      data: {
        status: 'rejected',
        decidedById: this.tenant.userId() ?? null,
        decidedAt: new Date(),
        version: { increment: 1 },
      },
    });
    if (moved.count === 0) {
      throw new ConflictException({
        code: 'refresh_required',
        message: 'This correction changed while you were looking at it. Open it again.',
      });
    }

    await this.audit.record({
      entityType: 'FinancialCorrection',
      entityId: correction.id,
      action: 'status_change',
      reason: dto.note?.trim() || correction.reason,
    });

    return this.detail(idStr);
  }

  // ───────────────────── reclassifying a payment (0078) ─────────────────────

  /**
   * What moving a payment to another channel would do — without writing anything.
   * The before and after of the payment's channel, the two legs of the movement
   * and the day they would post to, and whether that day is closed (the approval
   * would then wait for the next open day). Refusals are thrown exactly as the
   * request would throw them.
   */
  async preview(dto: PreviewCorrectionDto) {
    const target = await this.loadPaymentTarget(dto.targetId);
    const destination = await this.destinationOf(dto.toMethod, dto.toAccountId);
    const amount = dto.amount ?? target.amount;
    assertReclassifiable(
      { amount: target.amount, fromMethod: target.fromMethod, fromAccountId: target.fromAccountId },
      { toMethod: dto.toMethod, toAccountId: dto.toAccountId ?? null, toAccountActive: destination.active },
      amount,
    );
    const existing = await this.db.financialCorrection.findMany({
      where: { targetPaymentId: uuidToBin(dto.targetId) },
      select: { status: true },
    });
    const day = await this.businessDay.today(target.branchId);
    const closing = await this.db.dailyClosing.findUnique({
      where: { branchId_closingDate: { branchId: target.branchId, closingDate: dateValue(day) } },
      select: { isLocked: true },
    });
    const refusal = existing.some((c) => c.status === 'approved')
      ? 'already_corrected'
      : existing.some((c) => c.status === 'requested')
        ? 'request_pending'
        : null;
    return {
      payment: {
        id: dto.targetId,
        saleId: target.saleId,
        invoiceNo: target.invoiceNo,
        amount: target.amount,
        method: target.fromMethod,
        accountLabel: target.accountLabel,
        paymentDay: target.paymentDay,
      },
      move: {
        amount: round2(amount),
        from: { method: target.fromMethod, accountId: target.fromAccountId, accountLabel: target.accountLabel },
        to: { method: dto.toMethod, accountId: dto.toAccountId ?? null, accountLabel: destination.label },
      },
      /** The payment row, its own day and every close stay exactly as they are; the movement posts here. */
      correctionDate: day,
      dayClosed: closing?.isLocked ?? false,
      unchanged: { saleTotal: target.saleTotal, collected: target.saleAmountPaid, owed: target.saleBalanceDue },
      refusal,
    };
  }

  private async requestReclassification(dto: RequestCorrectionDto, reason: string, fingerprint: string) {
    const companyId = this.tenant.companyId();
    const userId = this.tenant.userId();
    if (!dto.toMethod) {
      throw new BadRequestException({ code: 'destination_required', message: 'Say which channel the money really reached.' });
    }
    const target = await this.loadPaymentTarget(dto.targetId);
    const destination = await this.destinationOf(dto.toMethod, dto.toAccountId);
    const amount = round2(dto.amount ?? target.amount);
    assertReclassifiable(
      { amount: target.amount, fromMethod: target.fromMethod, fromAccountId: target.fromAccountId },
      { toMethod: dto.toMethod, toAccountId: dto.toAccountId ?? null, toAccountActive: destination.active },
      amount,
    );
    const existing = await this.db.financialCorrection.findMany({
      where: { targetPaymentId: uuidToBin(dto.targetId) },
      select: { status: true },
    });
    assertNotAlreadyCorrected(existing);
    assertNoOpenRequest(existing);

    const id = newUuidV7Bin();
    await this.db.financialCorrection.create({
      data: {
        id,
        companyId,
        // The branch whose drawer the payment reached: the sale's branch.
        branchId: target.branchId,
        targetKind: 'sale_payment',
        targetPaymentId: uuidToBin(dto.targetId),
        status: 'requested',
        reason,
        supportingReference: dto.supportingReference?.trim() || null,
        amount,
        method: target.fromMethod,
        accountLabelSnapshot: target.accountLabel,
        toMethod: dto.toMethod,
        toReceivingAccountId: dto.toAccountId ? uuidToBin(dto.toAccountId) : null,
        toAccountLabelSnapshot: destination.label,
        requestedById: userId ?? null,
        clientUuid: uuidToBin(dto.clientUuid),
        clientRequestHash: fingerprint,
      },
    });
    await this.audit.record({
      entityType: 'FinancialCorrection',
      entityId: id,
      action: 'create',
      reason,
      before: { paymentId: dto.targetId, method: target.fromMethod, account: target.accountLabel, amount: target.amount },
      after: {
        targetKind: 'sale_payment',
        move: amount,
        to: { method: dto.toMethod, account: destination.label },
        branchId: binToUuid(target.branchId),
      },
      branchId: target.branchId,
    });
    return this.detail(binToUuid(id));
  }

  /**
   * A payment of THIS branch, normalised. Another branch's or another company's
   * payment is simply not found — the same 404 an unknown id produces — so a
   * correction can never be posted against a drawer the caller is not standing in.
   */
  private async loadPaymentTarget(idStr: string) {
    if (!isUuid(idStr)) throw new NotFoundException('That payment does not exist.');
    const branchId = this.tenant.requireBranchId();
    const p = await this.db.payment.findFirst({
      where: { id: uuidToBin(idStr), sale: { branchId } },
      select: {
        amount: true,
        method: true,
        receivingAccountId: true,
        accountLabelSnapshot: true,
        businessDate: true,
        sale: { select: { id: true, branchId: true, invoiceNo: true, total: true, amountPaid: true, balanceDue: true } },
      },
    });
    if (!p) throw new NotFoundException('That payment does not exist.');
    // The sale is READ for its branch and to show what does not change; a reclassification never writes it.
    const { sale: owner } = p;
    return {
      branchId: owner.branchId,
      saleId: binToUuid(owner.id),
      invoiceNo: owner.invoiceNo,
      amount: round2(num(p.amount)),
      fromMethod: (p.method === 'cash' ? 'cash' : 'account') as 'cash' | 'account',
      fromAccountId: p.method === 'cash' ? null : p.receivingAccountId ? binToUuid(p.receivingAccountId) : null,
      accountLabel: p.accountLabelSnapshot,
      paymentDay: dayKey(p.businessDate),
      saleTotal: round2(num(owner.total)),
      saleAmountPaid: round2(num(owner.amountPaid)),
      saleBalanceDue: round2(num(owner.balanceDue)),
    };
  }

  private async destinationOf(toMethod: 'cash' | 'account', toAccountId: string | undefined) {
    if (toMethod === 'cash' || !toAccountId) return { active: true, label: null as string | null };
    if (!isUuid(toAccountId)) throw new BadRequestException({ code: 'account_required', message: 'Say which account the money reached.' });
    const account = await this.db.receivingAccount.findFirst({
      where: { id: uuidToBin(toAccountId) },
      select: { isActive: true, label: true },
    });
    if (!account) throw new BadRequestException({ code: 'account_required', message: 'That account does not exist.' });
    return { active: account.isActive, label: account.label };
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

  private includes() {
    return {
      requestedBy: { select: { name: true } },
      decidedBy: { select: { name: true } },
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
    const row = await this.db.financialCorrection.findFirst({
      where: { id: uuidToBin(idStr) },
      include: this.includes(),
    });
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
        ? {
            status: p.status as string,
            branchId: p.branchId,
            amount: p.reportedAmount,
            method: p.method,
            accountLabel: p.accountLabelSnapshot,
          }
        : null;
    }

    const s = await this.db.supplierSettlement.findFirst({ where: { id } });
    return s
      ? {
          status: s.status as string,
          branchId: s.branchId,
          amount: s.amount,
          method: s.method,
          accountLabel: s.accountLabelSnapshot,
        }
      : null;
  }

  private shape(r: {
    id: Buffer;
    targetKind: string;
    targetRefundPayoutId: Buffer | null;
    targetSupplierSettlementId: Buffer | null;
    targetPaymentId?: Buffer | null;
    toMethod?: string | null;
    toAccountLabelSnapshot?: string | null;
    status: string;
    reason: string;
    supportingReference: string | null;
    amount: Prisma.Decimal;
    method: string;
    accountLabelSnapshot: string | null;
    requestedAt: Date;
    decidedAt: Date | null;
    correctionDate: Date | null;
    version: number;
    requestedBy?: { name: string } | null;
    decidedBy?: { name: string } | null;
  }) {
    return {
      id: binToUuid(r.id),
      targetKind: r.targetKind,
      targetId: r.targetRefundPayoutId
        ? binToUuid(r.targetRefundPayoutId)
        : r.targetSupplierSettlementId
          ? binToUuid(r.targetSupplierSettlementId)
          : r.targetPaymentId
            ? binToUuid(r.targetPaymentId)
            : null,
      /** A reclassified payment's destination (0078); null for a payout or a settlement. */
      to: r.targetKind === 'sale_payment' ? { method: r.toMethod ?? null, accountLabel: r.toAccountLabelSnapshot ?? null } : null,
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
      /** The business day the compensating movement posts to. */
      correctionDate: r.correctionDate ? dayKey(r.correctionDate) : null,
      version: r.version,
    };
  }
}
