import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { SalePayStatus, Unit } from '@prisma/client';
import { payStatusOf } from './sale-payment-rules';
import { lineShareCents, toCents } from './sale-shares';

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

  /**
   * A serialized unit must be in stock at the active branch to be sold.
   *
   * The refusal names the unit by whichever identifier it actually carries —
   * a camera or a console has a serial number and no IMEI, and "Unit null is
   * reserved" told the seller nothing.
   */
  assertSellable(unit: Unit, branchId: Buffer): void {
    const name = unit.imeiPrimary ?? unit.serialNo;
    const who = name ? `Unit ${name}` : 'That unit';
    if (unit.status !== 'in_stock') {
      throw new ConflictException(`${who} is '${unit.status}' and cannot be sold`);
    }
    if (!unit.branchId.equals(branchId)) {
      throw new ConflictException(`${who} is not at this branch`);
    }
  }

  /** Resolve a line's unit price: explicit override, else the product default. */
  resolvePrice(provided: number | undefined, defaultPrice: number | null): number {
    if (provided !== undefined) return provided;
    if (defaultPrice !== null && defaultPrice !== undefined) return defaultPrice;
    throw new BadRequestException('A price is required (no default price on the product)');
  }

  /**
   * The money received now against the amount due. Its parts — at most four
   * places, each once (`assertPaymentParts`) — pay all or part of the total,
   * never more; what they leave unpaid is a balance that needs a named debtor
   * (0074). Paid plus owed is always the total.
   */
  reconcilePayments(payments: { amount: number }[], total: number): PaymentReconciliation {
    const amountPaid = this.round(payments.reduce((s, p) => s + p.amount, 0));
    if (amountPaid > total + EPSILON) {
      // The same code a later collection gives, so the phone reads one refusal for one mistake.
      throw new BadRequestException({
        code: 'overpayment',
        message: `The payments add up to ${amountPaid}, more than the ${total} due.`,
      });
    }
    const balanceDue = this.round(total - amountPaid);
    // One status rule for the whole app: a sale and a later collection must
    // never disagree about what "partially paid" means.
    const payStatus: SalePayStatus = payStatusOf(total, amountPaid);
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

  /**
   * A discount may not take a line below its cost (BE4-01).
   *
   * `assertPriceAllowed` judges each line's unit price. A line discount and the
   * whole-sale discount come off afterwards, so on their own they reached a
   * price that was never judged: a phone priced at its set price with a
   * discount of most of it sold at a loss with no approval and no reason. The
   * cost floor is enforced independently of `discount.apply` (docs/21 D2.1), so
   * it is measured here on what the line actually sells for — its share of the
   * invoice total, the same share the rollup and a refund use (D36).
   *
   * Only a line the discounts took below cost is refused: a price below cost
   * with no discount is `assertPriceAllowed`'s, and is excepted by an approval
   * of that exact final price, which a further discount would no longer be.
   */
  assertDiscountsKeepCost(
    lines: readonly { price: number; quantity: number; discount: number; cost: number }[],
    total: number,
    describe: (index: number) => { index: number; unitId: string | null; identifier: string | null },
  ): void {
    const ids = lines.map((_, index) => {
      const id = Buffer.alloc(4);
      id.writeUInt32BE(index);
      return id;
    });
    const shares = lineShareCents(
      lines.map((l, index) => ({ id: ids[index], price: l.price, quantity: l.quantity, discount: l.discount })),
      total,
    );
    for (const [index, line] of lines.entries()) {
      const share = shares.get(ids[index].toString('hex')) ?? 0n;
      const listed = toCents(line.price) * BigInt(line.quantity);
      const cost = toCents(line.cost) * BigInt(line.quantity);
      if (share < listed && share < cost) {
        const where = describe(index);
        throw new ForbiddenException({
          code: 'discount_below_cost',
          lineIndex: where.index,
          unitId: where.unitId,
          identifier: where.identifier,
          message: 'This discount sells the item below cost. Ask the Owner to approve the final price instead.',
        });
      }
    }
  }
}
