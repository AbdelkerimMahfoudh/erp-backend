import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Prisma, StockTransfer } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { AppClsStore } from '../common/context/request-context';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { InvoiceNumberService } from '../common/numbering/invoice-number.service';
import { PricingService } from '../pricing/pricing.service';
import { TransferNotifier } from './transfer-notifications';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { assertTransferTransition } from './transfer-state-machine';
import { TransferStatus } from '@prisma/client';
import { computeDiscrepancy, DiscrepancyReport } from './discrepancy.util';
import { unitIdentifier } from '../inventory/unit-identifier.util';
import { computeActions, requestedAtOf } from './transfer-view';
import {
  CreateTransferDto,
  ListTransfersDto,
  ReceiveTransferDto,
  TransferDecisionDto,
  TRANSFER_STATUSES,
} from './dto/transfer.dto';

import {
  countLines,
  normalizeLines,
  transferFingerprint,
  type NormalizedLines,
} from './transfer-lines';
import { releaseQuantity, reserveQuantity } from './quantity-reservation';

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
    private readonly notifier: TransferNotifier,
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

    // Duplicates are refused here, before anything else, so an over-request
    // hidden across two lines of the same product never reaches availability.
    const lines = normalizeLines(dto);

    /**
     * A replay of the same request id returns the original transfer instead of
     * moving stock a second time. A flaky connection on Send is the normal
     * case, not an exotic one.
     */
    const replay = await this.findReplay(dto, lines, companyId);
    if (replay) return replay;

    const toBranch = await this.db.branch.findUnique({ where: { id: toBranchId } });
    if (!toBranch) throw new NotFoundException('Destination branch not found');

    const identifiers = lines.identifiers;
    const stockPlan = await this.planQuantityLines(lines, companyId, fromBranchId);

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

    const counts = countLines([
      ...identifiers.map(() => ({ unitId: Buffer.alloc(1), quantity: 1 })),
      ...stockPlan.map((l) => ({ unitId: null, quantity: l.quantity })),
    ]);

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

        /**
         * Quantity lines, reserved by the same principle in one statement each.
         *
         * `reserveQuantity` only matches when `quantity - reserved_quantity` is
         * still large enough, evaluated by MySQL against the committed row while
         * it holds the lock. A competing request for the last of something
         * blocks, re-checks against the winner's result, and matches nothing.
         *
         * A failure throws, which rolls the whole transaction back — so a mixed
         * request whose last line cannot be met leaves **no** phone reserved and
         * no transfer created. Partly-reserved is not a state this workflow has.
         */
        for (const line of stockPlan) {
          const ok = await reserveQuantity(tx, {
            companyId,
            productId: line.productId,
            branchId: fromBranchId,
            wanted: line.quantity,
          });
          if (!ok) throw await this.unavailable(tx, line, companyId, fromBranchId);
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
            clientRequestHash: transferFingerprint(lines, fromBranchId, dto.toBranchId),
          },
        });
        for (const identifier of identifiers) {
          await tx.transferItem.create({
            data: { id: newUuidV7Bin(), companyId, transferId: id, unitId: byIdentifier.get(identifier)!.id, quantity: 1 },
          });
        }
        for (const line of stockPlan) {
          // `shippedUnitCost` stays NULL: nothing has left yet, and a cost
          // written now would be the cost at request time rather than the cost
          // of the goods that actually go.
          await tx.transferItem.create({
            data: {
              id: newUuidV7Bin(),
              companyId,
              transferId: id,
              productId: line.productId,
              quantity: line.quantity,
            },
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
            quantityLines: stockPlan.length,
            totalQuantity: counts.totalQuantity,
            reserved: identifiers.length,
            reservedQuantity: stockPlan.reduce((s, l) => s + l.quantity, 0),
            status: selfApproves ? 'approved' : 'pending_approval',
            autoApproved: selfApproves,
          },
          branchId: fromBranchId,
        });

        /**
         * Tell the people who have to act next, in the same transaction. A
         * pending request nobody is told about is the H1.2 gap: correct, and
         * invisible until somebody happens to open the list.
         *
         * Which people depends on whether it still needs approving — an
         * auto-approved transfer has nothing to wait for, so the news belongs
         * to the destination rather than to an approver.
         */
        await this.notifier.notifyTx(tx, {
          transfer: {
            id, companyId, fromBranchId, toBranchId, transferNo,
            requestedById: userId ?? null,
          },
          event: selfApproves ? 'created_approved' : 'requested',
          actorId: userId ?? null,
          units: counts.totalQuantity,
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
        const winner = await this.findReplay(dto, lines, companyId);
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
      units: counts.unitCount,
      quantityLines: counts.quantityLineCount,
      totalQuantity: counts.totalQuantity,
    };
  }

  /**
   * Has this exact request already been carried out?
   *
   * Company-scoped, so one company's request id can never suppress another's
   * transfer. A key reused for a DIFFERENT payload is a 409 rather than a
   * misleading success: the caller believes they sent something we did not do.
   */
  private async findReplay(dto: CreateTransferDto, lines: NormalizedLines, companyId: Buffer) {
    const prior = await this.db.stockTransfer.findFirst({
      where: { companyId, clientUuid: uuidToBin(dto.clientUuid) },
      include: { items: true },
    });
    if (!prior) return null;

    const fingerprint = transferFingerprint(lines, prior.fromBranchId, dto.toBranchId);
    if (prior.clientRequestHash && prior.clientRequestHash !== fingerprint) {
      throw new ConflictException(
        'This request id was already used for a different transfer. Start a new one.',
      );
    }
    const counts = countLines(prior.items);
    return {
      id: binToUuid(prior.id),
      transferNo: prior.transferNo,
      status: prior.status,
      autoApproved: prior.autoApproved,
      version: prior.version,
      units: counts.unitCount,
      quantityLines: counts.quantityLineCount,
      totalQuantity: counts.totalQuantity,
    };
  }

  /**
   * Turn the requested quantity lines into source stock rows, refusing anything
   * that is not this branch's quantity stock.
   *
   * Done BEFORE the transaction so the common refusals — unknown product, a
   * phone sent as a quantity line, nothing of it here — cost nothing and read
   * clearly. It is emphatically **not** an availability check: what is free now
   * can be gone by the time the reservation runs, so availability is decided
   * only by the conditional UPDATE inside the transaction.
   */
  private async planQuantityLines(
    lines: NormalizedLines,
    companyId: Buffer,
    fromBranchId: Buffer,
  ): Promise<{ productId: Buffer; quantity: number }[]> {
    if (lines.quantities.length === 0) return [];

    const ids = lines.quantities.map((q) => uuidToBin(q.productId));
    const products = await this.db.product.findMany({
      where: { id: { in: ids } },
      select: { id: true, trackingType: true, brand: true, model: true, variant: true },
    });
    const byId = new Map(products.map((p) => [p.id.toString('hex'), p]));

    const stock = await this.db.stockItem.findMany({
      where: { companyId, branchId: fromBranchId, productId: { in: ids } },
      select: { productId: true, quantity: true, reservedQuantity: true },
    });
    const stockById = new Map(stock.map((s) => [s.productId.toString('hex'), s]));

    const problems: Record<string, unknown>[] = [];
    const plan: { productId: Buffer; quantity: number }[] = [];

    for (const line of lines.quantities) {
      const productId = uuidToBin(line.productId);
      const key = productId.toString('hex');
      const product = byId.get(key);
      if (!product) {
        problems.push({ productId: line.productId, reason: 'not found' });
        continue;
      }
      if (product.trackingType !== 'quantity') {
        // A phone must travel as itself, by its own number. Moving "3 of a
        // model" would leave the destination with no idea which three arrived.
        problems.push({
          productId: line.productId,
          product: label(product),
          reason: 'is tracked individually — send its IMEI or serial instead',
        });
        continue;
      }
      const row = stockById.get(key);
      if (!row) {
        problems.push({ productId: line.productId, product: label(product), reason: 'none at this branch' });
        continue;
      }
      plan.push({ productId, quantity: line.quantity });
    }

    if (problems.length > 0) {
      throw new BadRequestException({ message: 'Some items cannot be transferred', problems });
    }
    return plan;
  }

  /**
   * The refusal a lost reservation produces: what was asked for, against what
   * the branch actually holds.
   *
   * Read after the failed UPDATE so the numbers describe the state that refused
   * it rather than a stale snapshot. **No cost appears anywhere** — this is an
   * availability answer, and cost is gated by `cost.view` elsewhere for a
   * reason.
   */
  private async unavailable(
    tx: TransferTx,
    line: { productId: Buffer; quantity: number },
    companyId: Buffer,
    branchId: Buffer,
  ): Promise<ConflictException> {
    const row = await tx.stockItem.findFirst({
      where: { companyId, productId: line.productId, branchId },
      select: { quantity: true, reservedQuantity: true, product: { select: { brand: true, model: true, variant: true } } },
    });
    const quantity = row?.quantity ?? 0;
    const reserved = row?.reservedQuantity ?? 0;
    return new ConflictException({
      message: 'There is not enough of that left to transfer',
      problems: [
        {
          productId: binToUuid(line.productId),
          product: row?.product ? label(row.product) : null,
          requested: line.quantity,
          physicalQuantity: quantity,
          reservedQuantity: reserved,
          availableQuantity: Math.max(quantity - reserved, 0),
          reason: 'claimed by someone else',
        },
      ],
    });
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

    /**
     * Quantity lines hand their reservation back the same way, guarded on the
     * reservation still being large enough. A repeated reject or a stale cancel
     * therefore releases nothing twice: the second attempt matches no row.
     *
     * Physical quantity is untouched. Nothing ever left the shelf — that only
     * happens at shipment.
     */
    let releasedQuantity = 0;
    for (const i of items) {
      if (!i.productId) continue;
      const ok = await releaseQuantity(tx, {
        companyId: this.tenant.companyId(),
        productId: i.productId,
        branchId: fromBranchId,
        amount: i.quantity,
      });
      if (ok) {
        releasedQuantity += i.quantity;
        await this.audit.recordTx(tx, {
          entityType: 'StockItem',
          entityId: i.productId,
          action: 'update',
          before: { reserved: i.quantity },
          after: { reserved: 0 },
          reason: action,
          branchId: fromBranchId,
        });
      }
    }
    return released + releasedQuantity;
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
      await this.notifier.notifyTx(tx, {
        transfer,
        event: 'approved',
        actorId: userId ?? null,
        units: await this.countItemsTx(tx, transfer.id),
      });
    });

    return this.getById(idStr);
  }

  /** How many items this transfer carries — the only number a notification quotes. */
  private countItemsTx(tx: TransferTx, transferId: Buffer): Promise<number> {
    return tx.transferItem.count({ where: { transferId } });
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
      // Only the person who asked. A refusal broadcast to the branch helps
      // nobody and embarrasses somebody.
      await this.notifier.notifyTx(tx, {
        transfer,
        event: 'rejected',
        actorId: userId ?? null,
        units: await this.countItemsTx(t, transfer.id),
        reason,
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
      /**
       * Moved INSIDE the transaction (H1.3). It used to be emitted after the
       * commit as a company-wide broadcast: every user of every branch saw
       * "incoming transfer", and if the emit failed the shipment happened with
       * nobody told. Now it is targeted at the people who must receive it, and
       * it commits with the shipment or not at all.
       */
      await this.notifier.notifyTx(tx, {
        transfer,
        event: 'shipped',
        actorId: this.tenant.userId() ?? null,
        units: items.length,
      });
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
      // Closes the loop for whoever asked and whoever let the stock go — in the
      // same transaction as the arrival, and no longer broadcast to everyone.
      await this.notifier.notifyTx(tx, {
        transfer,
        event: 'received',
        actorId: this.tenant.userId() ?? null,
        units: report.matched.length,
      });
    });

    return { received: report.matched.length, report };
  }

  /**
   * Withdraw a transfer before it ships.
   *
   * Two keys, two different jobs. `transfer.cancel_own` is the ROUTE key that
   * lets a caller reach this endpoint at all; `transfer.cancel` is the BREADTH
   * key that lets them cancel somebody else's transfer. Managers hold both,
   * employees only the first — so the route permission alone can never widen
   * into general cancellation, which is checked here rather than at the guard.
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
      // Everyone already involved: whoever asked, whoever could have approved
      // it, and the destination that may have been expecting it.
      await this.notifier.notifyTx(tx, {
        transfer,
        event: 'cancelled',
        actorId: userId ?? null,
        units: await this.countItemsTx(t, transfer.id),
        reason,
      });
    });

    return this.getById(idStr);
  }
  /**
   * Transfers touching the active branch, newest first, with search and paging.
   *
   * Gated on `transfer.view` at the controller (H1.2) — it used to have no
   * permission at all, so any signed-in user could browse every transfer in the
   * company. It also used to return raw rows with `take: 100` and no filter, so
   * a busy shop simply lost its older history.
   */
  async list(query: ListTransfersDto) {
    const branchId = this.tenant.requireBranchId();
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);

    const statuses = (query.status ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is TransferStatus => (TRANSFER_STATUSES as readonly string[]).includes(s));
    if (query.status && statuses.length === 0) {
      throw new BadRequestException('Unknown transfer status filter');
    }

    const rows = await this.db.stockTransfer.findMany({
      where: {
        // A branch sees what it is sending AND what is coming to it; those are
        // the two ends that have work to do.
        OR: [{ fromBranchId: branchId }, { toBranchId: branchId }],
        ...(statuses.length > 0 ? { status: { in: statuses } } : {}),
        ...this.searchWhere(query.search),
      },
      include: {
        fromBranch: { select: { id: true, name: true } },
        toBranch: { select: { id: true, name: true } },
        requestedBy: { select: { name: true } },
        _count: { select: { items: true } },
      },
      // The PK is a UUIDv7: unique, immutable and time-ordered, so `id desc` is
      // "newest first" AND a total order. Keyset paging on it cannot skip or
      // repeat a row when somebody creates a transfer mid-scroll, which
      // skip/take would.
      ...(query.cursor ? { cursor: { id: uuidToBin(query.cursor) }, skip: 1 } : {}),
      orderBy: { id: 'desc' },
      take: limit + 1,
    });

    const page = rows.slice(0, limit);
    return {
      rows: page.map((t) => ({
        id: binToUuid(t.id),
        transferNo: t.transferNo,
        status: t.status,
        // Which way the stock is moving, seen from where the user stands.
        direction: t.fromBranchId.equals(branchId) ? 'outgoing' : 'incoming',
        from: { id: binToUuid(t.fromBranch.id), name: t.fromBranch.name },
        to: { id: binToUuid(t.toBranch.id), name: t.toBranch.name },
        itemCount: t._count.items,
        requestedBy: t.requestedBy?.name ?? null,
        requestedAt: requestedAtOf(t.id),
        approvedAt: t.approvedAt,
        sentAt: t.status === 'pending_approval' || t.status === 'approved' ? null : t.sentAt,
        receivedAt: t.receivedAt,
        decidedAt: t.decidedAt,
        decisionReason: t.decisionReason,
        autoApproved: t.autoApproved,
      })),
      nextCursor: rows.length > limit ? binToUuid(page[page.length - 1]!.id) : null,
    };
  }

  /**
   * Search in SQL, across everything a person might remember about a movement:
   * the reference on the paperwork, either branch, what the thing was, or the
   * number printed on it.
   *
   * MySQL's default collation is case-insensitive, so `contains` needs no
   * lowering — and lowering would defeat the index anyway.
   */
  private searchWhere(search?: string): Prisma.StockTransferWhereInput {
    const q = search?.trim();
    if (!q) return {};
    return {
      OR: [
        { transferNo: { contains: q } },
        { fromBranch: { name: { contains: q } } },
        { toBranch: { name: { contains: q } } },
        { items: { some: { unit: { imeiPrimary: { contains: q } } } } },
        { items: { some: { unit: { serialNo: { contains: q } } } } },
        { items: { some: { unit: { product: { brand: { contains: q } } } } } },
        { items: { some: { unit: { product: { model: { contains: q } } } } } },
        { items: { some: { unit: { product: { variant: { contains: q } } } } } },
      ],
    };
  }

  /**
   * How much work is waiting at this branch, in one grouped query.
   *
   * Three numbers for the navigation badge. Deliberately a COUNT rather than a
   * page the client tallies: draining the list to colour a badge is how a shop
   * with a year of history gets a slow home screen.
   */
  async counts() {
    const branchId = this.tenant.requireBranchId();
    const grouped = await this.db.stockTransfer.groupBy({
      by: ['status'],
      where: {
        OR: [{ fromBranchId: branchId }, { toBranchId: branchId }],
        status: { in: ['pending_approval', 'approved', 'in_transit'] },
      },
      _count: { _all: true },
    });
    const of = (status: TransferStatus) =>
      grouped.find((g) => g.status === status)?._count._all ?? 0;
    return {
      pendingApproval: of('pending_approval'),
      approved: of('approved'),
      inTransit: of('in_transit'),
    };
  }

  /**
   * One transfer, with everything the detail screen shows and what may be done.
   *
   * Readable from ANY branch the caller is assigned to, deliberately: a
   * notification must be able to open the transfer it is about even when the
   * app is pointed at the other end. Every ACTION still names the branch it
   * requires, so the screen can offer "Switch to Main Store" rather than a bare
   * refusal. No cost, price or margin is returned at all.
   */
  async getById(idStr: string) {
    const activeBranchId = this.tenant.requireBranchId();
    const transfer = await this.db.stockTransfer.findUnique({
      where: { id: uuidToBin(idStr) },
      include: {
        fromBranch: { select: { id: true, name: true } },
        toBranch: { select: { id: true, name: true } },
        requestedBy: { select: { name: true } },
        approvedBy: { select: { name: true } },
        decidedBy: { select: { name: true } },
        sentBy: { select: { name: true } },
        receivedBy: { select: { name: true } },
        items: {
          include: {
            unit: {
              select: {
                imeiPrimary: true,
                serialNo: true,
                status: true,
                product: { select: { brand: true, model: true, variant: true } },
              },
            },
          },
        },
      },
    });
    if (!transfer) throw new NotFoundException('Transfer not found');

    return {
      id: binToUuid(transfer.id),
      transferNo: transfer.transferNo,
      status: transfer.status,
      version: transfer.version,
      direction: transfer.fromBranchId.equals(activeBranchId) ? 'outgoing' : 'incoming',
      from: { id: binToUuid(transfer.fromBranch.id), name: transfer.fromBranch.name },
      to: { id: binToUuid(transfer.toBranch.id), name: transfer.toBranch.name },
      autoApproved: transfer.autoApproved,
      decisionReason: transfer.decisionReason,
      people: {
        requestedBy: transfer.requestedBy?.name ?? null,
        approvedBy: transfer.approvedBy?.name ?? null,
        decidedBy: transfer.decidedBy?.name ?? null,
        sentBy: transfer.sentBy?.name ?? null,
        receivedBy: transfer.receivedBy?.name ?? null,
      },
      timestamps: {
        requestedAt: requestedAtOf(transfer.id),
        approvedAt: transfer.approvedAt,
        // `sentAt` carries DEFAULT now() from the original schema, so it is only
        // a shipping time once the transfer has actually shipped.
        sentAt: transfer.status === 'pending_approval' || transfer.status === 'approved' ? null : transfer.sentAt,
        receivedAt: transfer.receivedAt,
        decidedAt: transfer.decidedAt,
      },
      items: transfer.items.map((i) => ({
        id: binToUuid(i.id),
        identifier: i.unit ? unitIdentifier(i.unit) : null,
        product: i.unit?.product
          ? [i.unit.product.brand, i.unit.product.model, i.unit.product.variant].filter(Boolean).join(' ')
          : null,
        unitStatus: i.unit?.status ?? null,
      })),
      actions: computeActions({
        transfer,
        from: transfer.fromBranch,
        to: transfer.toBranch,
        activeBranchId,
        userId: this.tenant.userId() ?? null,
        permissions: this.cls.get('permissions') ?? new Set<string>(),
      }),
    };
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

/** "Anker PowerCore 10000" — how a person names the thing, never a code. */
function label(p: { brand: string; model: string; variant: string | null }): string {
  return [p.brand, p.model, p.variant].filter(Boolean).join(" ");
}
