import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CodeType, Prisma, Product } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { InventoryService } from '../inventory/inventory.service';
import { TrackingStrategyRegistry } from '../tracking/tracking-strategy.registry';
import { RecognitionService } from '../scanner/recognition.service';
import { ROLLUP_QUEUE, RollupQueue } from '../analytics/rollup-queue';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { CreatePurchaseDto, ReceiveItemDto } from './dto/create-purchase.dto';

interface RejectedLine {
  identifier: string;
  reason: string;
}

interface PreparedUnit {
  productId: Buffer;
  identifier: string;
  imeiPrimary: string | null;
  serialNo: string | null;
  cost: number;
}

interface PreparedStock {
  productId: Buffer;
  quantity: number;
  cost: number;
  price: number;
}

/** A confirmed receiving line to teach the scanner after commit. */
interface LearnPlan {
  productId: Buffer;
  codeType: CodeType;
  code: string;
}

@Injectable()
export class PurchasingService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
    private readonly notifications: NotificationsService,
    private readonly strategies: TrackingStrategyRegistry,
    private readonly recognition: RecognitionService,
    @Inject(ROLLUP_QUEUE) private readonly rollups: RollupQueue,
  ) {}

  async createPurchase(dto: CreatePurchaseDto) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const items = dto.items ?? [];
    if (items.length === 0) throw new BadRequestException('Purchase must include at least one item');

    const supplier = await this.db.supplier.findUnique({ where: { id: uuidToBin(dto.supplierId) } });
    if (!supplier) throw new NotFoundException('Supplier not found');

    // Load every referenced product once (must belong to this company).
    const productIds = [...new Set(items.map((i) => i.productId))];
    const products = await this.db.product.findMany({ where: { id: { in: productIds.map(uuidToBin) } } });
    const productByUuid = new Map(products.map((p) => [binToUuid(p.id), p]));

    const rejected: RejectedLine[] = [];
    const preparedUnits: PreparedUnit[] = [];
    const preparedStock: PreparedStock[] = [];
    const learnPlans: LearnPlan[] = [];
    const seen = new Set<string>(); // in-batch identifier dedupe

    // 1. Dispatch each item by its product's tracking strategy (product-first).
    for (const item of items) {
      const product = productByUuid.get(item.productId);
      if (!product) {
        rejected.push({ identifier: item.productId, reason: 'unknown product' });
        continue;
      }
      const strategy = this.strategies.get(product.trackingType);

      if (strategy.perUnit) {
        const ids = item.identifiers ?? [];
        if (ids.length === 0) {
          rejected.push({ identifier: item.productId, reason: `${strategy.identifierLabel} required` });
          continue;
        }
        for (const raw of ids) {
          const check = strategy.validateIdentifier(raw);
          const normalized = strategy.normalize(raw);
          if (!check.ok) rejected.push({ identifier: raw, reason: check.reason ?? 'invalid identifier' });
          else if (seen.has(normalized)) rejected.push({ identifier: normalized, reason: 'duplicate in batch' });
          else {
            seen.add(normalized);
            preparedUnits.push({
              productId: product.id,
              identifier: normalized,
              ...this.identifierColumns(product, normalized),
              cost: item.unitCost,
            });
          }
        }
      } else {
        const quantity = item.quantity ?? 0;
        if (quantity < 1) {
          rejected.push({ identifier: item.productId, reason: 'quantity required' });
          continue;
        }
        preparedStock.push({
          productId: product.id,
          quantity,
          cost: item.unitCost,
          price: item.price ?? Number(product.defaultPrice ?? 0),
        });
      }

      const plan = this.learnPlanFor(product, item);
      if (plan) learnPlans.push(plan);
    }

    // 2. Same-company duplicate pre-check (global unique index is the backstop).
    const existing = await this.inventory.findExistingIdentifiers(preparedUnits.map((u) => u.identifier));
    const committableUnits = preparedUnits.filter((u) => {
      if (existing.has(u.identifier)) {
        rejected.push({ identifier: u.identifier, reason: 'already registered' });
        return false;
      }
      return true;
    });

    if (committableUnits.length === 0 && preparedStock.length === 0) {
      return { purchaseId: null, unitsCreated: 0, stockLines: 0, total: 0, rejected };
    }

    // 3. Totals.
    const unitsCost = committableUnits.reduce((s, u) => s + u.cost, 0);
    const stockCost = preparedStock.reduce((s, l) => s + l.cost * l.quantity, 0);
    const total = Number((unitsCost + stockCost).toFixed(2));
    const amountPaid = dto.paidAmount ?? 0;
    if (amountPaid > total) throw new BadRequestException('Paid amount exceeds total');
    const status = amountPaid >= total ? 'paid' : amountPaid > 0 ? 'partial' : 'unpaid';

    // 4. Commit — one atomic transaction (the Receiving Session "Finish").
    let purchaseId: Buffer;
    try {
      purchaseId = await this.db.$transaction(async (tx) => {
        const pid = newUuidV7Bin();
        await tx.purchase.create({
          data: {
            id: pid,
            companyId,
            branchId,
            supplierId: supplier.id,
            userId: this.tenant.userId() ?? null,
            referenceNo: dto.referenceNo ?? null,
            date: new Date(),
            subtotal: total,
            taxTotal: 0,
            total,
            amountPaid,
            status,
            dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          },
        });

        for (const u of committableUnits) {
          await tx.purchaseItem.create({
            data: { id: newUuidV7Bin(), companyId, purchaseId: pid, productId: u.productId, quantity: 1, unitCost: u.cost, taxAmount: 0 },
          });
          await this.inventory.createUnit(tx, {
            productId: u.productId,
            branchId,
            imeiPrimary: u.imeiPrimary,
            serialNo: u.serialNo,
            cost: u.cost,
            supplierId: supplier.id,
            purchaseId: pid,
          });
        }

        for (const l of preparedStock) {
          await tx.purchaseItem.create({
            data: { id: newUuidV7Bin(), companyId, purchaseId: pid, productId: l.productId, quantity: l.quantity, unitCost: l.cost, taxAmount: 0 },
          });
          await tx.stockItem.upsert({
            where: { companyId_productId_branchId: { companyId, productId: l.productId, branchId } },
            create: { id: newUuidV7Bin(), companyId, productId: l.productId, branchId, quantity: l.quantity, cost: l.cost, price: l.price },
            update: { quantity: { increment: l.quantity } },
          });
        }

        const payable = Number((total - amountPaid).toFixed(2));
        if (payable !== 0) {
          await tx.supplier.update({ where: { id: supplier.id }, data: { balance: { increment: payable } } });
        }
        if (amountPaid > 0) {
          await tx.supplierPayment.create({
            data: { id: newUuidV7Bin(), companyId, supplierId: supplier.id, purchaseId: pid, amount: amountPaid, method: 'cash' },
          });
        }

        await this.audit.recordTx(tx, {
          entityType: 'Purchase',
          entityId: pid,
          action: 'create',
          after: { total, units: committableUnits.length, stockLines: preparedStock.length },
          branchId,
        });
        return pid;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('A duplicate identifier was detected during commit — please retry');
      }
      throw e;
    }

    // 5. Post-commit side effects: notifications + recognition learning.
    // Receiving is the STRONGEST learning signal, and only fires on a confirmed
    // (committed) purchase. Supplier context is stamped for future intelligence.
    for (const plan of learnPlans) {
      await this.recognition.learn({
        codeType: plan.codeType,
        code: plan.code,
        productId: plan.productId,
        source: 'receiving',
        supplierId: supplier.id,
      });
    }

    const received = committableUnits.length + preparedStock.reduce((s, l) => s + l.quantity, 0);
    if (received > 0) {
      await this.notifications.emit({
        type: 'stock.received',
        title: `Received ${received} item(s)`,
        body: `Purchase total ${total}`,
      });
      // Intake changed inventory → refresh the branch valuation/velocity snapshot.
      this.rollups.enqueueBranchRefresh({ companyId, branchId });
    }

    return {
      purchaseId: binToUuid(purchaseId),
      unitsCreated: committableUnits.length,
      stockLines: preparedStock.length,
      total,
      rejected,
    };
  }

  /** Map an identifier onto the right unit column for the product's type. */
  private identifierColumns(product: Product, identifier: string): { imeiPrimary: string | null; serialNo: string | null } {
    const field = this.strategies.get(product.trackingType).identifierField;
    return {
      imeiPrimary: field === 'imeiPrimary' ? identifier : null,
      serialNo: field === 'serialNo' ? identifier : null,
    };
  }

  /**
   * Decide what to teach for a received item: the recognitionKey the client
   * echoed from /scan, else a derived key (TAC for IMEI). Serial has no learnable
   * key yet (reserved); quantity barcodes are already taught at product create.
   */
  private learnPlanFor(product: Product, item: ReceiveItemDto): LearnPlan | null {
    if (item.recognitionKey) {
      return { productId: product.id, codeType: item.recognitionKey.codeType, code: item.recognitionKey.code };
    }
    if (product.trackingType === 'imei' && item.identifiers?.length) {
      const key = this.strategies.get('imei').recognitionKey(item.identifiers[0]);
      if (key) return { productId: product.id, codeType: key.codeType, code: key.code };
    }
    return null;
  }
}
