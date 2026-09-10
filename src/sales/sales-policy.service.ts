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

  /**
   * The two thresholds a sale price can cross (A2).
   *
   * **The floor is the CONFIGURED SELLING PRICE**, not cost. That is the
   * approved product rule, and it is the price the ladder in
   * `price-resolution.ts` resolves — unit override, then branch variant, then
   * the product default. Selling below it needs an Owner-approved exception
   * **even when the sale is still profitable**, because the configured price is
   * the shop's decision about what this thing sells for.
   *
   * Below **cost** is a high-risk subset of the same thing, not a separate
   * gate: the same Owner approval, plus a reason, plus a loss warning for
   * whoever may see cost.
   *
   * ## What changed, and why it is not the old rule
   *
   * The previous version checked only `margin < 0` and let anyone holding
   * `discount.override` sell below cost directly. Two problems: it treated cost
   * as the floor, which is not the rule; and it made the permission a bypass,
   * so the person who wanted the discount was the person who granted it.
   *
   * `discount.override` is now **approval authority, held by the Owner alone**.
   * It does not authorise a sale here at all — only a consumed
   * `DiscountApproval` does. An Owner selling below the floor goes through the
   * same workflow, which is what makes their own discount as traceable as
   * anybody else's.
   */
  assertPriceAllowed(input: {
    /** What the line is actually being sold for. */
    price: number;
    /** The ladder's answer. Null when the product has no configured price. */
    configuredPrice: number | null;
    /** The unit's confirmed cost. */
    cost: number;
    /** A consumed approval covering exactly this unit at exactly this price. */
    approval: { approvedPrice: number; belowCost: boolean } | null;
    /** Required when the price is below cost. */
    reason: string | undefined;
    /**
     * Which line this is, and which physical unit.
     *
     * Carried into the refusal so the phone can open the right request. A sale
     * with three lines and one refusal otherwise leaves the seller to guess
     * which item the Owner is being asked about — and guessing wrong asks for
     * an approval that will never fit the sale.
     */
    line?: { index: number; unitId: string | null; identifier: string | null };
  }): void {
    const { price, configuredPrice, cost, approval, reason } = input;

    /*
     * No configured price means the ladder reached `unpriced`. There is no
     * floor to be below, so there is nothing to approve — the shop has simply
     * never said what this sells for. Inventing a floor from cost here would be
     * the exact substitution this rule exists to remove.
     */
    const belowFloor = configuredPrice !== null && price < configuredPrice - EPSILON;
    const belowCost = price < cost - EPSILON;

    if (!belowFloor && !belowCost) return;

    if (!approval) {
      /*
       * A CODE, not only a sentence.
       *
       * The phone has to tell "ask the Owner" apart from "you may not do this
       * at all", and it cannot do that by matching English prose — least of all
       * in a shop running the app in Arabic. `belowCost` chooses which copy the
       * client shows, and only a reader with `cost.view` is shown the loss
       * framing; everyone else is told a stronger approval is needed, which is
       * true and reveals nothing.
       */
      throw new ForbiddenException({
        code: 'approval_required',
        belowCost,
        configuredPrice,
        lineIndex: input.line?.index ?? null,
        unitId: input.line?.unitId ?? null,
        identifier: input.line?.identifier ?? null,
        message: belowCost
          ? 'Selling below cost needs an Owner approval for this exact unit and price'
          : 'Selling below the set price needs an Owner approval for this exact unit and price',
      });
    }

    /*
     * The approval names a price. The sale must use THAT price, not the one in
     * the request — otherwise an approval for 15 000 would authorise a sale at
     * 1 500, which is the whole reuse problem in miniature.
     */
    if (Math.abs(approval.approvedPrice - price) > EPSILON) {
      throw new ConflictException({
        code: 'approval_price_changed',
        message: 'This approval was granted for a different price. Ask again for the price you want.',
      });
    }

    if (belowCost && (!reason || reason.trim().length === 0)) {
      throw new BadRequestException('A reason is required to sell below cost');
    }
  }

  /** A credit/partial sale needs a customer to hold the receivable. */
  assertCreditHasCustomer(payStatus: SalePayStatus, customerId?: string): void {
    if ((payStatus === 'credit' || payStatus === 'partial') && !customerId) {
      throw new BadRequestException('A customer is required for a credit/partial sale');
    }
  }
}
