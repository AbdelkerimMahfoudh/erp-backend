import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { Prisma, StockTransfer } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { AppClsStore } from '../common/context/request-context';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { InvoiceNumberService } from '../common/numbering/invoice-number.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PricingService } from '../pricing/pricing.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { assertTransferTransition } from './transfer-state-machine';
import { TransferStatus } from '@prisma/client';
import { computeDiscrepancy, DiscrepancyReport } from './discrepancy.util';
import { unitIdentifier } from '../inventory/unit-identifier.util';
import { CreateTransferDto, ReceiveTransferDto, TransferDecisionDto } from './dto/transfer.dto';

/**
 * Stable fingerprint of what the client asked for, mirroring Purchase.
 *
 * Identifier ORDER is normalised: the same phones scanned in a different
 * sequence are the same request, not a conflict. The source branch is included
 * because the same key sent from a different branch is a different movement.
 */
function transferFingerprint(dto: CreateTransferDto, fromBranchId: Buffer): string {
  const canonical = {
    fromBranchId: fromBranchId.toString('hex'),
    toBranchId: dto.toBranchId,
    identifiers: [...dto.identifiers].map((i) => i.trim()).sort(),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * The transaction client of the TENANT-scoped client, not the plain
 * `Prisma.TransactionClient`. Using the extended type keeps company scoping in
 * force inside transactions instead of silently dropping to an unscoped client.
 */
type TransferTx = Omit<TenantPrisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

@Injectable()
export class TransfersService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly invoiceNumbers: InvoiceNumberService,
    private readonly notifications: NotificationsService,
    private readonly pricing: PricingService,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  // --- configurable per-branch prefix (stored in settings) -----------------

  private async getPrefix(branchId: Buffer): Promise<string> {
    const setting = await this.db.setting.findFirst({ where: { branchId, key: 'transfer_prefix' } });
    return typeof setting?.value === 'string' ? setting.value : '';
  }

  async setPrefix(prefix: string) {
    const branchId = this.tenant.requireBranchId();
    const existing = await this.db.setting.findFirst({ where: { branchId, key: 'transfer_prefix' } });
    if (existing) {
      await this.db.setting.update({ where: { id: existing.id }, data: { value: prefix } });
    } else {
      await this.db.setting.create({
        data: { id: newUuidV7Bin(), companyId: this.tenant.companyId(), branchId, key: 'transfer_prefix', value: prefix },
      });
    }
    return { branchId: binToUuid(branchId), transferPrefix: prefix };
  }

  // --- lifecycle ------------------------------------------------------------

  /**
   * Request a transfer, reserving every unit in the same transaction.
   *
   * Two defects proven live in the H0 audit are closed here: a requested phone
   * used to stay in_stock and could be sold underneath its transfer, and a
   * second transfer could claim the same unit. Both existed because nothing was
   * reserved -- the clash only surfaced later, at ship.
   */
  async create(dto: CreateTransferDto) {
    const companyId = this.tenant.companyId();
    const fromBranchId = this.tenant.requireBranchId();
    const toBranchId = uuidToBin(dto.toBranchId);
    if (fromBranchId.equals(toBranchId)) {
      throw new BadRequestException('Cannot transfer to the same branch');
    }

    /**
     * A replay of the same request id returns the original transfer instead of
     * moving stock a second time. A flaky connection on Send is the normal
     * case, not an exotic one.
     */
    const replay = await this.findReplay(dto, companyId);
    if (replay) return replay;

    const toBranch = await this.db.branch.findUnique({ where: { id: toBranchId } });
    if (!toBranch) throw new NotFoundException('Destination branch not found');

    /**
     * Duplicates are REPORTED, not silently collapsed. The old code ran the list
     * through a Set, so scanning the same phone twice looked like success and
     * the user never learned their count was wrong.
     */
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const raw of dto.identifiers) {
      const id = raw.trim();
      if (seen.has(id)) duplicates.add(id);
      seen.add(id);
    }
    if (duplicates.size > 0) {
      throw new BadRequestException({
        message: 'The same item was scanned more than once',
        problems: [...duplicates].map((identifier) => ({ identifier, reason: 'scanned twice' })),
      });
    }
    const identifiers = [...seen];

    const units = await this.db.unit.findMany({
      where: { OR: [{ imeiPrimary: { in: identifiers } }, { serialNo: { in: identifiers } }] },
    });
    const byIdentifier = new Map(units.map((u) => [unitIdentifier(u), u]));

    const problems: { identifier: string; reason: string }[] = [];
    for (const identifier of identifiers) {
      const u = byIdentifier.get(identifier);
      if (!u) problems.push({ identifier, reason: 'not found' });
      else if (u.status !== 'in_stock') problems.push({ identifier, reason: `is ${u.status}` });
      else if (!u.branchId.equals(fromBranchId)) problems.push({ identifier, reason: 'not at this branch' });
    }
    if (problems.length > 0) {
      throw new BadRequestException({ message: 'Some units cannot be transferred', problems });
    }

    const prefix = await this.getPrefix(fromBranchId);
    const userId = this.tenant.userId();

    /**
     * A requester who already holds `transfer.approve` HERE has nothing to wait
     * for: making a manager approve their own request would be ceremony, not
     * control. The row records that the approval was automatic, so the audit
     * trail never shows an approved transfer with no approver.
     */
    const selfApproves = this.has('transfer.approve');

    let created: { id: Buffer; transferNo: string | null };
    try {
      created = await this.db.$transaction(async (tx) => {
        const id = newUuidV7Bin();

        /**
         * Reserve FIRST, with a compare-and-swap on the status.
         *
         * updateMany with status: 'in_stock' in the WHERE is the whole
         * invariant: MySQL takes a row lock for the UPDATE and holds it until
         * commit, so a concurrent request for the same unit blocks, then
         * re-reads a row that is already reserved and matches nothing. Exactly
         * one transaction can see the unit as in_stock, so exactly one can claim
         * it. An application-level "is it free?" read could not promise that --
         * it would be true when checked and false when acted on.
         */
        for (const identifier of identifiers) {
          const unit = byIdentifier.get(identifier)!;
          const claimed = await tx.unit.updateMany({
            where: { id: unit.id, companyId, branchId: fromBranchId, status: 'in_stock' },
            data: { status: 'reserved' },
          });
          if (claimed.count === 0) {
            // Someone sold it, moved it, or claimed it for another transfer
            // between our check and this write. Reserve none, create nothing.
            throw new ConflictException({
              message: 'That item is no longer available',
              problems: [{ identifier, reason: 'claimed by someone else' }],
            });
          }
        }

        const transferNo = await this.invoiceNumbers.next(
          tx as unknown as Prisma.TransactionClient,
          fromBranchId,
          'transfer',
          (seq) => `TRF-${prefix ? `${prefix}-` : ''}${String(seq).padStart(6, '0')}`,
        );
        await tx.stockTransfer.create({
          data: {
            id, companyId, fromBranchId, toBranchId, transferNo,
            status: selfApproves ? 'approved' : 'pending_approval',
            requestedById: userId ?? null,
            ...(selfApproves
              ? { approvedById: userId ?? null, approvedAt: new Date(), autoApproved: true }
              : {}),
            clientUuid: uuidToBin(dto.clientUuid),
            clientRequestHash: transferFingerprint(dto, fromBranchId),
          },
        });
        for (const identifier of identifiers) {
          await tx.transferItem.create({
            data: { id: newUuidV7Bin(), companyId, transferId: id, unitId: byIdentifier.get(identifier)!.id, quantity: 1 },
          });
        }
        await this.audit.recordTx(tx, {
          entityType: 'StockTransfer',
          entityId: id,
          action: 'create',
          after: {
            transferNo,
            to: binToUuid(toBranchId),
            units: identifiers.length,
            reserved: identifiers.length,
            status: selfApproves ? 'approved' : 'pending_approval',
            autoApproved: selfApproves,
          },
          branchId: fromBranchId,
        });
        return { id, transferNo };
      });
    } catch (e) {
      /**
       * Two identical requests racing.
       *
       * The loser can fail in either of two ways, and a live race showed both:
       * the unique key on (company, clientUuid) rejects it, OR the reservation
       * compare-and-swap finds the unit already claimed — by the winner, which
       * is running the very same request. Only checking for P2002 left that
       * second case reporting a conflict for work that had in fact succeeded.
       *
       * So: on either failure, ask whether this request id already produced a
       * transfer. If it did, return it. If it did not, the conflict is real and
       * is rethrown untouched.
       */
      const raced =
        (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') ||
        e instanceof ConflictException;
      if (raced) {
        const winner = await this.findReplay(dto, companyId);
        if (winner) return winner;
      }
      throw e;
    }

    return {
      id: binToUuid(created.id),
      transferNo: created.transferNo,
      status: selfApproves ? 'approved' : 'pending_approval',
      autoApproved: selfApproves,
      version: 0,
      units: identifiers.length,
    };
  }

  /**
   * Has this exact request already been carried out?
   *
   * Company-scoped, so one company's request id can never suppress another's
   * transfer. A key reused for a DIFFERENT payload is a 409 rather than a
   * misleading success: the caller believes they sent something we did not do.
   */
  private async findReplay(dto: CreateTransferDto, companyId: Buffer) {
    const prior = await this.db.stockTransfer.findFirst({
      where: { companyId, clientUuid: uuidToBin(dto.clientUuid) },
      include: { items: true },
    });
    if (!prior) return null;

    if (prior.clientRequestHash && prior.clientRequestHash !== transferFingerprint(dto, prior.fromBranchId)) {
      throw new ConflictException(
        'This request id was already used for a different transfer. Start a new one.',
      );
    }
    return {
      id: binToUuid(prior.id),
      transferNo: prior.transferNo,
      status: prior.status,
      autoApproved: prior.autoApproved,
      version: prior.version,
      units: prior.items.length,
    };
  }

  /** Does the caller hold this permission in the ACTIVE branch? */
  private has(permission: string): boolean {
    return this.cls.get('permissions')?.has(permission) ?? false;
  }

  /**
   * Move a transfer to a new status, but only from the exact version the
   * caller last saw.
   *
   * The compare-and-swap is the whole concurrency story: two managers acting on
   * one request -- approve versus reject, ship versus cancel -- both read
   * version N, and only the first UPDATE matches. The loser changes zero rows
   * and is told to refresh rather than silently overwriting a decision somebody
   * else just made.
   */
  private async transitionTx(
    tx: TransferTx,
    transfer: StockTransfer,
    to: TransferStatus,
    expectedVersion: number,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    assertTransferTransition(transfer.status, to);
    const moved = await tx.stockTransfer.updateMany({
      where: { id: transfer.id, companyId: this.tenant.companyId(), version: expectedVersion },
      data: { status: to, version: { increment: 1 }, ...extra },
    });
    if (moved.count === 0) {
      throw new ConflictException({
        code: 'refresh_required',
        message: 'Someone else acted on this transfer. Refresh and try again.',
      });
    }
  }

  /**
   * Release every unit this transfer is holding, in the same transaction as the
   * status change.
   *
   * Scoped to the status we expect to find, so a retry cannot free a unit that
   * has since been legitimately claimed by something else: the second run
   * matches nothing and changes nothing.
   */
  private async releaseReservationsTx(
    tx: TransferTx,
    transferId: Buffer,
    fromBranchId: Buffer,
    action: string,
  ): Promise<number> {
    const items = await tx.transferItem.findMany({ where: { transferId } });
    let released = 0;
    for (const i of items) {
      if (!i.unitId) continue;
      const done = await tx.unit.updateMany({
        where: { id: i.unitId, status: 'reserved' },
        data: { status: 'in_stock' },
      });
      if (done.count > 0) {
        released += 1;
        await this.audit.recordTx(tx, {
          entityType: 'Unit',
          entityId: i.unitId,
          action: 'status_change',
          before: { status: 'reserved' },
          after: { status: 'in_stock' },
          reason: action,
          branchId: fromBranchId,
        });
      }
    }
    return released;
  }

  /**
   * Approve a pending request.
   *
   * Units are ALREADY reserved from the request (H1.1), so approval must not
   * reserve again -- it only records that somebody with the authority agreed.
   */
  async approve(idStr: string, dto: TransferDecisionDto) {
    const fromBranchId = this.tenant.requireBranchId();
    const transfer = await this.load(idStr);
    if (!transfer.fromBranchId.equals(fromBranchId)) {
      throw new ForbiddenException('Approve from the branch the stock is leaving');
    }
    const userId = this.tenant.userId();

    await this.db.$transaction(async (tx) => {
      await this.transitionTx(tx, transfer, 'approved', dto.expectedVersion, {
        approvedById: userId ?? null,
        approvedAt: new Date(),
      });
      await this.audit.recordTx(tx, {
        entityType: 'StockTransfer',
        entityId: transfer.id,
        action: 'status_change',
        before: { status: 'pending_approval' },
        after: { status: 'approved', transferNo: transfer.transferNo },
        branchId: fromBranchId,
      });
    });

    return this.getById(idStr);
  }

  /**
   * Refuse a pending request and hand the stock back.
   *
   * A reason is mandatory: the requester is being told no, and "no" without a
   * reason is how the same request gets raised again next week.
   */
  async reject(idStr: string, dto: TransferDecisionDto) {
    const fromBranchId = this.tenant.requireBranchId();
    const transfer = await this.load(idStr);
    if (!transfer.fromBranchId.equals(fromBranchId)) {
      throw new ForbiddenException('Reject from the branch the stock is leaving');
    }
    const reason = (dto.reason ?? '').trim();
    if (!reason) throw new BadRequestException('Say why the request is refused');
    const userId = this.tenant.userId();

    await this.db.$transaction(async (tx) => {
      const t = tx;
      await this.transitionTx(t, transfer, 'rejected', dto.expectedVersion, {
        decisionReason: reason,
        decidedById: userId ?? null,
        decidedAt: new Date(),
      });
      const released = await this.releaseReservationsTx(t, transfer.id, fromBranchId, 'transfer rejected');
      await this.audit.recordTx(tx, {
        entityType: 'StockTransfer',
        entityId: transfer.id,
        action: 'status_change',
        before: { status: 'pending_approval' },
        after: { status: 'rejected', transferNo: transfer.transferNo, released },
        reason,
        branchId: fromBranchId,
      });
    });

    return this.getById(idStr);
  }
  async ship(idStr: string, dto: TransferDecisionDto) {
    const fromBranchId = this.tenant.requireBranchId();
    const transfer = await this.load(idStr);
    if (!transfer.fromBranchId.equals(fromBranchId)) {
      throw new ForbiddenException('Ship from the origin branch');
    }
    assertTransferTransition(transfer.status, 'in_transit');

    const items = await this.db.transferItem.findMany({
      where: { transferId: transfer.id },
      include: { unit: true },
    });
    /**
     * Since H1.1 a requested unit is already `reserved` by its own transfer, so
     * that is what ship expects to find. Anything else means the unit left this
     * transfer's control -- sold, moved, or released -- and shipping it would
     * move stock that is no longer ours to move.
     */
    const notReady = items.filter(
      (i) => !i.unit || i.unit.status !== 'reserved' || !i.unit.branchId.equals(fromBranchId),
    );
    if (notReady.length > 0) {
      throw new ConflictException({
        message: 'Some units are no longer in stock at this branch',
        units: notReady.map((i) => (i.unit ? unitIdentifier(i.unit) : null)),
      });
    }

    await this.db.$transaction(async (tx) => {
      for (const i of items) {
        /**
         * Compare-and-swap again rather than a blind update: between the check
         * above and this write the unit could have been released by a cancel.
         * A count of 0 aborts the whole shipment instead of half-shipping it.
         */
        const moved = await tx.unit.updateMany({
          where: { id: i.unitId!, status: 'reserved' },
          data: { status: 'in_transit' },
        });
        if (moved.count === 0) {
          throw new ConflictException({
            message: 'Some units are no longer reserved for this transfer',
            units: [i.unit ? unitIdentifier(i.unit) : null],
          });
        }
        await this.audit.recordTx(tx, {
          entityType: 'Unit',
          entityId: i.unitId!,
          action: 'status_change',
          before: { status: 'reserved' },
          after: { status: 'in_transit' },
          branchId: fromBranchId,
        });
      }
      await this.transitionTx(tx, transfer, 'in_transit', dto.expectedVersion, {
        sentAt: new Date(),
        sentById: this.tenant.userId() ?? null,
      });
      await this.audit.recordTx(tx, {
        entityType: 'StockTransfer',
        entityId: transfer.id,
        action: 'status_change',
        before: { status: 'approved' },
        after: { status: 'in_transit' },
        branchId: fromBranchId,
      });
    });

    await this.notifications.emit({
      type: 'transfer.incoming',
      title: `Incoming transfer ${transfer.transferNo}`,
      body: `${items.length} unit(s) on the way`,
      branchId: transfer.toBranchId,
    });
    return { id: binToUuid(transfer.id), transferNo: transfer.transferNo, status: 'in_transit' };
  }

  /** Step 1: scan → discrepancy report only (NO mutation). */
  async receivePreview(idStr: string, dto: ReceiveTransferDto): Promise<DiscrepancyReport> {
    const toBranchId = this.tenant.requireBranchId();
    const transfer = await this.load(idStr);
    if (!transfer.toBranchId.equals(toBranchId)) {
      throw new ForbiddenException('Receive at the destination branch');
    }
    if (transfer.status !== 'in_transit') {
      throw new ConflictException(`Transfer is '${transfer.status}', not in transit`);
    }
    const expected = await this.expectedIdentifiers(transfer.id);
    return computeDiscrepancy(expected, dto.identifiers);
  }

  /** Step 2: explicit confirm → apply inventory, status, audit, notification. */
  async receiveConfirm(idStr: string, dto: ReceiveTransferDto & { expectedVersion: number }) {
    const toBranchId = this.tenant.requireBranchId();
    const transfer = await this.load(idStr);
    if (!transfer.toBranchId.equals(toBranchId)) {
      throw new ForbiddenException('Receive at the destination branch');
    }
    assertTransferTransition(transfer.status, 'received');

    const items = await this.db.transferItem.findMany({
      where: { transferId: transfer.id },
      include: { unit: true },
    });
    const expected = items.map((i) => unitIdentifier(i.unit!));
    const report = computeDiscrepancy(expected, dto.identifiers);
    const matched = new Set(report.matched);

    await this.db.$transaction(async (tx) => {
      const moved: { unitId: Buffer; productId: Buffer; fromBranchId: Buffer; toBranchId: Buffer }[] = [];
      for (const i of items) {
        if (matched.has(unitIdentifier(i.unit!))) {
          /**
           * Compare-and-swap on `in_transit`, so a retried receive moves the
           * unit exactly once: the second attempt matches nothing, and the
           * branch move plus its price invalidation do not run twice.
           */
          const arrived = await tx.unit.updateMany({
            where: { id: i.unitId!, status: 'in_transit' },
            data: { status: 'in_stock', branchId: toBranchId },
          });
          if (arrived.count === 0) continue;
          moved.push({
            unitId: i.unitId!,
            productId: i.unit!.productId,
            fromBranchId: i.unit!.branchId,
            toBranchId,
          });
          await this.audit.recordTx(tx, {
            entityType: 'Unit',
            entityId: i.unitId!,
            action: 'status_change',
            before: { status: 'in_transit' },
            after: { status: 'in_stock', branch: binToUuid(toBranchId) },
            branchId: toBranchId,
          });
        }
        // missing units remain 'in_transit' (flagged by the discrepancy audit).
      }

      /**
       * A phone that changes branch loses the price it was given elsewhere.
       *
       * The price was set under one branch's authority; carrying it into another
       * would apply a decision nobody made there. This runs in the same
       * transaction as the move, so the two commit or roll back together — a
       * failed receive must never leave a phone stripped of its price, and a
       * successful one must never leave a stale price behind.
       */
      await this.pricing.invalidateOnBranchMoveTx(tx, moved);
      await this.transitionTx(tx, transfer, 'received', dto.expectedVersion, {
        receivedById: this.tenant.userId() ?? null,
        receivedAt: new Date(),
      });
      await this.audit.recordTx(tx, {
        entityType: 'StockTransfer',
        entityId: transfer.id,
        action: 'status_change',
        before: { status: 'in_transit' },
        after: { status: 'received' },
        branchId: toBranchId,
      });
      if (report.hasDiscrepancy) {
        await this.audit.recordTx(tx, {
          entityType: 'StockTransfer',
          entityId: transfer.id,
          action: 'update',
          reason: 'discrepancy detected',
          after: { discrepancy: report as unknown as Prisma.InputJsonValue },
          branchId: toBranchId,
        });
      }
    });

    await this.notifications.emit({
      type: 'transfer.received',
      title: `Transfer ${transfer.transferNo} received`,
      body: report.hasDiscrepancy
        ? `With discrepancies — missing ${report.missing.length}, unexpected ${report.unexpected.length}`
        : 'All units received',
      branchId: toBranchId,
    });

    return { received: report.matched.length, report };
  }

  /**
   * Withdraw a transfer before it ships.
   *
   * Two authorities reach this: `transfer.cancel` cancels anything in the
   * branch, while `transfer.cancel_own` lets a requester withdraw only the
   * request they raised, and only while nobody has acted on it. Keeping them as
   * separate permissions rather than one permission with a condition is what
   * stops a later change quietly widening the employee case.
   */
  async cancel(idStr: string, dto: TransferDecisionDto) {
    const activeBranch = this.tenant.requireBranchId();
    const transfer = await this.load(idStr);
    if (!transfer.fromBranchId.equals(activeBranch)) {
      throw new ForbiddenException('Cancel from the branch the stock is leaving');
    }

    const reason = (dto.reason ?? '').trim();
    if (!reason) throw new BadRequestException('Say why the transfer is being cancelled');

    const userId = this.tenant.userId();
    const canCancelAny = this.has('transfer.cancel');
    if (!canCancelAny) {
      /**
       * Employee path. Two conditions, both required: it must be THEIR request,
       * and nobody must have approved it yet. Once a manager has agreed, undoing
       * that is a manager decision.
       */
      const isRequester = transfer.requestedById?.equals(userId ?? Buffer.alloc(0)) ?? false;
      if (!isRequester) {
        throw new ForbiddenException('You can only withdraw a request you made yourself');
      }
      if (transfer.status !== 'pending_approval') {
        throw new ForbiddenException(
          'This request has already been acted on — ask a manager to cancel it',
        );
      }
    }

    /**
     * After shipment there is no ordinary cancellation. The goods are physically
     * in motion, and rewriting the unit back to the source branch would be a
     * guess about where they are. Return-to-source is future work; refusing is
     * the honest answer. (The state machine enforces this too.)
     */
    if (transfer.status === 'in_transit') {
      throw new ConflictException(
        'This transfer has already been shipped and cannot be cancelled',
      );
    }

    await this.db.$transaction(async (tx) => {
      const t = tx;
      await this.transitionTx(t, transfer, 'cancelled', dto.expectedVersion, {
        decisionReason: reason,
        decidedById: userId ?? null,
        decidedAt: new Date(),
      });
      const released = await this.releaseReservationsTx(t, transfer.id, transfer.fromBranchId, 'transfer cancelled');
      await this.audit.recordTx(tx, {
        entityType: 'StockTransfer',
        entityId: transfer.id,
        action: 'status_change',
        before: { status: transfer.status },
        after: { status: 'cancelled', transferNo: transfer.transferNo, released },
        reason,
        branchId: transfer.fromBranchId,
      });
    });

    return this.getById(idStr);
  }
  /**
   * Transfers touching the active branch, newest first.
   *
   * Gated on `transfer.view` at the controller (H1.2) — it used to have no
   * permission at all, so any signed-in user could browse every transfer in the
   * company.
   */
  list(): Promise<StockTransfer[]> {
    const branchId = this.tenant.requireBranchId();
    return this.db.stockTransfer.findMany({
      // A branch sees what it is sending AND what is coming to it; those are the
      // two ends that have work to do.
      where: { OR: [{ fromBranchId: branchId }, { toBranchId: branchId }] },
      orderBy: { id: 'desc' },
      take: 100,
    });
  }

  async getById(idStr: string) {
    const transfer = await this.db.stockTransfer.findUnique({
      where: { id: uuidToBin(idStr) },
      include: { items: { include: { unit: { select: { imeiPrimary: true, status: true } } } } },
    });
    if (!transfer) throw new NotFoundException('Transfer not found');
    return transfer;
  }

  // --- helpers --------------------------------------------------------------

  private async load(idStr: string): Promise<StockTransfer> {
    const transfer = await this.db.stockTransfer.findUnique({ where: { id: uuidToBin(idStr) } });
    if (!transfer) throw new NotFoundException('Transfer not found');
    return transfer;
  }

  private async expectedIdentifiers(transferId: Buffer): Promise<string[]> {
    const items = await this.db.transferItem.findMany({
      where: { transferId },
      include: { unit: { select: { imeiPrimary: true, serialNo: true } } },
    });
    return items.map((i) => unitIdentifier(i.unit!));
  }
}
