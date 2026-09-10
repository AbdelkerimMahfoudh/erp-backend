import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DiscountApprovalStatus, Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PricingService } from '../pricing/pricing.service';
import { AppClsStore } from '../common/context/request-context';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';

/**
 * Owner-approved exceptions to the configured selling price (A2).
 *
 * ## The rule this implements
 *
 * The **configured selling price** is the normal minimum. It comes from the
 * ladder in `price-resolution.ts` — unit override, branch variant, product
 * default — and selling below it needs the Owner's approval **even when the
 * sale is still profitable**. Selling below *cost* is a high-risk subset:
 * the same approval, plus a reason.
 *
 * ## An approval is not a permission
 *
 * It authorises **one sale, of one unit, at one exact price, in one branch,
 * for thirty minutes**, and is then spent. Everything below exists to keep it
 * that way:
 *
 * - the price the sale may use is the **approved** price, never the one in the
 *   request;
 * - consumption is a **conditional update** — the row moves from `approved` to
 *   `consumed` only if it is still `approved`, so two concurrent sales produce
 *   exactly one winner without a read-then-write race;
 * - every snapshot taken at request time is re-compared at consumption, so a
 *   decision made about a different price, a different cost, or a unit that has
 *   since moved is not a decision about this sale.
 *
 * ## Who
 *
 * Requested by anyone who may create the sale. Approved by `discount.override`,
 * which A2 made **Owner-only** — it is no longer a bypass that let its holder
 * sell below the floor directly. An Owner needing their own exception goes
 * through the same workflow, which is what makes their discount as traceable as
 * anybody else's.
 */

/** Thirty minutes. Prices and stock move within a day; an approval must not. */
export const APPROVAL_TTL_MINUTES = 30;

export type VoidReason =
  | 'price_changed'
  | 'cost_changed'
  | 'unit_sold'
  | 'unit_transferred'
  | 'expired';

export interface RequestApprovalInput {
  unitId: string;
  requestedPrice: number;
  reason?: string;
  clientUuid?: string;
}

@Injectable()
export class DiscountApprovalsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly pricing: PricingService,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  private may(permission: string): boolean {
    return this.cls.get('permissions')?.has(permission) ?? false;
  }

  /**
   * Ask the Owner for an exception.
   *
   * Every figure is snapshotted here rather than joined later. If the
   * configured price or the confirmed cost moves before the Owner decides, the
   * decision they were asked to make no longer exists — and the only way to
   * know that is to have recorded what it was.
   */
  async request(input: RequestApprovalInput) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const requesterId = this.tenant.userId();
    if (!requesterId) throw new ForbiddenException('Not signed in');

    const unitId = uuidToBin(input.unitId);
    const unit = await this.db.unit.findFirst({
      where: { id: unitId },
      include: { product: { select: { id: true, variant: true, defaultPrice: true } } },
    });
    if (!unit) throw new NotFoundException('No such unit');
    if (unit.status !== 'in_stock') {
      throw new ConflictException('That unit is not in stock');
    }
    if (!unit.branchId.equals(branchId)) {
      throw new ConflictException('That unit is not at this branch');
    }

    // The SAME resolver the sale uses. A second way to answer "what does this
    // sell for?" is exactly the divergence `price-resolution.ts` exists to stop.
    const resolved = await this.pricing.resolveForSaleTx(
      this.db as never,
      {
        kind: 'unit',
        unitId: unit.id,
        productId: unit.productId,
        unitBranchId: unit.branchId,
        productDefault: unit.product?.defaultPrice != null ? Number(unit.product.defaultPrice) : null,
      },
      branchId,
    );
    if (resolved.price === null) {
      /*
       * No configured price means no floor. There is nothing to make an
       * exception TO, and inventing one from cost would substitute the rule
       * this feature exists to stop substituting.
       */
      throw new BadRequestException(
        'This product has no set price, so there is no price to seek an exception to',
      );
    }

    const configuredPrice = resolved.price;
    const cost = Number(unit.cost);
    const requested = input.requestedPrice;

    if (requested >= configuredPrice) {
      throw new BadRequestException('That price is not below the set price — no approval is needed');
    }

    const belowCost = requested < cost;
    if (belowCost && !input.reason?.trim()) {
      throw new BadRequestException('A reason is required to request a price below cost');
    }

    const clientUuid = input.clientUuid ? uuidToBin(input.clientUuid) : null;
    const requestHash = hashRequest(input);

    if (clientUuid) {
      const existing = await this.db.discountApproval.findFirst({
        where: { companyId, clientUuid },
      });
      if (existing) {
        /*
         * A retry. Same payload replays the original decision; a different
         * payload under the same key is a client bug worth surfacing rather
         * than a second request worth creating.
         */
        if (existing.clientRequestHash !== requestHash) {
          throw new ConflictException({
            code: 'idempotency_conflict',
            message: 'That request id was already used with different details',
          });
        }
        return this.present(existing);
      }
    }

    const now = new Date();
    const created = await this.db.discountApproval.create({
      data: {
        id: newUuidV7Bin(),
        companyId,
        branchId,
        unitId: unit.id,
        productId: unit.productId,
        variant: unit.product?.variant ?? null,
        configuredPrice: new Prisma.Decimal(configuredPrice.toFixed(2)),
        priceSource: resolved.source,
        priceVersion: resolved.version ?? 0,
        unitCost: new Prisma.Decimal(cost.toFixed(2)),
        requestedPrice: new Prisma.Decimal(requested.toFixed(2)),
        discountAmount: new Prisma.Decimal((configuredPrice - requested).toFixed(2)),
        belowCost,
        unitBranchId: unit.branchId,
        requesterId,
        reason: input.reason?.trim() || null,
        status: DiscountApprovalStatus.pending,
        expiresAt: new Date(now.getTime() + APPROVAL_TTL_MINUTES * 60_000),
        clientUuid,
        clientRequestHash: requestHash,
      },
    });

    await this.audit.record({
      entityType: 'discount_approval',
      entityId: created.id,
      action: 'create',
      after: {
        event: 'discount_approval_requested',
        belowCost,
        // No cost, no margin. The audit row records that an exception was
        // asked for, not what the shop pays for the thing.
        discountAmount: Number(created.discountAmount),
      },
    });

    await this.notifyApprovers(created.id, belowCost);
    return this.present(created);
  }

  /**
   * The Owner's decision.
   *
   * `expectedVersion` makes two Owners deciding at once produce one winner and
   * one honest conflict, rather than a silent last-write.
   */
  async decide(
    id: string,
    input: { approve: boolean; note?: string; expectedVersion: number },
  ) {
    if (!this.may('discount.override')) {
      throw new ForbiddenException('Only an Owner may approve a price below the set price');
    }
    const approverId = this.tenant.userId();
    if (!approverId) throw new ForbiddenException('Not signed in');

    const approvalId = uuidToBin(id);
    const current = await this.db.discountApproval.findFirst({ where: { id: approvalId } });
    if (!current) throw new NotFoundException('No such request');

    const settled = await this.settleIfStale(current);
    if (settled.status !== DiscountApprovalStatus.pending) {
      /*
       * Deciding an already-decided request replays the original outcome rather
       * than erroring, so a retried tap is safe — but a DIFFERENT decision on a
       * decided request is a real conflict and says so.
       */
      const alreadyApproved = settled.status === DiscountApprovalStatus.approved;
      if (
        (input.approve && alreadyApproved) ||
        (!input.approve && settled.status === DiscountApprovalStatus.rejected)
      ) {
        return this.present(settled);
      }
      throw new ConflictException({
        code: 'approval_already_decided',
        message: `That request is already ${settled.status}`,
      });
    }

    const next = input.approve ? DiscountApprovalStatus.approved : DiscountApprovalStatus.rejected;
    const { count } = await this.db.discountApproval.updateMany({
      where: {
        id: approvalId,
        status: DiscountApprovalStatus.pending,
        version: input.expectedVersion,
      },
      data: {
        status: next,
        approverId,
        decidedAt: new Date(),
        // The approved price is the REQUESTED price, frozen. The Owner approves
        // a specific number; they do not open a range.
        approvedPrice: input.approve ? current.requestedPrice : null,
        decisionNote: input.note?.trim() || null,
        version: { increment: 1 },
      },
    });
    if (count === 0) {
      throw new ConflictException({
        code: 'stale_version',
        message: 'Somebody else decided this first. Reload and look again.',
      });
    }

    const updated = await this.db.discountApproval.findFirstOrThrow({ where: { id: approvalId } });
    await this.audit.record({
      entityType: 'discount_approval',
      entityId: approvalId,
      action: 'status_change',
      before: { status: DiscountApprovalStatus.pending },
      after: {
        event: input.approve ? 'discount_approval_approved' : 'discount_approval_rejected',
        status: next,
        approvedPrice: input.approve ? Number(current.requestedPrice) : null,
      },
    });

    await this.notifications.emit({
      companyId: this.tenant.companyId(),
      userId: current.requesterId,
      kind: input.approve ? 'discount_approved' : 'discount_rejected',
      title: input.approve ? 'Price approved' : 'Price not approved',
      body: null,
      entityType: 'discount_approval',
      entityId: approvalId,
      // One notification per decision. The key is the approval itself, so a
      // retried decision cannot produce a second message.
      dedupeKey: `discount_approval:${binToUuid(approvalId)}:decided`,
    } as never);

    return this.present(updated);
  }

  /** The requester changed their mind before anybody decided. */
  async cancel(id: string) {
    const approvalId = uuidToBin(id);
    const current = await this.db.discountApproval.findFirst({ where: { id: approvalId } });
    if (!current) throw new NotFoundException('No such request');
    if (!current.requesterId.equals(this.tenant.userId() ?? Buffer.alloc(16))) {
      throw new ForbiddenException('Only the person who asked may cancel it');
    }
    if (current.status !== DiscountApprovalStatus.pending) {
      return this.present(current);
    }
    await this.db.discountApproval.updateMany({
      where: { id: approvalId, status: DiscountApprovalStatus.pending },
      data: { status: DiscountApprovalStatus.voided, voidReason: 'cancelled', version: { increment: 1 } },
    });
    const updated = await this.db.discountApproval.findFirstOrThrow({ where: { id: approvalId } });
    await this.audit.record({
      entityType: 'discount_approval',
      entityId: approvalId,
      action: 'status_change',
      after: { event: 'discount_approval_cancelled' },
    });
    return this.present(updated);
  }

  /** The Owner's queue, and a requester's own history. */
  async list(status?: DiscountApprovalStatus) {
    const rows = await this.db.discountApproval.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const settled = await Promise.all(rows.map((r) => this.settleIfStale(r)));
    return { rows: settled.map((r) => this.present(r)) };
  }

  /**
   * Lazily expire.
   *
   * No scheduler. A row that nobody has looked at since it lapsed is not doing
   * any harm, and the moment anyone reads it — including the sale that would
   * consume it — it settles honestly. Adding a background job to change a
   * status nobody is observing would be infrastructure for its own sake.
   */
  private async settleIfStale<T extends { id: Buffer; status: DiscountApprovalStatus; expiresAt: Date }>(
    row: T,
  ): Promise<T> {
    const stale =
      (row.status === DiscountApprovalStatus.pending ||
        row.status === DiscountApprovalStatus.approved) &&
      row.expiresAt.getTime() <= Date.now();
    if (!stale) return row;

    await this.db.discountApproval.updateMany({
      where: { id: row.id, status: row.status },
      data: { status: DiscountApprovalStatus.expired, voidReason: 'expired', version: { increment: 1 } },
    });
    return { ...row, status: DiscountApprovalStatus.expired };
  }

  /**
   * Spend an approval on a sale, atomically, inside the sale's transaction.
   *
   * Returns the approved price, or throws with a code the client can act on.
   * **The caller must use the returned price**, not the one it was given.
   */
  async consume(
    tx: Prisma.TransactionClient,
    params: {
      unitId: Buffer;
      requestedPrice: number;
      currentConfiguredPrice: number | null;
      currentPriceVersion: number | null;
      currentCost: number;
      currentBranchId: Buffer;
      saleId: Buffer;
    },
  ): Promise<{ approvedPrice: number; belowCost: boolean } | null> {
    const rows = await tx.discountApproval.findMany({
      where: { unitId: params.unitId, status: DiscountApprovalStatus.approved },
      orderBy: { decidedAt: 'desc' },
      take: 5,
    });

    for (const row of rows) {
      if (row.expiresAt.getTime() <= Date.now()) continue;
      if (Math.abs(Number(row.approvedPrice ?? 0) - params.requestedPrice) > 0.005) continue;

      // Every snapshot re-checked. A decision made about a different world is
      // not a decision about this sale.
      const voidReason = this.staleReason(row, params);
      if (voidReason) {
        await tx.discountApproval.updateMany({
          where: { id: row.id, status: DiscountApprovalStatus.approved },
          data: { status: DiscountApprovalStatus.voided, voidReason, version: { increment: 1 } },
        });
        throw new ConflictException({ code: `approval_${voidReason}`, message: reasonMessage(voidReason) });
      }

      /*
       * The conditional update IS the concurrency control. Two sales racing for
       * one approval both attempt this; MySQL serialises them on the row, and
       * exactly one sees `count === 1`. Reading first and writing after would
       * let both read `approved`.
       */
      const { count } = await tx.discountApproval.updateMany({
        where: { id: row.id, status: DiscountApprovalStatus.approved },
        data: {
          status: DiscountApprovalStatus.consumed,
          consumedBySaleId: params.saleId,
          consumedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (count === 0) {
        throw new ConflictException({
          code: 'approval_already_used',
          message: 'That approval has already been used for another sale',
        });
      }
      return { approvedPrice: Number(row.approvedPrice), belowCost: row.belowCost };
    }

    return null;
  }

  private staleReason(
    row: { configuredPrice: Prisma.Decimal; priceVersion: number; unitCost: Prisma.Decimal; unitBranchId: Buffer },
    params: {
      currentConfiguredPrice: number | null;
      currentPriceVersion: number | null;
      currentCost: number;
      currentBranchId: Buffer;
    },
  ): VoidReason | null {
    if (!row.unitBranchId.equals(params.currentBranchId)) return 'unit_transferred';
    if (
      params.currentConfiguredPrice === null ||
      Math.abs(Number(row.configuredPrice) - params.currentConfiguredPrice) > 0.005 ||
      (params.currentPriceVersion !== null && row.priceVersion !== params.currentPriceVersion)
    ) {
      return 'price_changed';
    }
    if (Math.abs(Number(row.unitCost) - params.currentCost) > 0.005) return 'cost_changed';
    return null;
  }

  /** Void every outstanding approval for a unit that has moved or sold. */
  async voidForUnit(tx: Prisma.TransactionClient, unitId: Buffer, reason: VoidReason): Promise<void> {
    await tx.discountApproval.updateMany({
      where: {
        unitId,
        status: { in: [DiscountApprovalStatus.pending, DiscountApprovalStatus.approved] },
      },
      data: { status: DiscountApprovalStatus.voided, voidReason: reason, version: { increment: 1 } },
    });
  }

  private async notifyApprovers(approvalId: Buffer, belowCost: boolean): Promise<void> {
    /*
     * One notification per request, keyed on the request. A retried submission
     * that replays an existing row does not reach here, and a redelivery cannot
     * produce a second message.
     */
    await this.notifications.emit({
      companyId: this.tenant.companyId(),
      permission: 'discount.override',
      kind: belowCost ? 'discount_request_below_cost' : 'discount_request',
      title: 'A price needs your approval',
      body: null,
      entityType: 'discount_approval',
      entityId: approvalId,
      dedupeKey: `discount_approval:${binToUuid(approvalId)}:requested`,
    } as never);
  }

  /**
   * The shape a client sees.
   *
   * **No cost and no margin.** `CostGatingInterceptor` would strip them anyway
   * for a caller without `cost.view`, but they are not put in at all: an Owner
   * reviewing a request needs the configured price, the requested price and the
   * discount, and `belowCost` as a flag. The cost itself is available on the
   * unit, through the gate that already governs it.
   */
  private present(row: {
    id: Buffer;
    status: DiscountApprovalStatus;
    configuredPrice: Prisma.Decimal;
    requestedPrice: Prisma.Decimal;
    discountAmount: Prisma.Decimal;
    approvedPrice: Prisma.Decimal | null;
    belowCost: boolean;
    reason: string | null;
    decisionNote: string | null;
    expiresAt: Date;
    createdAt: Date;
    version: number;
    voidReason: string | null;
    unitId: Buffer;
    requesterId: Buffer;
    approverId: Buffer | null;
  }) {
    return {
      id: binToUuid(row.id),
      status: row.status,
      unitId: binToUuid(row.unitId),
      requesterId: binToUuid(row.requesterId),
      approverId: row.approverId ? binToUuid(row.approverId) : null,
      configuredPrice: Number(row.configuredPrice),
      requestedPrice: Number(row.requestedPrice),
      discountAmount: Number(row.discountAmount),
      approvedPrice: row.approvedPrice === null ? null : Number(row.approvedPrice),
      belowCost: row.belowCost,
      reason: row.reason,
      decisionNote: row.decisionNote,
      voidReason: row.voidReason,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      version: row.version,
    };
  }
}

function reasonMessage(reason: VoidReason): string {
  switch (reason) {
    case 'price_changed':
      return 'The set price changed after this was approved. Ask again.';
    case 'cost_changed':
      return 'The cost changed after this was approved. Ask again.';
    case 'unit_transferred':
      return 'That unit moved to another branch after this was approved.';
    case 'unit_sold':
      return 'That unit has already been sold.';
    case 'expired':
      return 'That approval has expired.';
  }
}

/** A stable hash of what was asked for, for idempotent retries. */
function hashRequest(input: RequestApprovalInput): string {
  const canonical = JSON.stringify({
    unitId: input.unitId,
    requestedPrice: input.requestedPrice,
    reason: input.reason?.trim() ?? null,
  });
  return require('node:crypto').createHash('sha256').update(canonical).digest('hex');
}
