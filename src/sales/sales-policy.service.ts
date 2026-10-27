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
   * The one threshold a sale price can cross: its cost (D223, 2026-10-27).
   *
   * ## There is no price floor
   *
   * Until D223 the configured selling price was a floor, and selling below it
   * needed an Owner approval even at a profit. The owner reversed that: the
   * recommended price is a suggestion the seller may move freely. What remains
   * guarded is selling at a LOSS.
   *
   * ## Below cost
   *
   * - Whoever holds `sale.below_cost` (the Owner and Store Managers) may do it
   *   after a high-friction warning — the `loss.below_cost` acknowledgement the
   *   sale raises before anything is written — and with a reason.
   * - Anyone else needs a consumed approval from a holder of `sale.below_cost`,
   *   covering this exact unit at this exact price, and a reason. A quantity
   *   line has no single unit to hold an approval against, so a seller without
   *   the permission asks a Manager to make that sale.
   */
  assertPriceAllowed(input: {
    /** What the line is actually being sold for. */
    price: number;
    /** The unit's confirmed cost, or the branch's average for counted stock. */
    cost: number;
    /** The seller holds `sale.below_cost`. */
    mayAcceptLoss: boolean;
    /** A consumed approval covering exactly this unit at exactly this price. */
    approval: { approvedPrice: number; belowCost: boolean } | null;
    /** Required when the price is below cost. */
    reason: string | undefined;
    /**
     * Which line this is, and which physical unit.
     *
     * Carried into the refusal so the phone can open the right request. A sale
     * with three lines and one refusal otherwise leaves the seller to guess
     * which item the approver is being asked about.
     */
    line?: { index: number; unitId: string | null; identifier: string | null };
  }): void {
    const { price, cost, mayAcceptLoss, approval, reason } = input;
    if (price >= cost - EPSILON) return;

    if (!mayAcceptLoss) {
      if (!approval) {
        /*
         * A CODE, not only a sentence: the phone tells "ask a Manager" apart
         * from "you may not do this at all" without matching English prose.
         * Only a reader with `cost.view` is shown the loss framing.
         */
        throw new ForbiddenException({
          code: 'approval_required',
          belowCost: true,
          lineIndex: input.line?.index ?? null,
          unitId: input.line?.unitId ?? null,
          identifier: input.line?.identifier ?? null,
          message: 'Selling below cost needs the approval of a Manager or the Owner for this exact item and price',
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
    }

    if (!reason || reason.trim().length === 0) {
      throw new BadRequestException({ code: 'reason_required', message: 'Say why you are selling below cost' });
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
    /** The seller holds `sale.below_cost`: the loss warning and a reason cover it instead (D223). */
    mayAcceptLoss = false,
    reason?: string,
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
        if (mayAcceptLoss) {
          if (!reason || reason.trim().length === 0) {
            throw new BadRequestException({ code: 'reason_required', message: 'Say why you are selling below cost' });
          }
          continue;
        }
        const where = describe(index);
        throw new ForbiddenException({
          code: 'discount_below_cost',
          lineIndex: where.index,
          unitId: where.unitId,
          identifier: where.identifier,
          message: 'This discount sells the item below cost. Remove it or make it smaller.',
        });
      }
    }
  }
}
