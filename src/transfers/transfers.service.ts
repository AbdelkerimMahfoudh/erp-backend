import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma, StockTransfer } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { InvoiceNumberService } from '../common/numbering/invoice-number.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PricingService } from '../pricing/pricing.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { assertTransferTransition } from './transfer-state-machine';
import { computeDiscrepancy, DiscrepancyReport } from './discrepancy.util';
import { unitIdentifier } from '../inventory/unit-identifier.util';
import { CreateTransferDto, ReceiveTransferDto } from './dto/transfer.dto';

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

@Injectable()
export class TransfersService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly invoiceNumbers: InvoiceNumberService,
    private readonly notifications: NotificationsService,
    private readonly pricing: PricingService,
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
            status: 'ready_to_ship', sentById: userId ?? null,
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
          after: { transferNo, to: binToUuid(toBranchId), units: identifiers.length, reserved: identifiers.length },
          branchId: fromBranchId,
        });
        return { id, transferNo };
      });
    } catch (e) {
      /**
       * Two identical requests racing: the unique key on (company, clientUuid)
       * decides, and the loser reads back the winner's transfer rather than
       * reporting a failure for work that did in fact happen.
       */
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await this.findReplay(dto, companyId);
        if (winner) return winner;
      }
      throw e;
    }

    return { id: binToUuid(created.id), transferNo: created.transferNo, status: 'ready_to_ship', units: identifiers.length };
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
      units: prior.items.length,
    };
  }

  async ship(idStr: string) {
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
      await tx.stockTransfer.update({ where: { id: transfer.id }, data: { status: 'in_transit', sentAt: new Date() } });
      await this.audit.recordTx(tx, {
        entityType: 'StockTransfer',
        entityId: transfer.id,
        action: 'status_change',
        before: { status: 'ready_to_ship' },
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
  async receiveConfirm(idStr: string, dto: ReceiveTransferDto) {
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
      await tx.stockTransfer.update({
        where: { id: transfer.id },
        data: { status: 'received', receivedById: this.tenant.userId() ?? null, receivedAt: new Date() },
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

  async cancel(idStr: string) {
    const activeBranch = this.tenant.requireBranchId();
    const transfer = await this.load(idStr);
    if (!transfer.fromBranchId.equals(activeBranch)) {
      throw new ForbiddenException('Cancel from the origin branch');
    }
    assertTransferTransition(transfer.status, 'cancelled');
    const wasInTransit = transfer.status === 'in_transit';
    const items = await this.db.transferItem.findMany({ where: { transferId: transfer.id } });

    await this.db.$transaction(async (tx) => {
      /**
       * Release whatever this transfer was holding, in the same transaction as
       * the status change -- a cancel that fails half way must leave the stock
       * reserved rather than free it for a transfer that still exists.
       *
       * Scoped to `reserved`/`in_transit` so a retried cancel cannot touch a
       * unit that has since been legitimately sold or claimed elsewhere: the
       * second run matches nothing and changes nothing.
       */
      const releaseFrom = wasInTransit ? 'in_transit' : 'reserved';
      for (const i of items) {
        const released = await tx.unit.updateMany({
          where: { id: i.unitId!, status: releaseFrom },
          data: { status: 'in_stock', branchId: transfer.fromBranchId },
        });
        if (released.count > 0) {
          await this.audit.recordTx(tx, {
            entityType: 'Unit',
            entityId: i.unitId!,
            action: 'status_change',
            before: { status: releaseFrom },
            after: { status: 'in_stock' },
            branchId: transfer.fromBranchId,
          });
        }
      }
      await tx.stockTransfer.update({ where: { id: transfer.id }, data: { status: 'cancelled' } });
      await this.audit.recordTx(tx, {
        entityType: 'StockTransfer',
        entityId: transfer.id,
        action: 'status_change',
        before: { status: transfer.status },
        after: { status: 'cancelled' },
        branchId: transfer.fromBranchId,
      });
    });
    return { id: binToUuid(transfer.id), status: 'cancelled' };
  }

  list(): Promise<StockTransfer[]> {
    return this.db.stockTransfer.findMany({ orderBy: { sentAt: 'desc' }, take: 100 });
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
