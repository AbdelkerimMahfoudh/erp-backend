import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { SalePayStatus, Unit } from '@prisma/client';

const EPSILON = 0.005;

export interface PaymentReconciliation {
  amountPaid: number;
  balanceDue: number;
  payStatus: SalePayStatus;
}

/**
 * Centralizes ALL sale validation + business rules (WF6/WF13). Pure/deterministic
 * where possible so it is unit-testable; DB reads are done by SalesService and
 * passed in. Rounds money to 2 decimals.
 */
@Injectable()
export class SalesPolicyService {
  round(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  /** A serialized unit must be in stock at the active branch to be sold. */
  assertSellable(unit: Unit, branchId: Buffer): void {
    if (unit.status !== 'in_stock') {
      throw new ConflictException(
        `Unit ${unit.imeiPrimary} is '${unit.status}' and cannot be sold`,
      );
    }
    if (!unit.branchId.equals(branchId)) {
      throw new ConflictException(`Unit ${unit.imeiPrimary} is not at this branch`);
    }
  }

  /** Resolve a line's unit price: explicit override, else the product default. */
  resolvePrice(provided: number | undefined, defaultPrice: number | null): number {
    if (provided !== undefined) return provided;
    if (defaultPrice !== null && defaultPrice !== undefined) return defaultPrice;
    throw new BadRequestException('A price is required (no default price on the product)');
  }

  /** Payments must not exceed the total; the remainder becomes a receivable. */
  reconcilePayments(payments: { amount: number }[], total: number): PaymentReconciliation {
    const amountPaid = this.round(payments.reduce((s, p) => s + p.amount, 0));
    if (amountPaid > total + EPSILON) {
      throw new BadRequestException(`Payments (${amountPaid}) exceed the total (${total})`);
    }
    const balanceDue = this.round(total - amountPaid);
    const payStatus: SalePayStatus =
      balanceDue <= EPSILON ? 'paid' : amountPaid <= EPSILON ? 'credit' : 'partial';
    return { amountPaid, balanceDue, payStatus };
  }

  /** Selling below cost requires `discount.override` + a reason (WF13 soft-block). */
  assertBelowCostAllowed(
    margin: number,
    hasOverride: boolean,
    reason: string | undefined,
  ): void {
    if (margin < -EPSILON) {
      if (!hasOverride) {
        throw new ForbiddenException('Selling below cost requires the discount.override permission');
      }
      if (!reason || reason.trim().length === 0) {
        throw new BadRequestException('An override reason is required to sell below cost');
      }
    }
  }

  /** A credit/partial sale needs a customer to hold the receivable. */
  assertCreditHasCustomer(payStatus: SalePayStatus, customerId?: string): void {
    if ((payStatus === 'credit' || payStatus === 'partial') && !customerId) {
      throw new BadRequestException('A customer is required for a credit/partial sale');
    }
  }
}
