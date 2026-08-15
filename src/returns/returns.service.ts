import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ReturnCustody, ReturnStatus } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { AppClsStore } from '../common/context/request-context';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { binToUuid, isUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { assertTransition as assertUnitTransition } from '../inventory/unit-state-machine';
import { evaluateEligibility } from '../sales/return-policy';
import { RollupService } from '../analytics/rollup.service';
import { dayKey } from '../common/utils/date.util';
import { parseDateRange, parseEnumList } from '../sales/sale-query';
import { toNum } from '../analytics/held-value';
import { ReturnNotifier } from './return-notifications';
import {
  AdjustmentDto,
  CreateReturnRequestDto,
  InvestigateDto,
  ListReturnsDto,
  ReceiveCustodyDto,
} from './dto/return.dto';
import {
  assertAmountMatchesDue,
  assertCorrectable,
  assertMethodAndAccount,
  assertReportable,
  assertWorthSettling,
  fingerprintPayout,
} from './refund-payout';
import {
  assertEditable,
  assertMayApprove,
  assertTransition,
  custodyIntakeNeeded,
  fingerprintRequest,
  grossRefundOf,
  isProvisionalMoney,
  priceAdjustment,
  settleRefund,
} from './return-workflow';

const RETURN_STATUSES = [
  'pending_investigation',
  'under_review',
  'approved_refund_due',
  'rejected',
] as const satisfies readonly ReturnStatus[];

const RESPONSIBILITIES = [
  'pending_investigation',
  'store_or_product_fault',
  'customer_damage',
  'other',
] as const;

const num = (d: Prisma.Decimal | number | null | undefined): number => (d == null ? 0 : Number(d));

/**
 * The reviewed return workflow (I2-CP3).
 *
 * Three rules run through everything here:
 *
 * **The server owns every number and every verdict.** Gross refund comes from
 * the immutable sale line, adjustment totals are multiplied and summed here,
 * and eligibility is recomputed from the sale's own I1 snapshot. The client
 * says which phone, what is wrong, and what is being withheld — nothing else.
 *
 * **Nothing financial happens in CP3.** No reversal, no refund obligation, no
 * rollup or closing change, and no unit reaches `faulty`. Every total this
 * returns is explicitly provisional until CP4 approves it.
 *
 * **Custody and unit status are one physical fact.** They move together inside
 * one transaction, because the moment they can disagree, one of them is a lie.
 */
@Injectable()
export class ReturnsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly notifier: ReturnNotifier,
    private readonly rollups: RollupService,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  // ────────────────────────────── create ──────────────────────────────

  async create(dto: CreateReturnRequestDto) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.userId();
    if (!userId) throw new BadRequestException('No authenticated user');

    const fingerprint = fingerprintRequest({
      saleItemId: dto.saleItemId,
      unitId: dto.identifier,
      requestReason: dto.requestReason,
      conditionNotes: dto.conditionNotes,
      custody: dto.custody as ReturnCustody,
    });

    /**
     * The idempotent replay, checked before any work. Same key and same payload
     * returns the original; same key and a different payload is a 409, because
     * that is not a retry.
     */
    const replay = await this.db.returnRequest.findFirst({
      where: { companyId, clientUuid: uuidToBin(dto.clientUuid) },
    });
    if (replay) {
      if (replay.clientRequestHash !== fingerprint) {
        throw new ConflictException({
          code: 'idempotency_conflict',
          message: 'That request id was already used for a different return.',
        });
      }
      return this.detail(binToUuid(replay.id));
    }

    // The sale line, with everything needed to judge it. Scoped to the active
    // branch: a line sold elsewhere is not this branch's to take back.
    const line = await this.db.saleItem.findFirst({
      where: { id: uuidToBin(dto.saleItemId), sale: { branchId } },
      include: {
        sale: true,
        unit: { select: { id: true, status: true, imeiPrimary: true, imeiSecondary: true, serialNo: true } },
      },
    });
    // Unknown, another company's, another branch's — one answer for all three.
    if (!line) throw new NotFoundException('Sale line not found');

    if (!line.unitId || !line.unit) {
      throw new BadRequestException(
        'Only phones and other serialized items can be returned in this version. Accessories are not yet supported.',
      );
    }
    if (line.voided) throw new ConflictException('That sale line was removed from the sale.');

    /**
     * The identifier must match the phone ON THIS LINE. Matching it against the
     * whole catalogue would let a request be raised by reading any phone in the
     * shop — the physical presentation is the entire point of the rule.
     */
    const presented = dto.identifier.trim();
    const matches =
      line.unit.imeiPrimary === presented ||
      line.unit.imeiSecondary === presented ||
      line.unit.serialNo === presented;
    if (!matches) {
      throw new BadRequestException({
        code: 'identifier_mismatch',
        message: 'That identifier does not belong to the phone on this sale line.',
      });
    }

    // Eligibility, recomputed from the sale's own I1 snapshot and the server
    // clock. Never taken from the request.
    const eligibility = evaluateEligibility({
      windowHours: line.sale.returnWindowHours,
      deadlineAt: line.sale.returnDeadlineAt,
      now: new Date(),
      isReversed: line.sale.isReversed,
      hasReturn: false,
      quantityOnly: false,
    });

    const takesCustody = dto.custody === 'store_holds';

    try {
      const id = newUuidV7Bin();
      await this.db.$transaction(async (tx) => {
        await tx.returnRequest.create({
          data: {
            id,
            companyId,
            branchId,
            saleId: line.saleId,
            saleItemId: line.id,
            unitId: line.unitId!,
            status: 'pending_investigation',
            clientUuid: uuidToBin(dto.clientUuid),
            clientRequestHash: fingerprint,
            requestedById: userId,
            requestReason: dto.requestReason.trim(),
            conditionNotes: dto.conditionNotes?.trim() ?? null,
            custody: takesCustody ? 'store_holds' : 'customer_holds',
            custodyReceivedAt: takesCustody ? new Date() : null,
            // The snapshot: what was promised, and what the server says about
            // it right now. Frozen here so a later settings change cannot alter
            // what this request was judged under.
            policyWindowHours: line.sale.returnWindowHours,
            policyDeadlineAt: line.sale.returnDeadlineAt,
            policyReason: eligibility.reason,
            requiresException: !eligibility.eligibleByPolicy,
          },
        });

        if (takesCustody) {
          await this.moveUnitForCustody(tx, line.unitId!, 'sold', 'returned');
        }

        await this.audit.recordTx(tx, {
          entityType: 'ReturnRequest',
          entityId: id,
          action: 'create',
          after: {
            saleItemId: binToUuid(line.id),
            custody: takesCustody ? 'store_holds' : 'customer_holds',
            policyReason: eligibility.reason,
            requiresException: !eligibility.eligibleByPolicy,
          },
          branchId,
        });
        if (takesCustody) {
          await this.audit.recordTx(tx, {
            entityType: 'Unit',
            entityId: line.unitId!,
            action: 'status_change',
            before: { status: 'sold' },
            after: { status: 'returned', reason: 'return custody intake' },
            branchId,
          });
        }

        await this.notifier.emit(tx, {
          event: 'requested',
          request: { id, companyId, branchId, requestedById: userId },
          invoiceNo: line.sale.invoiceNo,
          actorId: userId,
        });
      });

      return this.detail(binToUuid(id));
    } catch (e) {
      /**
       * The database is the authority on "one active claim per sale line". Two
       * concurrent requests both pass the checks above; only one survives the
       * unique index on (sale_item_id, claim_key), and the loser is told
       * plainly rather than shown a raw constraint error.
       */
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({
          code: 'return_already_open',
          message: 'A return is already open for this phone.',
        });
      }
      throw e;
    }
  }

  // ────────────────────────────── custody ──────────────────────────────

  async receiveCustody(idStr: string, dto: ReceiveCustodyDto) {
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.userId();
    const request = await this.load(idStr, branchId);

    assertEditable(request.status);

    // Already received: a no-op, not a failure. A counter tapping twice must
    // not produce an error.
    if (!custodyIntakeNeeded(request.custody)) return this.detail(idStr);

    const presented = dto.identifier.trim();
    const matches =
      request.unit.imeiPrimary === presented ||
      request.unit.imeiSecondary === presented ||
      request.unit.serialNo === presented;
    if (!matches) {
      throw new BadRequestException({
        code: 'identifier_mismatch',
        message: 'That identifier does not belong to the phone on this return.',
      });
    }

    await this.db.$transaction(async (tx) => {
      const moved = await tx.returnRequest.updateMany({
        where: { id: request.id, companyId: this.tenant.companyId(), version: dto.expectedVersion },
        data: {
          custody: 'store_holds',
          custodyReceivedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (moved.count === 0) throw this.staleWrite();

      await this.moveUnitForCustody(tx, request.unitId, 'sold', 'returned');

      await this.audit.recordTx(tx, {
        entityType: 'ReturnRequest',
        entityId: request.id,
        action: 'update',
        before: { custody: request.custody },
        after: { custody: 'store_holds' },
        branchId,
      });
      await this.audit.recordTx(tx, {
        entityType: 'Unit',
        entityId: request.unitId,
        action: 'status_change',
        before: { status: 'sold' },
        after: { status: 'returned', reason: 'return custody intake' },
        branchId,
      });
      await this.notifier.emit(tx, {
        event: 'custody_received',
        request: { id: request.id, companyId: request.companyId, branchId, requestedById: request.requestedById },
        invoiceNo: request.sale.invoiceNo,
        actorId: userId ?? null,
      });
    });

    return this.detail(idStr);
  }

  // ──────────────────────────── investigation ────────────────────────────

  async investigate(idStr: string, dto: InvestigateDto) {
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.userId();
    const request = await this.load(idStr, branchId);
    assertEditable(request.status);

    if (dto.responsibility === 'other' && !dto.responsibilityNotes?.trim()) {
      // "Other" on its own explains nothing to whoever reads this in a month.
      throw new BadRequestException('Explain what "other" means for this return');
    }

    // Starting an investigation is itself a transition, and it must be legal.
    const nextStatus: ReturnStatus =
      request.status === 'pending_investigation' ? 'under_review' : request.status;
    if (nextStatus !== request.status) assertTransition(request.status, nextStatus);

    await this.db.$transaction(async (tx) => {
      const moved = await tx.returnRequest.updateMany({
        where: { id: request.id, companyId: this.tenant.companyId(), version: dto.expectedVersion },
        data: {
          status: nextStatus,
          ...(dto.responsibility ? { responsibility: dto.responsibility } : {}),
          ...(dto.responsibilityNotes !== undefined
            ? { responsibilityNotes: dto.responsibilityNotes?.trim() || null }
            : {}),
          ...(dto.conditionNotes !== undefined
            ? { conditionNotes: dto.conditionNotes?.trim() || null }
            : {}),
          reviewedById: userId ?? null,
          reviewedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (moved.count === 0) throw this.staleWrite();

      await this.audit.recordTx(tx, {
        entityType: 'ReturnRequest',
        entityId: request.id,
        action: 'update',
        before: { status: request.status, responsibility: request.responsibility },
        after: { status: nextStatus, responsibility: dto.responsibility ?? request.responsibility },
        reason: dto.responsibilityNotes?.trim() || undefined,
        branchId,
      });

      // The requester hears that somebody is looking at it — without the
      // defect detail or anything financial.
      await this.notifier.emit(tx, {
        event: 'under_review',
        request: { id: request.id, companyId: request.companyId, branchId, requestedById: request.requestedById },
        invoiceNo: request.sale.invoiceNo,
        actorId: userId ?? null,
      });
    });

    return this.detail(idStr);
  }

  // ───────────────────────────── adjustments ─────────────────────────────

  async addAdjustment(idStr: string, dto: AdjustmentDto) {
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.userId();
    const request = await this.load(idStr, branchId);
    assertEditable(request.status);

    const { totalAmount } = priceAdjustment(dto);
    const gross = grossRefundOf({
      price: num(request.saleItem.price),
      quantity: request.saleItem.quantity,
      discount: num(request.saleItem.discount),
    });

    // Validated against everything already drafted, so the ceiling holds for
    // the SET of lines rather than for each one in isolation.
    const existing = await this.db.returnAdjustment.findMany({
      where: { returnRequestId: request.id },
      select: { totalAmount: true },
    });
    settleRefund(gross, [...existing.map((a) => ({ totalAmount: num(a.totalAmount) })), { totalAmount }]);

    const id = newUuidV7Bin();
    await this.db.$transaction(async (tx) => {
      const bumped = await tx.returnRequest.updateMany({
        where: { id: request.id, companyId: this.tenant.companyId(), version: dto.expectedVersion },
        data: { version: { increment: 1 } },
      });
      if (bumped.count === 0) throw this.staleWrite();

      await tx.returnAdjustment.create({
        data: {
          id,
          companyId: request.companyId,
          returnRequestId: request.id,
          kind: dto.kind,
          label: dto.label.trim(),
          quantity: dto.quantity,
          unitAmount: dto.unitAmount,
          totalAmount,
          createdById: userId ?? null,
        },
      });

      await this.audit.recordTx(tx, {
        entityType: 'ReturnAdjustment',
        entityId: id,
        action: 'create',
        after: { kind: dto.kind, label: dto.label.trim(), quantity: dto.quantity, totalAmount },
        branchId,
      });
    });

    return this.detail(idStr);
  }

  async removeAdjustment(idStr: string, adjustmentId: string, expectedVersion: number) {
    const branchId = this.tenant.requireBranchId();
    const request = await this.load(idStr, branchId);
    assertEditable(request.status);
    if (!isUuid(adjustmentId)) throw new NotFoundException('Adjustment not found');

    const adjustment = await this.db.returnAdjustment.findFirst({
      where: { id: uuidToBin(adjustmentId), returnRequestId: request.id },
    });
    if (!adjustment) throw new NotFoundException('Adjustment not found');

    await this.db.$transaction(async (tx) => {
      const bumped = await tx.returnRequest.updateMany({
        where: { id: request.id, companyId: this.tenant.companyId(), version: expectedVersion },
        data: { version: { increment: 1 } },
      });
      if (bumped.count === 0) throw this.staleWrite();

      await tx.returnAdjustment.delete({ where: { id: adjustment.id } });
      await this.audit.recordTx(tx, {
        entityType: 'ReturnAdjustment',
        entityId: adjustment.id,
        action: 'delete',
        before: { label: adjustment.label, totalAmount: num(adjustment.totalAmount) },
        branchId,
      });
    });

    return this.detail(idStr);
  }

  // ────────────────────────────── decisions ──────────────────────────────

  /**
   * Approve a return: create the refund OBLIGATION, and nothing more.
   *
   * The word "obligation" is load-bearing. Approval says the shop owes this
   * money; it does not say a note left the till. Confirming that is I3, and
   * every message here is worded so nobody reads it as payment.
   *
   * Six things must hold, and the order is deliberate — cheapest refusals and
   * the ones a person can act on come first.
   */
  async approve(idStr: string, dto: { expectedVersion: number; exceptionReason?: string }) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.userId();
    const request = await this.load(idStr, branchId);

    assertEditable(request.status);
    assertTransition(request.status, 'approved_refund_due');

    /**
     * The phone must be here. Approving a refund for a device nobody has seen
     * is the exact failure the custody model exists to prevent.
     */
    if (request.custody !== 'store_holds') {
      throw new ConflictException({
        code: 'custody_required',
        message: 'Receive the phone before approving this return.',
      });
    }

    const { isException } = assertMayApprove({
      requiresException: request.requiresException,
      responsibility: request.responsibility,
      permissions: this.cls.get('permissions') ?? new Set<string>(),
      exceptionReason: dto.exceptionReason,
    });

    // Money, from the immutable line and the drafted adjustments. Never from
    // the request.
    const gross = grossRefundOf({
      price: num(request.saleItem.price),
      quantity: request.saleItem.quantity,
      discount: num(request.saleItem.discount),
    });
    const adjustments = await this.db.returnAdjustment.findMany({
      where: { returnRequestId: request.id },
      select: { totalAmount: true },
    });
    const { adjustmentTotal, netRefundDue } = settleRefund(
      gross,
      adjustments.map((a) => ({ totalAmount: num(a.totalAmount) })),
    );

    /**
     * The reversal belongs to TODAY, the approval day — never the sale's day.
     * If today is already closed for this branch, its locked snapshot would
     * permanently disagree with a recomputed rollup, so the approval is refused
     * rather than reopening a closing. That refusal is the single accounting
     * rule this phase must not get wrong.
     */
    const approvalDay = dayKey(new Date());
    const approvalDate = new Date(`${approvalDay}T00:00:00.000Z`);
    const closing = await this.db.dailyClosing.findUnique({
      where: { branchId_closingDate: { branchId, closingDate: approvalDate } },
    });
    if (closing?.isLocked) {
      throw new ConflictException({
        code: 'day_already_closed',
        message: `${approvalDay} is already closed for this branch. Approve this return tomorrow, or ask the owner to review the closing.`,
      });
    }

    const reversalId = newUuidV7Bin();
    await this.db.$transaction(async (tx) => {
      // Compare-and-swap on the version: approve and reject race, and exactly
      // one of them wins.
      const moved = await tx.returnRequest.updateMany({
        where: { id: request.id, companyId, version: dto.expectedVersion, status: request.status },
        data: {
          status: 'approved_refund_due',
          custody: 'retained_hold',
          decidedById: userId ?? null,
          decidedAt: new Date(),
          exceptionReason: isException ? dto.exceptionReason!.trim() : null,
          version: { increment: 1 },
        },
      });
      if (moved.count === 0) throw this.staleWrite();

      /**
       * The immutable record. Every figure is a SNAPSHOT of the original line,
       * so it stays true when the catalogue, the price or the cost move later.
       * The table is append-only for the application account.
       */
      await tx.returnReversal.create({
        data: {
          id: reversalId,
          companyId,
          branchId,
          saleId: request.saleId,
          saleItemId: request.saleItemId,
          unitId: request.unitId,
          returnRequestId: request.id,
          lineRevenue: gross,
          lineCost: num(request.saleItem.cost) * request.saleItem.quantity,
          lineMargin: gross - num(request.saleItem.cost) * request.saleItem.quantity,
          grossRefund: gross,
          adjustmentTotal,
          netRefundDue,
          approvalDate,
          approvedById: userId ?? null,
        },
      });

      // Unsellable, and staying that way until somebody inspects it.
      await this.moveUnitForCustody(tx, request.unitId, 'returned', 'faulty');

      await this.audit.recordTx(tx, {
        entityType: 'ReturnRequest',
        entityId: request.id,
        action: 'update',
        before: { status: request.status, custody: request.custody },
        after: {
          status: 'approved_refund_due',
          custody: 'retained_hold',
          netRefundDue,
          isException,
        },
        reason: isException ? dto.exceptionReason?.trim() : undefined,
        branchId,
      });
      await this.audit.recordTx(tx, {
        entityType: 'ReturnReversal',
        entityId: reversalId,
        action: 'create',
        after: { grossRefund: gross, adjustmentTotal, netRefundDue, approvalDate: approvalDay },
        branchId,
      });
      await this.audit.recordTx(tx, {
        entityType: 'Unit',
        entityId: request.unitId,
        action: 'status_change',
        before: { status: 'returned' },
        after: { status: 'faulty', reason: 'return approved — held, not sellable' },
        branchId,
      });

      await this.notifier.emit(tx, {
        event: 'approved',
        request: {
          id: request.id,
          companyId,
          branchId,
          requestedById: request.requestedById,
        },
        invoiceNo: request.sale.invoiceNo,
        actorId: userId ?? null,
      });
    });

    /**
     * After commit, so a rolled-back approval never leaves a rollup claiming a
     * refund that did not happen. The rollup is derived, so recomputing the
     * approval day is additive and touches no sale row.
     */
    await this.rollups.recomputeDaily(companyId, branchId, approvalDay);

    return this.detail(idStr);
  }

  /**
   * Reject a return, with a reason the customer can be told.
   *
   * If the shop is holding the phone it goes back, and the unit returns to
   * `sold` — the only route by which that transition is reachable, and only
   * together with a recorded hand-back.
   */
  async reject(idStr: string, dto: { expectedVersion: number; reason: string }) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.userId();
    const request = await this.load(idStr, branchId);

    assertEditable(request.status);
    assertTransition(request.status, 'rejected');

    const reason = dto.reason?.trim();
    if (!reason) {
      // A refusal nobody can explain is the one a customer argues with.
      throw new BadRequestException('Say why this return is being refused');
    }

    const handingBack = request.custody === 'store_holds';

    await this.db.$transaction(async (tx) => {
      const moved = await tx.returnRequest.updateMany({
        where: { id: request.id, companyId, version: dto.expectedVersion, status: request.status },
        data: {
          status: 'rejected',
          custody: handingBack ? 'handed_back' : request.custody,
          custodyReturnedAt: handingBack ? new Date() : null,
          decidedById: userId ?? null,
          decidedAt: new Date(),
          decisionReason: reason,
          version: { increment: 1 },
        },
      });
      if (moved.count === 0) throw this.staleWrite();

      if (handingBack) {
        await this.moveUnitForCustody(tx, request.unitId, 'returned', 'sold');
        await this.audit.recordTx(tx, {
          entityType: 'Unit',
          entityId: request.unitId,
          action: 'status_change',
          before: { status: 'returned' },
          after: { status: 'sold', reason: 'return rejected — handed back to the customer' },
          branchId,
        });
      }

      await this.audit.recordTx(tx, {
        entityType: 'ReturnRequest',
        entityId: request.id,
        action: 'update',
        before: { status: request.status, custody: request.custody },
        after: { status: 'rejected', custody: handingBack ? 'handed_back' : request.custody },
        reason,
        branchId,
      });

      await this.notifier.emit(tx, {
        event: 'rejected',
        request: { id: request.id, companyId, branchId, requestedById: request.requestedById },
        invoiceNo: request.sale.invoiceNo,
        actorId: userId ?? null,
        reason,
      });
    });

    return this.detail(idStr);
  }

  // ────────────────────────────── refunds (I3) ──────────────────────────────

  /**
   * Report that the refund was handed to the customer.
   *
   * This is a CLAIM, not the record. It creates no cash movement, settles no
   * liability, and is worded everywhere as pending — a manager or owner has to
   * agree before any of that happens.
   */
  async reportRefund(idStr: string, dto: {
    reportedAmount: number;
    method: 'cash' | 'account';
    receivingAccountId?: string;
    transactionReference?: string;
    note?: string;
    clientUuid: string;
  }) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.userId();
    const request = await this.load(idStr, branchId);

    const reversal = await this.db.returnReversal.findFirst({
      where: { returnRequestId: request.id },
    });
    assertReportable(request.status, Boolean(reversal));

    const netAmountDue = num(reversal!.netRefundDue);
    assertWorthSettling(netAmountDue);
    // The shop's own immutable figure decides the amount, never the request.
    assertAmountMatchesDue(dto.reportedAmount, netAmountDue);
    assertMethodAndAccount(dto.method, dto.receivingAccountId);

    const fingerprint = fingerprintPayout({
      returnRequestId: idStr,
      method: dto.method,
      receivingAccountId: dto.receivingAccountId,
      reportedAmount: dto.reportedAmount,
      transactionReference: dto.transactionReference,
      note: dto.note,
    });

    // The idempotent replay, before any work.
    const replay = await this.db.refundPayout.findFirst({
      where: { companyId, clientUuid: uuidToBin(dto.clientUuid) },
    });
    if (replay) {
      if (replay.clientRequestHash !== fingerprint) {
        throw new ConflictException({
          code: 'idempotency_conflict',
          message: 'That request id was already used for a different refund report.',
        });
      }
      return this.detail(idStr);
    }

    /**
     * The account must be this company's and still active. A deactivated
     * account is deliberately still readable for HISTORY, but must not be
     * chosen for a new movement.
     */
    let account: { id: Buffer; label: string } | null = null;
    if (dto.receivingAccountId) {
      account = await this.db.receivingAccount.findFirst({
        where: { id: uuidToBin(dto.receivingAccountId), isActive: true },
        select: { id: true, label: true },
      });
      if (!account) throw new NotFoundException('Account not found');
    }

    const id = newUuidV7Bin();
    try {
      await this.db.$transaction(async (tx) => {
        await tx.refundPayout.create({
          data: {
            id,
            companyId,
            branchId,
            returnRequestId: request.id,
            returnReversalId: reversal!.id,
            status: 'reported_pending_confirmation',
            netAmountDue,
            reportedAmount: dto.reportedAmount,
            method: dto.method,
            receivingAccountId: account?.id ?? null,
            /**
             * Snapshotted HERE, when the money actually moved — not only at
             * confirmation. If the Owner renames or deactivates the account in
             * between, confirmation must not be stranded, and the record must
             * still say what the employee chose at the counter.
             */
            accountLabelSnapshot: account?.label ?? null,
            transactionReference: dto.transactionReference?.trim() || null,
            note: dto.note?.trim() || null,
            reportedById: userId ?? null,
            clientUuid: uuidToBin(dto.clientUuid),
            clientRequestHash: fingerprint,
          },
        });

        await this.audit.recordTx(tx, {
          entityType: 'RefundPayout',
          entityId: id,
          action: 'create',
          after: {
            amount: dto.reportedAmount,
            method: dto.method,
            account: account?.label ?? null,
            reference: dto.transactionReference?.trim() || null,
          },
          branchId,
        });

        await this.notifier.emit(tx, {
          event: 'refund_reported',
          request: { id: request.id, companyId, branchId, requestedById: request.requestedById },
          invoiceNo: request.sale.invoiceNo,
          actorId: userId ?? null,
        });
      });
    } catch (e) {
      // One payout per return, decided by the database.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({
          code: 'refund_already_reported',
          message: 'A refund has already been reported for this return.',
        });
      }
      throw e;
    }

    return this.detail(idStr);
  }

  /**
   * A manager or owner correcting what was reported, before confirming it.
   *
   * The AMOUNT is never correctable: it is locked to the immutable net refund
   * due, and a different amount would be a different decision rather than a
   * typo. Method, account, reference and note are all fair game.
   */
  async correctRefund(idStr: string, dto: {
    expectedVersion: number;
    method?: 'cash' | 'account';
    receivingAccountId?: string;
    transactionReference?: string;
    note?: string;
  }) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.userId();
    const request = await this.load(idStr, branchId);

    const payout = await this.db.refundPayout.findFirst({ where: { returnRequestId: request.id } });
    if (!payout) throw new NotFoundException('Refund not found');
    assertCorrectable(payout.status);

    const method = dto.method ?? payout.method;
    const accountId =
      dto.receivingAccountId !== undefined
        ? dto.receivingAccountId
        : payout.receivingAccountId
          ? binToUuid(payout.receivingAccountId)
          : undefined;
    assertMethodAndAccount(method, method === 'cash' ? null : accountId);

    let account: { id: Buffer; label: string } | null = null;
    if (method === 'account' && accountId) {
      account = await this.db.receivingAccount.findFirst({
        where: { id: uuidToBin(accountId), isActive: true },
        select: { id: true, label: true },
      });
      if (!account) throw new NotFoundException('Account not found');
    }

    await this.db.$transaction(async (tx) => {
      const moved = await tx.refundPayout.updateMany({
        where: { id: payout.id, companyId, version: dto.expectedVersion, status: 'reported_pending_confirmation' },
        data: {
          method,
          receivingAccountId: method === 'cash' ? null : (account?.id ?? null),
          // Re-snapshotted: a correction changes which account the money went
          // out of, so the label recorded against it must change too.
          accountLabelSnapshot: method === 'cash' ? null : (account?.label ?? null),
          ...(dto.transactionReference !== undefined
            ? { transactionReference: dto.transactionReference.trim() || null }
            : {}),
          ...(dto.note !== undefined ? { note: dto.note.trim() || null } : {}),
          version: { increment: 1 },
        },
      });
      if (moved.count === 0) throw this.staleWrite();

      await this.audit.recordTx(tx, {
        entityType: 'RefundPayout',
        entityId: payout.id,
        action: 'update',
        before: { method: payout.method, reference: payout.transactionReference },
        after: { method, account: account?.label ?? null, reference: dto.transactionReference ?? payout.transactionReference },
        branchId,
      });

      // The reporter learns their report was adjusted before being confirmed.
      await this.notifier.emit(tx, {
        event: 'refund_corrected',
        request: { id: request.id, companyId, branchId, requestedById: payout.reportedById },
        invoiceNo: request.sale.invoiceNo,
        actorId: userId ?? null,
      });
    });

    return this.detail(idStr);
  }

  /**
   * Confirm the refund was actually paid. THIS is the record.
   *
   * It settles the liability and books the cash movement on today's date — and
   * creates no second profit effect, because profit was already reversed when
   * the return was approved. Subtracting it again here is the double-count this
   * phase exists to avoid.
   */
  async confirmRefund(idStr: string, dto: { expectedVersion: number }) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.userId();
    const request = await this.load(idStr, branchId);

    const payout = await this.db.refundPayout.findFirst({
      where: { returnRequestId: request.id },
      include: { receivingAccount: { select: { label: true } } },
    });
    if (!payout) throw new NotFoundException('Refund not found');

    // A replay of the confirmation that already succeeded is safe: return what
    // happened rather than refusing somebody who simply lost the response.
    if (payout.status === 'confirmed') return this.detail(idStr);

    const confirmationDay = dayKey(new Date());
    const confirmationDate = new Date(`${confirmationDay}T00:00:00.000Z`);

    /**
     * The same rule approval already obeys: a locked day's snapshot must never
     * disagree with a recomputed one, so the confirmation is refused rather
     * than the closing reopened.
     */
    const closing = await this.db.dailyClosing.findUnique({
      where: { branchId_closingDate: { branchId, closingDate: confirmationDate } },
    });
    if (closing?.isLocked) {
      throw new ConflictException({
        code: 'day_already_closed',
        message: `${confirmationDay} is already closed for this branch. Confirm this refund tomorrow, or ask the owner to review the closing.`,
      });
    }

    await this.db.$transaction(async (tx) => {
      const moved = await tx.refundPayout.updateMany({
        where: {
          id: payout.id,
          companyId,
          version: dto.expectedVersion,
          status: 'reported_pending_confirmation',
        },
        data: {
          status: 'confirmed',
          confirmedById: userId ?? null,
          confirmedAt: new Date(),
          confirmationDate,
          /**
           * Frozen, not re-read. The label was snapshotted when the money moved;
           * re-reading the live account here would let a rename between report
           * and confirmation rewrite history. Falls back to the live label only
           * for a payout written before this rule existed.
           */
          accountLabelSnapshot: payout.accountLabelSnapshot ?? payout.receivingAccount?.label ?? null,
          version: { increment: 1 },
        },
      });
      if (moved.count === 0) throw this.staleWrite();

      await this.audit.recordTx(tx, {
        entityType: 'RefundPayout',
        entityId: payout.id,
        action: 'update',
        before: { status: 'reported_pending_confirmation' },
        after: {
          status: 'confirmed',
          amount: num(payout.reportedAmount),
          method: payout.method,
          account: payout.receivingAccount?.label ?? null,
          confirmationDate: confirmationDay,
        },
        branchId,
      });

      await this.notifier.emit(tx, {
        event: 'refund_confirmed',
        request: { id: request.id, companyId, branchId, requestedById: payout.reportedById },
        invoiceNo: request.sale.invoiceNo,
        actorId: userId ?? null,
      });
    });

    /**
     * After commit. The rollup is derived, so recomputing the CONFIRMATION day
     * adds the cash movement without touching the approval day's profit — the
     * two dates stay separate, which is the whole point.
     */
    await this.rollups.recomputeDaily(companyId, branchId, confirmationDay);

    return this.detail(idStr);
  }

  /**
   * The customer's refund receipt, as data.
   *
   * Only a CONFIRMED payout produces one: a receipt for money nobody has agreed
   * left the till would be a document asserting something untrue. Nothing is
   * persisted — the receipt is a projection of the payout, so it can always be
   * regenerated and can never drift from the record.
   *
   * Carries no cost, no margin and no internal id.
   */
  async refundReceipt(idStr: string) {
    const branchId = this.tenant.requireBranchId();
    const request = await this.load(idStr, branchId);

    const payout = await this.db.refundPayout.findFirst({
      where: { returnRequestId: request.id, status: 'confirmed' },
      include: { confirmedBy: { select: { name: true } }, reportedBy: { select: { name: true } } },
    });
    if (!payout) {
      throw new ConflictException({
        code: 'not_confirmed',
        message: 'A receipt is available once the refund has been confirmed.',
      });
    }

    const [branch, adjustments] = await Promise.all([
      /**
       * The company is read THROUGH the branch, not directly. The tenant
       * extension injects `companyId` into every tenant model's `where`, and
       * `companies` has no such column — a direct read is a Prisma validation
       * error, which the global filter reports as "Invalid query parameters".
       * Found by the CP4.5 smoke test, before any screen depended on it.
       */
      this.db.branch.findFirst({
        where: { id: branchId },
        select: { name: true, phone: true, company: { select: { name: true, currency: true } } },
      }),
      this.db.returnAdjustment.findMany({
        where: { returnRequestId: request.id },
        orderBy: { id: 'asc' },
      }),
    ]);

    const reversal = await this.db.returnReversal.findFirst({ where: { returnRequestId: request.id } });

    return {
      store: { name: branch?.company?.name ?? '', branch: branch?.name ?? '', phone: branch?.phone ?? null },
      // Stable and meaningful to a customer: their original invoice, plus this
      // return's own reference.
      reference: `R-${request.sale.invoiceNo}-${binToUuid(request.id).slice(0, 8).toUpperCase()}`,
      originalInvoiceNo: request.sale.invoiceNo,
      confirmedAt: payout.confirmedAt,
      product: [request.unit.product?.brand, request.unit.product?.model, request.unit.product?.variant]
        .filter(Boolean)
        .join(' '),
      identifier: request.unit.imeiPrimary ?? request.unit.serialNo,
      grossRefund: num(reversal?.grossRefund),
      adjustments: adjustments.map((a) => ({
        label: a.label,
        quantity: a.quantity,
        amount: num(a.totalAmount),
      })),
      netAmountReturned: num(payout.reportedAmount),
      method: payout.method,
      accountLabel: payout.accountLabelSnapshot,
      transactionReference: payout.transactionReference,
      status: 'confirmed' as const,
      reportedBy: payout.reportedBy?.name ?? null,
      confirmedBy: payout.confirmedBy?.name ?? null,
    };
  }

  /**
   * What the shop owes, what it has paid, and when each happened (I3-CP4).
   *
   * Three timings are kept apart deliberately, because collapsing them is how a
   * refund gets counted twice:
   *
   *   approval date      profit reverses, a liability appears
   *   report date        a workflow event only — no money, no liability change
   *   confirmation date  cash leaves, the liability settles
   *
   * **Outstanding liability is derived**, never stored: it is the sum of
   * immutable approved reversals minus confirmed payouts. Anything mutable in
   * between — a report, a correction — cannot move it, which is exactly the
   * property that makes it trustworthy.
   */
  async refundSummary(query: { from?: string; to?: string }) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const range = parseDateRange(query.from, query.to);
    const from = range?.gte ?? new Date('1970-01-01T00:00:00.000Z');
    const to = range?.lt ?? new Date('2999-01-01T00:00:00.000Z');

    const [approved] = await this.db.$queryRaw<
      { n: unknown; gross: unknown; adjustments: unknown; cogs: unknown }[]
    >(Prisma.sql`
      SELECT COUNT(*) n,
             COALESCE(SUM(gross_refund), 0)     gross,
             COALESCE(SUM(adjustment_total), 0) adjustments,
             COALESCE(SUM(line_cost), 0)        cogs
      FROM return_reversals
      WHERE company_id = ${companyId} AND branch_id = ${branchId}
        AND approval_date >= ${from} AND approval_date < ${to}`);

    /**
     * Everything approved and not yet CONFIRMED, over all time — a liability
     * does not expire because a reporting period ended. A pending report is
     * still outstanding: nobody has agreed the money left.
     */
    const [outstanding] = await this.db.$queryRaw<{ n: unknown; amount: unknown }[]>(Prisma.sql`
      SELECT COUNT(*) n, COALESCE(SUM(rv.net_refund_due), 0) amount
      FROM return_reversals rv
      LEFT JOIN refund_payouts p
        ON p.return_reversal_id = rv.id AND p.status = 'confirmed'
      WHERE rv.company_id = ${companyId} AND rv.branch_id = ${branchId}
        AND p.id IS NULL`);

    const [awaiting] = await this.db.$queryRaw<{ n: unknown; amount: unknown }[]>(Prisma.sql`
      SELECT COUNT(*) n, COALESCE(SUM(reported_amount), 0) amount
      FROM refund_payouts
      WHERE company_id = ${companyId} AND branch_id = ${branchId}
        AND status = 'reported_pending_confirmation'`);

    const [confirmed] = await this.db.$queryRaw<
      { n: unknown; total: unknown; cash: unknown }[]
    >(Prisma.sql`
      SELECT COUNT(*) n,
             COALESCE(SUM(reported_amount), 0) total,
             COALESCE(SUM(CASE WHEN method = 'cash' THEN reported_amount END), 0) cash
      FROM refund_payouts
      WHERE company_id = ${companyId} AND branch_id = ${branchId}
        AND status = 'confirmed'
        AND confirmation_date >= ${from} AND confirmation_date < ${to}`);

    // By channel, using the label frozen on the payout so a later rename cannot
    // retitle a movement that already happened.
    const byAccount = await this.db.$queryRaw<{ label: unknown; amount: unknown; n: unknown }[]>(Prisma.sql`
      SELECT COALESCE(account_label_snapshot, 'Unnamed account') label,
             COALESCE(SUM(reported_amount), 0) amount,
             COUNT(*) n
      FROM refund_payouts
      WHERE company_id = ${companyId} AND branch_id = ${branchId}
        AND status = 'confirmed' AND method = 'account'
        AND confirmation_date >= ${from} AND confirmation_date < ${to}
      GROUP BY account_label_snapshot`);

    const gross = toNum(approved.gross);
    const adjustments = toNum(approved.adjustments);
    const cogs = toNum(approved.cogs);

    return {
      approved: {
        count: toNum(approved.n),
        grossRefund: gross,
        adjustments,
        // Named for the gating interceptor: cost is cost, wherever it appears.
        cogsCredited: cogs,
        /**
         * The approval-date profit effect, as a positive reduction:
         * gross − adjustments − COGS credit (docs/27 §16.11).
         */
        profitEffect: Math.round((gross - adjustments - cogs) * 100) / 100,
      },
      /** Approved and not confirmed, all time. Derived from immutable rows. */
      outstandingLiability: {
        count: toNum(outstanding.n),
        amount: toNum(outstanding.amount),
      },
      /** Reported, waiting on a manager or owner. NOT a cash movement. */
      awaitingConfirmation: {
        count: toNum(awaiting.n),
        amount: toNum(awaiting.amount),
      },
      confirmed: {
        count: toNum(confirmed.n),
        total: toNum(confirmed.total),
        cash: toNum(confirmed.cash),
        byAccount: byAccount.map((r) => ({
          label: String(r.label),
          amount: toNum(r.amount),
          count: toNum(r.n),
        })),
      },
    };
  }

  // ─────────────────────────────── reads ───────────────────────────────

  async list(query: ListReturnsDto) {
    const branchId = this.tenant.requireBranchId();
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);

    const statuses = parseEnumList<ReturnStatus>(query.status, RETURN_STATUSES, 'return status');
    const responsibilities = parseEnumList(query.responsibility, RESPONSIBILITIES, 'responsibility');
    const created = parseDateRange(query.from, query.to);

    const rows = await this.db.returnRequest.findMany({
      where: {
        branchId,
        ...(statuses.length > 0 ? { status: { in: statuses } } : {}),
        ...(responsibilities.length > 0 ? { responsibility: { in: responsibilities as never } } : {}),
        // The snapshot taken at request time, not a fresh judgement: filtering
        // by "eligible" must mean what the request was raised under.
        ...(query.eligibility ? { requiresException: query.eligibility === 'ineligible' } : {}),
        ...(query.requestedBy && isUuid(query.requestedBy)
          ? { requestedById: uuidToBin(query.requestedBy) }
          : {}),
        ...(created ? { createdAt: created } : {}),
        ...this.searchWhere(query.search),
      },
      include: {
        sale: { select: { invoiceNo: true } },
        unit: { select: { imeiPrimary: true, serialNo: true, product: { select: { brand: true, model: true, variant: true } } } },
        requestedBy: { select: { name: true } },
        saleItem: { select: { price: true, quantity: true, discount: true } },
        adjustments: { select: { totalAmount: true } },
      },
      ...(query.cursor ? { cursor: { id: uuidToBin(query.cursor) }, skip: 1 } : {}),
      orderBy: { id: 'desc' },
      take: limit + 1,
    });

    const page = rows.slice(0, limit);
    return {
      rows: page.map((r) => {
        const gross = grossRefundOf({
          price: num(r.saleItem.price),
          quantity: r.saleItem.quantity,
          discount: num(r.saleItem.discount),
        });
        const adjustmentTotal = r.adjustments.reduce((s, a) => s + num(a.totalAmount), 0);
        return {
          id: binToUuid(r.id),
          status: r.status,
          custody: r.custody,
          responsibility: r.responsibility,
          invoiceNo: r.sale.invoiceNo,
          product: [r.unit.product?.brand, r.unit.product?.model, r.unit.product?.variant]
            .filter(Boolean)
            .join(' '),
          identifier: r.unit.imeiPrimary ?? r.unit.serialNo,
          requestedBy: r.requestedBy?.name ?? null,
          requestedAt: r.createdAt,
          policyReason: r.policyReason,
          requiresException: r.requiresException,
          // Provisional until CP4 approves it — the field names say so.
          provisionalGrossRefund: gross,
          provisionalAdjustmentTotal: Math.round(adjustmentTotal * 100) / 100,
          provisionalNetRefundDue: Math.round((gross - adjustmentTotal) * 100) / 100,
        };
      }),
      nextCursor: rows.length > limit ? binToUuid(page[page.length - 1]!.id) : null,
    };
  }

  async detail(idStr: string) {
    const branchId = this.tenant.requireBranchId();
    const r = await this.load(idStr, branchId);

    const gross = grossRefundOf({
      price: num(r.saleItem.price),
      quantity: r.saleItem.quantity,
      discount: num(r.saleItem.discount),
    });
    const adjustments = await this.db.returnAdjustment.findMany({
      where: { returnRequestId: r.id },
      orderBy: { id: 'asc' },
      include: { createdBy: { select: { name: true } } },
    });
    const payout = await this.db.refundPayout.findFirst({
      where: { returnRequestId: r.id },
      include: {
        receivingAccount: { select: { label: true } },
        reportedBy: { select: { name: true } },
        confirmedBy: { select: { name: true } },
      },
    });
    const adjustmentTotal =
      Math.round(adjustments.reduce((s, a) => s + num(a.totalAmount), 0) * 100) / 100;

    return {
      id: binToUuid(r.id),
      status: r.status,
      version: r.version,
      custody: r.custody,
      custodyReceivedAt: r.custodyReceivedAt,
      custodyReturnedAt: r.custodyReturnedAt,
      responsibility: r.responsibility,
      responsibilityNotes: r.responsibilityNotes,
      requestReason: r.requestReason,
      conditionNotes: r.conditionNotes,
      sale: {
        id: binToUuid(r.saleId),
        invoiceNo: r.sale.invoiceNo,
        soldAt: r.sale.soldAt,
      },
      phone: {
        unitId: binToUuid(r.unitId),
        imei: r.unit.imeiPrimary,
        serialNo: r.unit.serialNo,
        product: [r.unit.product?.brand, r.unit.product?.model, r.unit.product?.variant]
          .filter(Boolean)
          .join(' '),
        // So a screen can say "held, not sellable" from the same fact the
        // inventory uses.
        unitStatus: r.unit.status,
      },
      policy: {
        windowHours: r.policyWindowHours,
        deadlineAt: r.policyDeadlineAt,
        reason: r.policyReason,
        requiresException: r.requiresException,
      },
      /**
       * Provisional until the return is APPROVED, and agreed afterwards.
       *
       * This was hardcoded `true`, so an approved return still described its
       * own immutable, already-reversed figures as provisional. The detail
       * screen happened to derive the wording from `status` instead and so was
       * never wrong on screen — but the field was, and I3's refund screens read
       * the money block directly. Found by the CP7 lifecycle run.
       */
      money: {
        provisional: isProvisionalMoney(r.status),
        grossRefund: gross,
        adjustmentTotal,
        netRefundDue: Math.round((gross - adjustmentTotal) * 100) / 100,
        // The line's cost and margin ride the standard gating: named so the
        // interceptor strips them without `cost.view`.
        cost: num(r.saleItem.cost) * r.saleItem.quantity,
      },
      adjustments: adjustments.map((a) => ({
        id: binToUuid(a.id),
        kind: a.kind,
        label: a.label,
        quantity: a.quantity,
        unitAmount: num(a.unitAmount),
        totalAmount: num(a.totalAmount),
        addedBy: a.createdBy?.name ?? null,
        addedAt: a.createdAt,
      })),
      timeline: [
        { at: r.createdAt, event: 'requested', by: r.requestedBy?.name ?? null },
        ...(r.custodyReceivedAt ? [{ at: r.custodyReceivedAt, event: 'custody_received', by: null }] : []),
        ...(r.reviewedAt ? [{ at: r.reviewedAt, event: 'under_review', by: r.reviewedBy?.name ?? null }] : []),
        ...(r.decidedAt ? [{ at: r.decidedAt, event: r.status, by: r.decidedBy?.name ?? null }] : []),
      ],
      requestedBy: r.requestedBy?.name ?? null,
      requestedAt: r.createdAt,
      /**
       * The settlement, when one exists. `null` means nobody has reported the
       * refund yet — which is different from reported-and-unconfirmed, and the
       * screen must not blur the two.
       */
      payout: payout
        ? {
            status: payout.status,
            version: payout.version,
            netAmountDue: num(payout.netAmountDue),
            reportedAmount: num(payout.reportedAmount),
            method: payout.method,
            accountLabel: payout.accountLabelSnapshot ?? payout.receivingAccount?.label ?? null,
            transactionReference: payout.transactionReference,
            note: payout.note,
            reportedBy: payout.reportedBy?.name ?? null,
            reportedAt: payout.reportedAt,
            confirmedBy: payout.confirmedBy?.name ?? null,
            confirmedAt: payout.confirmedAt,
          }
        : null,
    };
  }

  // ────────────────────────────── internals ──────────────────────────────

  /**
   * One loader for every write path, so branch scoping and the fail-closed 404
   * are decided in a single place. Unknown, malformed, another company's and
   * another branch's all answer identically — a different message would confirm
   * that a return exists somewhere else.
   */
  private async load(idStr: string, branchId: Buffer) {
    if (!isUuid(idStr)) throw new NotFoundException('Return not found');
    const r = await this.db.returnRequest.findUnique({
      where: { id: uuidToBin(idStr) },
      include: {
        sale: true,
        saleItem: true,
        unit: {
          select: {
            id: true,
            status: true,
            imeiPrimary: true,
            imeiSecondary: true,
            serialNo: true,
            product: { select: { brand: true, model: true, variant: true } },
          },
        },
        requestedBy: { select: { name: true } },
        reviewedBy: { select: { name: true } },
        decidedBy: { select: { name: true } },
      },
    });
    if (!r || !r.branchId.equals(branchId)) throw new NotFoundException('Return not found');
    return r;
  }

  /**
   * The custody move, as a compare-and-swap on the unit's CURRENT status.
   *
   * Deliberately narrow: it is not a general "set any unit status" helper,
   * because such a helper is one careless call away from being a way to make a
   * sold phone sellable again. It only ever performs the transition the return
   * workflow needs, and the state machine validates it first.
   */
  private async moveUnitForCustody(
    // Structurally typed, like the notifier: the tenant-extended client is not
    // `Prisma.TransactionClient`, and asking for the narrowest shape this needs
    // beats casting away the difference.
    tx: { unit: { updateMany(args: unknown): Promise<{ count: number }> } },
    unitId: Buffer,
    from: 'sold' | 'returned',
    to: 'returned' | 'sold' | 'faulty',
  ): Promise<void> {
    assertUnitTransition(from, to);
    const moved = await tx.unit.updateMany({
      where: { id: unitId, status: from },
      data: { status: to },
    });
    if (moved.count === 0) {
      throw new ConflictException({
        code: 'unit_moved',
        message: 'That phone is no longer in the state this return expected. Refresh and try again.',
      });
    }
  }

  private staleWrite(): ConflictException {
    return new ConflictException({
      code: 'refresh_required',
      message: 'Someone else acted on this return. Refresh and try again.',
    });
  }

  /** Searched in SQL, across what a person actually remembers. */
  private searchWhere(search?: string): Prisma.ReturnRequestWhereInput {
    const q = search?.trim();
    if (!q) return {};
    return {
      OR: [
        { sale: { invoiceNo: { contains: q } } },
        { unit: { imeiPrimary: { contains: q } } },
        { unit: { imeiSecondary: { contains: q } } },
        { unit: { serialNo: { contains: q } } },
        { unit: { product: { brand: { contains: q } } } },
        { unit: { product: { model: { contains: q } } } },
        { unit: { product: { variant: { contains: q } } } },
        { requestedBy: { name: { contains: q } } },
        { requestReason: { contains: q } },
      ],
    };
  }
}
