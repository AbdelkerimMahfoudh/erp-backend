import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Sale } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { AppClsStore } from '../common/context/request-context';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { InvoiceNumberService } from '../common/numbering/invoice-number.service';
import { SpineEventBus } from '../common/events/spine-event-bus';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { dayKey } from '../common/utils/date.util';
import { canTransition } from '../inventory/unit-state-machine';
import { PricingService } from '../pricing/pricing.service';
import { SalesPolicyService } from './sales-policy.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import { ReturnSaleDto } from './dto/return-sale.dto';

interface PreparedLine {
  unitId?: Buffer;
  productId: Buffer;
  quantity: number;
  price: number;
  discount: number;
  cost: number;
}

@Injectable()
export class SalesService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly policy: SalesPolicyService,
    private readonly pricing: PricingService,
    private readonly invoiceNumbers: InvoiceNumberService,
    private readonly events: SpineEventBus,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  async createSale(dto: CreateSaleDto) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.userId();
    if (!userId) throw new BadRequestException('No authenticated user');
    const hasOverride = this.cls.get('permissions')?.has('discount.override') ?? false;

    // Idempotency (offline retries).
    if (dto.clientUuid) {
      // Scoped by company (0014): one company's key must never resolve — or
      // suppress — another company's sale.
      const existing = await this.db.sale.findFirst({
        where: { companyId, clientUuid: uuidToBin(dto.clientUuid) },
      });
      if (existing) return this.toResponse(existing);
    }

    // Each line is a serialized unit (identifier) XOR a quantity product (productId+quantity).
    for (const l of dto.lines) {
      if (Boolean(l.identifier) === Boolean(l.productId)) {
        throw new BadRequestException('Each line must be either an identifier (serialized unit) or a productId (quantity product)');
      }
    }

    let result: { saleId: Buffer; invoiceNo: string; total: number; margin: number; balanceDue: number; payStatus: Sale['payStatus'] };
    try {
      result = await this.db.$transaction(async (tx) => {
        const prepared: PreparedLine[] = [];

        for (const l of dto.lines) {
          const discount = l.discount ?? 0;
          if (l.identifier) {
            const unit = await tx.unit.findFirst({
              where: { OR: [{ imeiPrimary: l.identifier }, { serialNo: l.identifier }] },
              include: { product: { select: { defaultPrice: true } } },
            });
            if (!unit) throw new NotFoundException(`Unit not found: ${l.identifier}`);
            this.policy.assertSellable(unit, branchId);
            /**
             * The counter may still type the price actually agreed with the
             * customer — that has always been allowed and stays allowed. What
             * changed is the fallback: it is now the pricing ladder (this
             * phone's own price, then the branch price for the model, then the
             * company default) rather than the company default alone. Asking
             * PricingService rather than repeating the ladder here is what stops
             * Sell and the pricing screens from drifting apart.
             */
            const resolved = await this.pricing.resolveForSaleTx(
              tx,
              {
                kind: 'unit',
                unitId: unit.id,
                productId: unit.productId,
                unitBranchId: unit.branchId,
                productDefault: unit.product.defaultPrice ? Number(unit.product.defaultPrice) : null,
              },
              branchId,
            );
            const price = this.policy.resolvePrice(l.price, resolved.price);
            prepared.push({ unitId: unit.id, productId: unit.productId, quantity: 1, price, discount, cost: Number(unit.cost) });
          } else {
            const productId = uuidToBin(l.productId as string);
            const quantity = l.quantity ?? 1;
            const stock = await tx.stockItem.findUnique({
              where: { companyId_productId_branchId: { companyId, productId, branchId } },
            });
            if (!stock || stock.quantity < quantity) {
              throw new ConflictException('Insufficient accessory stock');
            }
            // Quantity stock keeps its own branch price; the resolver returns it
            // with an honest `stock_item` source rather than a second source.
            const resolved = await this.pricing.resolveForSaleTx(
              tx,
              {
                kind: 'quantity',
                productId,
                stock: { price: Number(stock.price), version: stock.version },
                productDefault: null,
              },
              branchId,
            );
            const price = this.policy.resolvePrice(l.price, resolved.price);
            prepared.push({ productId, quantity, price, discount, cost: Number(stock.cost) });
          }
        }

        const subtotal = this.policy.round(prepared.reduce((s, p) => s + p.price * p.quantity, 0));
        const discountTotal = this.policy.round(
          prepared.reduce((s, p) => s + p.discount, 0) + (dto.saleDiscount ?? 0),
        );
        const total = this.policy.round(subtotal - discountTotal);
        if (total < 0) throw new BadRequestException('Discount exceeds subtotal');
        const totalCost = this.policy.round(prepared.reduce((s, p) => s + p.cost * p.quantity, 0));
        const margin = this.policy.round(total - totalCost);

        this.policy.assertBelowCostAllowed(margin, hasOverride, dto.overrideReason);
        const { amountPaid, balanceDue, payStatus } = this.policy.reconcilePayments(dto.payments, total);
        this.policy.assertCreditHasCustomer(payStatus, dto.customerId);

        const invoiceNo = await this.invoiceNumbers.next(
          tx as unknown as Prisma.TransactionClient,
          branchId,
        );

        const saleId = newUuidV7Bin();
        await tx.sale.create({
          data: {
            id: saleId,
            companyId,
            branchId,
            userId,
            customerId: dto.customerId ? uuidToBin(dto.customerId) : null,
            invoiceNo,
            soldAt: new Date(),
            subtotal,
            discount: discountTotal,
            taxTotal: 0,
            total,
            totalCost,
            margin,
            amountPaid,
            balanceDue,
            payStatus,
            clientUuid: dto.clientUuid ? uuidToBin(dto.clientUuid) : null,
          },
        });

        for (const p of prepared) {
          await tx.saleItem.create({
            data: {
              id: newUuidV7Bin(),
              companyId,
              saleId,
              unitId: p.unitId ?? null,
              productId: p.unitId ? null : p.productId,
              quantity: p.quantity,
              price: p.price,
              cost: p.cost,
              discount: p.discount,
              taxAmount: 0,
              voided: false,
            },
          });
          if (p.unitId) {
            await tx.unit.update({ where: { id: p.unitId }, data: { status: 'sold', dateSold: new Date() } });
            await this.audit.recordTx(tx, {
              entityType: 'Unit',
              entityId: p.unitId,
              action: 'status_change',
              before: { status: 'in_stock' },
              after: { status: 'sold' },
              branchId,
            });
          } else {
            await tx.stockItem.update({
              where: { companyId_productId_branchId: { companyId, productId: p.productId, branchId } },
              data: { quantity: { decrement: p.quantity } },
            });
          }
        }

        for (const pay of dto.payments) {
          await tx.payment.create({
            data: { id: newUuidV7Bin(), companyId, saleId, method: pay.method, amount: pay.amount },
          });
        }

        if (dto.customerId && balanceDue > 0) {
          await tx.customer.update({
            where: { id: uuidToBin(dto.customerId) },
            data: { balance: { increment: balanceDue } },
          });
        }

        await this.audit.recordTx(tx, {
          entityType: 'Sale',
          entityId: saleId,
          action: 'create',
          after: { invoiceNo, total, margin },
          branchId,
        });
        if (margin < 0) {
          await this.audit.recordTx(tx, {
            entityType: 'Sale',
            entityId: saleId,
            action: 'override',
            reason: dto.overrideReason,
            after: { margin },
            branchId,
          });
        }

        // In-app notification, atomic with the sale.
        await tx.notification.create({
          data: {
            id: newUuidV7Bin(),
            companyId,
            branchId,
            targetUserId: null,
            type: 'sale.recorded',
            title: `Sale ${invoiceNo} — ${total}`,
            body: `${prepared.length} item(s)`,
            isRead: false,
          },
        });

        return { saleId, invoiceNo, total, margin, balanceDue, payStatus };
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('A unit in this sale was just sold — please refresh and retry');
      }
      throw e;
    }

    // After commit: trigger derived side effects (rollups/closing/external in 2D).
    this.events.emit('sale.recorded', {
      saleId: result.saleId,
      companyId,
      branchId,
      day: dayKey(new Date()),
      total: result.total,
      margin: result.margin,
    });

    return {
      id: binToUuid(result.saleId),
      invoiceNo: result.invoiceNo,
      total: result.total,
      margin: result.margin,
      balanceDue: result.balanceDue,
      payStatus: result.payStatus,
    };
  }

  async returnUnit(saleIdStr: string, dto: ReturnSaleDto) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.branchId() ?? undefined;
    const saleId = uuidToBin(saleIdStr);

    const sale = await this.db.sale.findUnique({ where: { id: saleId } });
    if (!sale) throw new NotFoundException('Sale not found');
    const unit = await this.db.unit.findFirst({
      where: { OR: [{ imeiPrimary: dto.identifier }, { serialNo: dto.identifier }] },
    });
    if (!unit) throw new NotFoundException('Unit not found');
    const item = await this.db.saleItem.findFirst({
      where: { saleId, unitId: unit.id, voided: false },
    });
    if (!item) throw new NotFoundException('This unit is not on an active line of this sale');

    const restock = dto.restock ?? true;
    const finalStatus = restock ? 'in_stock' : 'faulty';
    if (!canTransition(unit.status, 'returned') || !canTransition('returned', finalStatus)) {
      throw new ConflictException(`Cannot return a unit that is '${unit.status}'`);
    }
    const refund = dto.refundAmount ?? this.policy.round(Number(item.price) * item.quantity - Number(item.discount));

    return this.db.$transaction(async (tx) => {
      await tx.saleItem.update({ where: { id: item.id }, data: { voided: true } });
      await tx.unit.update({ where: { id: unit.id }, data: { status: finalStatus, dateSold: null } });

      await tx.return.create({
        data: {
          id: newUuidV7Bin(),
          companyId,
          saleId,
          saleItemId: item.id,
          unitId: unit.id,
          reason: dto.reason ?? null,
          refundAmount: refund,
          restock,
        },
      });

      const newTotal = this.policy.round(
        Number(sale.total) - (Number(item.price) * item.quantity - Number(item.discount)),
      );
      const newTotalCost = this.policy.round(Number(sale.totalCost) - Number(item.cost) * item.quantity);
      const remaining = await tx.saleItem.count({ where: { saleId, voided: false } });
      await tx.sale.update({
        where: { id: saleId },
        data: {
          total: newTotal,
          totalCost: newTotalCost,
          margin: this.policy.round(newTotal - newTotalCost),
          isReversed: remaining === 0,
        },
      });

      await this.audit.recordTx(tx, {
        entityType: 'Return',
        entityId: unit.id,
        action: 'create',
        after: { identifier: dto.identifier, refund },
        branchId,
      });
      await this.audit.recordTx(tx, {
        entityType: 'Unit',
        entityId: unit.id,
        action: 'status_change',
        before: { status: 'sold' },
        after: { status: finalStatus },
        branchId,
      });

      return { returned: dto.identifier, refund, saleReversed: remaining === 0 };
    });
  }

  list() {
    const branchId = this.tenant.branchId();
    return this.db.sale.findMany({
      where: branchId ? { branchId } : {},
      orderBy: { soldAt: 'desc' },
      take: 100,
    });
  }

  async getById(idStr: string) {
    const sale = await this.db.sale.findUnique({
      where: { id: uuidToBin(idStr) },
      include: { items: true, payments: true, returns: true },
    });
    if (!sale) throw new NotFoundException('Sale not found');
    return sale;
  }

  private toResponse(sale: Sale) {
    return {
      id: binToUuid(sale.id),
      invoiceNo: sale.invoiceNo,
      total: Number(sale.total),
      margin: Number(sale.margin),
      balanceDue: Number(sale.balanceDue),
      payStatus: sale.payStatus,
    };
  }
}
