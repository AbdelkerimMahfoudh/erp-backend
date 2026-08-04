import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, StockTransfer } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { InvoiceNumberService } from '../common/numbering/invoice-number.service';
import { NotificationsService } from '../notifications/notifications.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { assertTransferTransition } from './transfer-state-machine';
import { computeDiscrepancy, DiscrepancyReport } from './discrepancy.util';
import { unitIdentifier } from '../inventory/unit-identifier.util';
import { CreateTransferDto, ReceiveTransferDto } from './dto/transfer.dto';

@Injectable()
export class TransfersService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly invoiceNumbers: InvoiceNumberService,
    private readonly notifications: NotificationsService,
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

  async create(dto: CreateTransferDto) {
    const companyId = this.tenant.companyId();
    const fromBranchId = this.tenant.requireBranchId();
    const toBranchId = uuidToBin(dto.toBranchId);
    if (fromBranchId.equals(toBranchId)) {
      throw new BadRequestException('Cannot transfer to the same branch');
    }
    const toBranch = await this.db.branch.findUnique({ where: { id: toBranchId } });
    if (!toBranch) throw new NotFoundException('Destination branch not found');

    const identifiers = [...new Set(dto.identifiers)];
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

    const created = await this.db.$transaction(async (tx) => {
      const id = newUuidV7Bin();
      const transferNo = await this.invoiceNumbers.next(
        tx as unknown as Prisma.TransactionClient,
        fromBranchId,
        'transfer',
        (seq) => `TRF-${prefix ? `${prefix}-` : ''}${String(seq).padStart(6, '0')}`,
      );
      await tx.stockTransfer.create({
        data: { id, companyId, fromBranchId, toBranchId, transferNo, status: 'ready_to_ship', sentById: userId ?? null },
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
        after: { transferNo, to: binToUuid(toBranchId), units: identifiers.length },
        branchId: fromBranchId,
      });
      return { id, transferNo };
    });

    return { id: binToUuid(created.id), transferNo: created.transferNo, status: 'ready_to_ship', units: identifiers.length };
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
    const notReady = items.filter(
      (i) => !i.unit || i.unit.status !== 'in_stock' || !i.unit.branchId.equals(fromBranchId),
    );
    if (notReady.length > 0) {
      throw new ConflictException({
        message: 'Some units are no longer in stock at this branch',
        units: notReady.map((i) => (i.unit ? unitIdentifier(i.unit) : null)),
      });
    }

    await this.db.$transaction(async (tx) => {
      for (const i of items) {
        await tx.unit.update({ where: { id: i.unitId! }, data: { status: 'in_transit' } });
        await this.audit.recordTx(tx, {
          entityType: 'Unit',
          entityId: i.unitId!,
          action: 'status_change',
          before: { status: 'in_stock' },
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
      for (const i of items) {
        if (matched.has(unitIdentifier(i.unit!))) {
          await tx.unit.update({ where: { id: i.unitId! }, data: { status: 'in_stock', branchId: toBranchId } });
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
      if (wasInTransit) {
        for (const i of items) {
          await tx.unit.update({ where: { id: i.unitId! }, data: { status: 'in_stock', branchId: transfer.fromBranchId } });
          await this.audit.recordTx(tx, {
            entityType: 'Unit',
            entityId: i.unitId!,
            action: 'status_change',
            before: { status: 'in_transit' },
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
