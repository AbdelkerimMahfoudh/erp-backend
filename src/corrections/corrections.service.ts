import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { AppClsStore } from '../common/context/request-context';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { binToUuid, isUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { dayKey } from '../common/utils/date.util';
import {
  assertDayOpen,
  assertDecidable,
  assertNoOpenRequest,
  assertNotAlreadyCorrected,
  assertReasonGiven,
  assertTargetCorrectable,
  fingerprintCorrection,
} from './correction-rules';
import {
  DecideCorrectionDto,
  ListCorrectionsDto,
  RequestCorrectionDto,
} from './dto/correction.dto';

const num = (d: Prisma.Decimal | number | null | undefined): number => (d == null ? 0 : Number(d));

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
    private readonly cls: ClsService<AppClsStore>,
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
    const day = dayKey(new Date());
    const correctionDate = new Date(`${day}T00:00:00.000Z`);
    const closing = await this.db.dailyClosing.findUnique({
      where: { branchId_closingDate: { branchId: correction.branchId, closingDate: correctionDate } },
    });
    assertDayOpen(closing, day);

    const userId = this.tenant.userId();
    /**
     * Optimistic concurrency, and the reason it matters here more than
     * anywhere: two owners approving the same request must produce ONE
     * restored liability. `updateMany` guarded on version and status means the
     * loser changes zero rows and is told to refresh.
     */
    const moved = await this.db.financialCorrection.updateMany({
      where: {
        id: correction.id,
        companyId: this.tenant.companyId(),
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

    await this.audit.record({
      entityType: 'FinancialCorrection',
      entityId: correction.id,
      // The status change IS the event: requested → approved is the moment
      // money comes back.
      action: 'status_change',
      reason: correction.reason,
      after: { correctionDate: day, amount: num(correction.amount) },
    });

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
          : null,
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
