import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { binToUuid, uuidToBin } from '../common/utils/uuid.util';
import { requestRollupTx } from '../analytics/rollup-queue';
import { knownMargin } from '../sales/known-margin';
import { CompleteCostDto } from './dto/complete-cost.dto';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Entering a buying cost that was not known when the stock was received (0107).
 *
 * Only a MISSING cost is entered here: a known one is corrected by the unit
 * correction, with its reason, as before. Entering it moves no money — what
 * was paid was not recorded and is not invented now — and it never rewrites a
 * sale's price or creates a sale.
 *
 * ## What changes
 *
 * - **A unit** (IMEI or serial): its cost, and its purchase line. If it was
 *   already sold on a day that is still open, that sale's line takes the cost
 *   too and the sale's cost and margin are recomputed, so profit becomes
 *   complete. A sale on a CLOSED day is left as it is — the closing froze that
 *   day's figures (the existing locked-period rule) — and the answer says so.
 * - **A counted receipt line**: its cost, and the pieces of unknown cost still
 *   on hand are folded into the branch average. Pieces already sold stay
 *   unknown: nobody can say which ones left.
 *
 * Audited, and requested of the rollups, inside the same transaction.
 */
@Injectable()
export class CostCompletionService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
  ) {}

  async completeUnit(idStr: string, dto: CompleteCostDto) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const id = uuidToBin(idStr);
    const unit = await this.db.unit.findFirst({ where: { id, branchId }, select: { id: true, cost: true, productId: true, purchaseId: true } });
    if (!unit) throw new NotFoundException('That item is not in this branch.');
    if (unit.cost !== null) {
      throw new ConflictException({ code: 'cost_known', message: 'This item already has a buying cost. Correct it from the item instead.' });
    }
    const cost = round2(dto.cost);

    return this.db.$transaction(async (tx) => {
      const set = await tx.unit.updateMany({ where: { id, cost: null }, data: { cost } });
      if (set.count !== 1) throw new ConflictException({ code: 'cost_known', message: 'Someone entered this cost meanwhile.' });

      if (unit.purchaseId) {
        const line = await tx.purchaseItem.findFirst({
          where: { purchaseId: unit.purchaseId, productId: unit.productId, quantity: 1, unitCost: null },
          select: { id: true },
        });
        if (line) await tx.purchaseItem.update({ where: { id: line.id }, data: { unitCost: cost } });
      }

      const sold = await tx.saleItem.findFirst({
        where: { unitId: id, voided: false, cost: null },
        select: { id: true, saleId: true, sale: { select: { branchId: true, businessDate: true } } },
      });
      let saleCompleted = false;
      let saleOnClosedDay = false;
      if (sold) {
        const closing = await tx.dailyClosing.findFirst({
          where: { branchId: sold.sale.branchId, closingDate: sold.sale.businessDate, isLocked: true },
          select: { id: true },
        });
        if (closing) {
          saleOnClosedDay = true;
        } else {
          await tx.saleItem.update({ where: { id: sold.id }, data: { cost } });
          await this.recomputeSale(tx as unknown as Prisma.TransactionClient, sold.saleId);
          await requestRollupTx(tx as never, [
            { kind: 'daily', companyId, branchId: sold.sale.branchId, day: dayOf(sold.sale.businessDate), cause: 'cost_completed', sourceId: id },
          ]);
          saleCompleted = true;
        }
      }
      await requestRollupTx(tx as never, [{ kind: 'branch', companyId, branchId, cause: 'cost_completed', sourceId: id }]);

      await this.audit.recordTx(tx, {
        entityType: 'Unit',
        entityId: id,
        action: 'update',
        before: { cost: null } as Prisma.InputJsonValue,
        after: { cost, costCompleted: true, saleCompleted, saleOnClosedDay } as Prisma.InputJsonValue,
        reason: dto.reason?.trim() || 'Buying cost entered after receiving',
        branchId,
      });
      return { unitId: binToUuid(id), cost, saleCompleted, saleOnClosedDay };
    });
  }

  /** The counted receipt lines of a product at this branch whose cost is not known yet. */
  async missingStockLines(productIdStr: string) {
    const branchId = this.tenant.requireBranchId();
    const productId = uuidToBin(productIdStr);
    const lines = await this.db.purchaseItem.findMany({
      where: { productId, unitCost: null, purchase: { branchId } },
      select: { id: true, quantity: true, purchase: { select: { date: true, referenceNo: true } } },
      orderBy: { purchase: { date: 'asc' } },
      take: 50,
    });
    const stock = await this.db.stockItem.findFirst({ where: { productId, branchId }, select: { missingCostQuantity: true } });
    return {
      missingCostQuantity: stock?.missingCostQuantity ?? 0,
      lines: lines.map((l) => ({ id: binToUuid(l.id), quantity: l.quantity, receivedAt: l.purchase.date, reference: l.purchase.referenceNo })),
    };
  }

  async completeStockLine(purchaseItemIdStr: string, dto: CompleteCostDto) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const id = uuidToBin(purchaseItemIdStr);
    const line = await this.db.purchaseItem.findFirst({
      where: { id, purchase: { branchId } },
      select: { id: true, productId: true, quantity: true, unitCost: true, product: { select: { trackingType: true } } },
    });
    if (!line || line.product.trackingType !== 'quantity') throw new NotFoundException('That received line is not in this branch.');
    if (line.unitCost !== null) {
      throw new ConflictException({ code: 'cost_known', message: 'This line already has a buying cost.' });
    }
    const cost = round2(dto.cost);

    return this.db.$transaction(async (tx) => {
      const set = await tx.purchaseItem.updateMany({ where: { id, unitCost: null }, data: { unitCost: cost } });
      if (set.count !== 1) throw new ConflictException({ code: 'cost_known', message: 'Someone entered this cost meanwhile.' });

      const stock = await tx.stockItem.findFirst({
        where: { productId: line.productId, branchId },
        select: { id: true, quantity: true, cost: true, missingCostQuantity: true },
      });
      // Pieces of this line still on hand: as many as are of unknown cost, at most the line's own quantity.
      const folded = stock ? Math.min(stock.missingCostQuantity, line.quantity) : 0;
      if (stock && folded > 0) {
        const knownQty = stock.quantity - stock.missingCostQuantity;
        const average =
          stock.cost === null || knownQty <= 0 ? cost : round2((knownQty * Number(stock.cost) + folded * cost) / (knownQty + folded));
        const moved = await tx.stockItem.updateMany({
          where: { id: stock.id, missingCostQuantity: stock.missingCostQuantity, quantity: stock.quantity },
          data: { cost: average, missingCostQuantity: { decrement: folded } },
        });
        if (moved.count !== 1) throw new ConflictException({ code: 'stock_moved', message: 'This stock changed meanwhile. Try again.' });
      }
      await requestRollupTx(tx as never, [{ kind: 'branch', companyId, branchId, cause: 'cost_completed', sourceId: id }]);

      await this.audit.recordTx(tx, {
        entityType: 'PurchaseItem',
        entityId: id,
        action: 'update',
        before: { unitCost: null } as Prisma.InputJsonValue,
        after: { unitCost: cost, costCompleted: true, piecesValued: folded, piecesSoldUnknown: line.quantity - folded } as Prisma.InputJsonValue,
        reason: dto.reason?.trim() || 'Buying cost entered after receiving',
        branchId,
      });
      return { purchaseItemId: binToUuid(id), cost, piecesValued: folded, piecesSoldUnknown: line.quantity - folded };
    });
  }

  /** The sale's recorded cost and margin, from its lines as they now stand — its price untouched. */
  private async recomputeSale(tx: Prisma.TransactionClient, saleId: Buffer): Promise<void> {
    const sale = await tx.sale.findUniqueOrThrow({
      where: { id: saleId },
      select: { subtotal: true, discount: true, total: true, items: { where: { voided: false }, select: { price: true, quantity: true, discount: true, cost: true } } },
    });
    const lines = sale.items.map((i) => ({ price: Number(i.price), quantity: i.quantity, discount: Number(i.discount), cost: i.cost === null ? null : Number(i.cost) }));
    const lineDiscounts = lines.reduce((s, l) => s + l.discount, 0);
    const totalCost = round2(lines.reduce((s, l) => s + (l.cost ?? 0) * l.quantity, 0));
    const margin = round2(knownMargin(lines, Number(sale.subtotal), Number(sale.discount) - lineDiscounts, Number(sale.total), totalCost));
    await tx.sale.update({ where: { id: saleId }, data: { totalCost, margin } });
  }
}
