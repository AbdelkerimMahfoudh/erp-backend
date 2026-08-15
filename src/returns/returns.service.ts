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
import { parseDateRange, parseEnumList } from '../sales/sale-query';
import { ReturnNotifier } from './return-notifications';
import {
  AdjustmentDto,
  CreateReturnRequestDto,
  InvestigateDto,
  ListReturnsDto,
  ReceiveCustodyDto,
} from './dto/return.dto';
import {
  assertEditable,
  assertTransition,
  custodyIntakeNeeded,
  fingerprintRequest,
  grossRefundOf,
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
      /** Explicitly provisional: nothing here is owed until CP4 approves it. */
      money: {
        provisional: true,
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
