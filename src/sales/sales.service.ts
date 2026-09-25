import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaymentMethod, Prisma, Sale, SalePayStatus } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { AppClsStore } from '../common/context/request-context';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { InvoiceNumberService } from '../common/numbering/invoice-number.service';
import { SpineEventBus } from '../common/events/spine-event-bus';
import { requestRollupTx } from '../analytics/rollup-queue';
import { binToUuid, isUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { dayKey } from '../common/utils/date.util';
import { isDateString } from '../common/business-day';
import { BusinessDayService, dateValue } from '../common/business-day/business-day.service';
import { ClosingService, type AutoReopenResult } from '../closing/closing.service';
import { canTransition } from '../inventory/unit-state-machine';
import { PricingService } from '../pricing/pricing.service';
import { SalesPolicyService } from './sales-policy.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import { ListSalesDto } from './dto/list-sales.dto';
import { evaluateEligibility, NO_RETURNS, resolveWindowForSale, snapshotPolicy } from './return-policy';
import { assertDebtorForBalance, chooseDebtor, type DebtorChoice, STORE_KINDS } from './sale-payment-rules';
import { assertMayStartDealing } from '../consignment/dealing-authorization';
import { paymentSelect, toPaymentView } from './sale-payments.service';
import { describeProduct, parseDateRange, parseEnumList } from './sale-query';
import { DiscountApprovalsService } from '../discount-approvals/discount-approvals.service';
import { MagnitudeReads, MagnitudeService, SALE_PRICE_MIN_SAMPLE } from '../common/warnings/magnitude.service';
import { magnitudeWarning } from '../common/warnings/magnitude';
import { WarningGate } from '../common/warnings/warning-gate.service';
import { Warning, WarningResponse } from '../common/warnings/warning.types';

/** Every value the filters accept, kept next to the enums they mirror. */
const PAY_STATUSES = ['paid', 'partial', 'credit'] as const satisfies readonly SalePayStatus[];
const PAYMENT_METHODS = ['cash', 'card', 'mobile', 'bank', 'other'] as const satisfies readonly PaymentMethod[];

interface PreparedLine {
  unitId?: Buffer;
  productId: Buffer;
  quantity: number;
  price: number;
  discount: number;
  cost: number;
  /**
   * What the price ladder says this sells for — the FLOOR (A2).
   *
   * Null when the ladder reached `unpriced`: the shop has never said what this
   * costs, so there is no floor to be below and nothing to approve.
   */
  configuredPrice: number | null;
}

/**
 * Thrown to abandon the sale's transaction when the server has something to say
 * and the person has not yet answered it.
 *
 * A warned sale must write **nothing** — not the sale, not the invoice number,
 * not the unit's new status. The cheapest way to guarantee that is to let the
 * transaction roll back, which means leaving it by throwing. It is caught two
 * lines later and turned into an ordinary 200 carrying the warnings, so the
 * throw never reaches a client as an error.
 */
class WarningsPending extends Error {
  constructor(readonly response: WarningResponse) {
    super('warnings_pending');
  }
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
    private readonly approvals: DiscountApprovalsService,
    private readonly magnitude: MagnitudeService,
    private readonly gate: WarningGate,
    private readonly businessDay: BusinessDayService,
    private readonly closing: ClosingService,
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
      if (existing) {
        /**
         * A replay answers with the sale it already made — but only a REPLAY.
         * The same key carrying different lines, quantities, prices or payments
         * is not a retry; it is a second sale wearing the first one's identity,
         * and answering it with the first sale would tell the counter that the
         * new details were recorded when they were not. It is refused, and the
         * client refreshes and starts again with a fresh key.
         */
        await this.assertReplayMatches(existing, dto);
        return this.toResponse(existing);
      }
    }

    // Each line is a serialized unit (identifier) XOR a quantity product (productId+quantity).
    for (const l of dto.lines) {
      if (Boolean(l.identifier) === Boolean(l.productId)) {
        throw new BadRequestException('Each line must be either an identifier (serialized unit) or a productId (quantity product)');
      }
    }

    let result: {
      saleId: Buffer;
      invoiceNo: string;
      total: number;
      margin: number;
      balanceDue: number;
      payStatus: Sale['payStatus'];
      soldAt: Date;
      businessDate: string;
      reopen: AutoReopenResult;
      returnWindowHours: number;
      returnDeadlineAt: Date | null;
    };
    try {
      result = await this.db.$transaction(async (tx) => {
        const prepared: PreparedLine[] = [];

        for (const l of dto.lines) {
          const discount = l.discount ?? 0;
          if (l.identifier) {
            const unit = await tx.unit.findFirst({
              // Either IMEI sells the phone. Without the secondary column a
              // dual-SIM handset scanned by its second number could not be sold.
              where: {
                OR: [
                  { imeiPrimary: l.identifier },
                  { imeiSecondary: l.identifier },
                  { serialNo: l.identifier },
                ],
              },
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
            prepared.push({
              unitId: unit.id,
              productId: unit.productId,
              quantity: 1,
              price,
              discount,
              cost: Number(unit.cost),
              // The ladder's answer — the FLOOR this line is measured against.
              configuredPrice: resolved.price,
            });
          } else {
            const productId = uuidToBin(l.productId as string);
            const quantity = l.quantity ?? 1;
            const stock = await tx.stockItem.findUnique({
              where: { companyId_productId_branchId: { companyId, productId, branchId } },
              include: { product: { select: { defaultPrice: true } } },
            });
            /**
             * Only UNRESERVED stock is sellable (H1.1).
             *
             * `quantity` stays the physical total the branch owns; what is
             * promised to an open transfer is held in `reservedQuantity`. Selling
             * against the physical figure would sell the same cable twice --
             * once at the counter and once into a branch expecting it.
             */
            const available = stock ? stock.quantity - stock.reservedQuantity : 0;
            if (!stock || available < quantity) {
              throw new ConflictException(
                `Only ${Math.max(available, 0)} available to sell`,
              );
            }
            // Quantity stock keeps its own branch price; the resolver returns it
            // with an honest `stock_item` source rather than a second source.
            /**
             * A stock row can exist with NO price since `0034` — goods a
             * transfer delivered into a branch that has never priced them.
             * `Number(null)` is `0`, so passing it straight through would have
             * offered the item free; `null` instead lets the resolver fall
             * through to the product default and, failing that, refuse.
             */
            const resolved = await this.pricing.resolveForSaleTx(
              tx,
              {
                kind: 'quantity',
                productId,
                stock: stock.price === null ? null : { price: Number(stock.price), version: stock.version },
                // Passed for real now that the rung above it can be empty. It
                // used to be `null` because a stock row always had a price, so
                // the fallback was unreachable; leaving it null would make an
                // unpriced row refuse a sale the catalogue could have answered.
                productDefault: stock.product?.defaultPrice != null ? Number(stock.product.defaultPrice) : null,
              },
              branchId,
            );
            const price = this.policy.resolvePrice(l.price, resolved.price);
            prepared.push({
              productId,
              quantity,
              price,
              discount,
              cost: Number(stock.cost),
              configuredPrice: resolved.price,
            });
          }
        }

        /*
         * A missing or extra zero, caught BEFORE the first write (A1).
         *
         * This sits here, after every line has been resolved and before
         * anything is created, for one reason: a warned sale must leave no
         * trace. Warning after the row exists would make the warning
         * decorative — the mistake is already recorded and the person is being
         * told about their own history.
         *
         * It is advisory. It never refuses the sale; it asks once, and a
         * confirmation bound to this exact payload lets it through.
         */
        const warnings = await this.magnitudeWarnings(tx, prepared, branchId);
        const verdict = this.gate.check({
          operation: 'sale.create',
          // The token is excluded from what the token is bound to. Including it
          // would change the hash the moment it is sent back, so no
          // acknowledgement could ever verify.
          payload: { ...dto, acknowledgementToken: undefined },
          warnings,
          token: dto.acknowledgementToken,
        });
        if (!verdict.ok && verdict.response) throw new WarningsPending(verdict.response);

        const subtotal = this.policy.round(prepared.reduce((s, p) => s + p.price * p.quantity, 0));
        const discountTotal = this.policy.round(
          prepared.reduce((s, p) => s + p.discount, 0) + (dto.saleDiscount ?? 0),
        );
        const total = this.policy.round(subtotal - discountTotal);
        if (total < 0) throw new BadRequestException('Discount exceeds subtotal');
        const totalCost = this.policy.round(prepared.reduce((s, p) => s + p.cost * p.quantity, 0));
        const margin = this.policy.round(total - totalCost);

        /*
         * The sale's identity is minted before the floor check, because
         * consuming an approval records WHICH sale spent it. Nothing is written
         * yet — this is a uuid, not a row.
         */
        const saleId = newUuidV7Bin();

        /**
         * The floor is checked PER LINE, not on the sale's total margin.
         *
         * An aggregate check lets a healthy line pay for a ruinous one: sell an
         * accessory at a good margin and a phone far below its price, and the
         * total still looks positive. The configured price is a decision about
         * one product, so it has to be enforced about one product.
         */
        for (const [index, line] of prepared.entries()) {
          /*
           * An approval is spent HERE, inside the sale's transaction, by a
           * conditional update. Two concurrent sales racing for one approval
           * both attempt it and MySQL serialises them on the row — exactly one
           * wins. Checking first and writing after would let both through.
           */
          const approval =
            line.unitId && line.configuredPrice !== null && line.price < line.configuredPrice
              ? await this.approvals.consume(tx as unknown as Prisma.TransactionClient, {
                  unitId: line.unitId,
                  requestedPrice: line.price,
                  currentConfiguredPrice: line.configuredPrice,
                  currentPriceVersion: null,
                  currentCost: line.cost,
                  currentBranchId: branchId,
                  saleId,
                })
              : null;
          this.policy.assertPriceAllowed({
            price: line.price,
            configuredPrice: line.configuredPrice,
            cost: line.cost,
            approval,
            reason: dto.overrideReason,
            line: {
              index,
              unitId: line.unitId ? binToUuid(line.unitId) : null,
              identifier: dto.lines[index]?.identifier ?? null,
            },
          });
        }
        const { amountPaid, balanceDue, payStatus } = this.policy.reconcilePayments(dto.payments, total);
        /**
         * Who owes what was not paid (0074): one customer — chosen, or typed at
         * the counter — or one partner store, never both. A sale leaving money
         * owing without a debtor is refused: an unnamed balance is a debt nobody
         * will ever chase.
         */
        const debtorChoice = chooseDebtor({
          customerId: dto.customerId,
          customer: dto.customer,
          counterpartyId: dto.counterpartyId,
        });
        assertDebtorForBalance(balanceDue, debtorChoice);
        const debtor = await this.resolveDebtor(tx as unknown as Prisma.TransactionClient, companyId, debtorChoice);

        const invoiceNo = await this.invoiceNumbers.next(
          tx as unknown as Prisma.TransactionClient,
          branchId,
        );

        /**
         * The return policy this sale is sold under, decided HERE and written
         * once.
         *
         * `soldAt` and the deadline come from the same instant, so the two can
         * never disagree, and both come from the server: a phone's clock
         * deciding how long a customer has to bring something back is a promise
         * made by the wrong machine.
         *
         * The company setting is read inside the transaction, so a sale cannot
         * snapshot a window that was changed a moment earlier and half-applied.
         */
        const soldAt = new Date();
        /**
         * The business date this sale belongs to (0076), assigned here and
         * stored beside the instant: the branch's 06:00 rule, or the next date
         * when the Owner started it early. Read inside the transaction, so the
         * election and the sale cannot straddle each other.
         */
        const businessDate = await this.businessDay.assign(branchId, soldAt, tx as unknown as Prisma.TransactionClient);
        const settings = await tx.companySettings.findUnique({
          where: { companyId },
          select: { returnWindowHours: true },
        });
        const resolvedPolicy = resolveWindowForSale({
          // A company with no settings row has never chosen a policy, and
          // "no returns" is the schema default rather than an invented promise.
          companyDefaultHours: settings?.returnWindowHours ?? NO_RETURNS,
          requested:
            dto.returnWindowHours === undefined
              ? undefined
              : { windowHours: dto.returnWindowHours, reason: dto.returnPolicyReason },
          canOverride: this.cls.get('permissions')?.has('return.policy.override') ?? false,
        });
        const policySnapshot = snapshotPolicy(soldAt, resolvedPolicy.windowHours);

        await tx.sale.create({
          data: {
            id: saleId,
            companyId,
            branchId,
            userId,
            customerId: debtor.customerId,
            counterpartyId: debtor.counterpartyId,
            invoiceNo,
            soldAt,
            businessDate: dateValue(businessDate),
            subtotal,
            discount: discountTotal,
            taxTotal: 0,
            total,
            totalCost,
            margin,
            amountPaid,
            balanceDue,
            payStatus,
            returnWindowHours: policySnapshot.windowHours,
            returnDeadlineAt: policySnapshot.deadlineAt,
            // Recorded only for a real change, so the column answers "who
            // decided this sale was different?" rather than naming whoever
            // happened to serve an ordinary customer.
            returnPolicyOverriddenById: resolvedPolicy.overridden ? userId : null,
            returnPolicyOverrideReason: resolvedPolicy.overrideReason,
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
            /**
             * CLAIM the unit; do not simply overwrite its status.
             *
             * This was a blind update, and a live race proved the cost: a
             * transfer request reserved the phone between `assertSellable`
             * reading it and this write, and the sale then stamped it `sold`
             * anyway. Both operations reported success and the shop had a phone
             * that was simultaneously sold and promised to another branch.
             *
             * The predicate makes the database arbitrate. Whoever gets the row
             * lock first wins; the loser matches nothing and is told plainly.
             */
            const claimed = await tx.unit.updateMany({
              where: { id: p.unitId, status: 'in_stock' },
              data: { status: 'sold', dateSold: new Date() },
            });
            if (claimed.count === 0) {
              throw new ConflictException(
                'That item was taken while you were selling — it is no longer available',
              );
            }
            await this.audit.recordTx(tx, {
              entityType: 'Unit',
              entityId: p.unitId,
              action: 'status_change',
              before: { status: 'in_stock' },
              after: { status: 'sold' },
              branchId,
            });
          } else {
            /**
             * Conditional decrement, not a blind one. Between the availability
             * check above and this write another sale could have taken the same
             * units, or a transfer request could have reserved them. The
             * predicate makes the database arbitrate: if physical stock would
             * drop below what is reserved, this matches no row and the sale
             * fails instead of overselling.
             *
             * The CHECK constraint from 0030 is the last line of defence; this
             * turns the violation into a clear refusal rather than a 500.
             */
            const taken = await tx.stockItem.updateMany({
              where: {
                companyId,
                productId: p.productId,
                branchId,
                quantity: { gte: p.quantity },
              },
              data: { quantity: { decrement: p.quantity } },
            });
            if (taken.count === 0) {
              throw new ConflictException('That stock was taken while you were selling');
            }
            const after = await tx.stockItem.findUnique({
              where: { companyId_productId_branchId: { companyId, productId: p.productId, branchId } },
              select: { quantity: true, reservedQuantity: true },
            });
            if (after && after.quantity < after.reservedQuantity) {
              throw new ConflictException('That stock is reserved for a transfer');
            }
          }
        }

        for (const pay of dto.payments) {
          /**
           * Attribute the money to the account it landed in (E-CP1), so that
           * account has an expected balance somebody can reconcile against.
           *
           * Cash is forced to no account — the drawer belongs to no account,
           * and `ck_payments_cash_no_account` refuses the alternative anyway.
           * A non-cash payment naming no account stays NULL and is reported as
           * unattributed; guessing would fabricate a financial record.
           *
           * The label is frozen here, because renaming the account later must
           * not retitle money that already came in.
           */
          const accountBin =
            pay.method === 'cash' || !pay.receivingAccountId ? null : uuidToBin(pay.receivingAccountId);

          /**
           * A non-cash payment must name the account it landed in (4a).
           *
           * It used to be optional, and money with no account was recorded as
           * "unattributed" — a real category, but one nothing could reconcile.
           * The till now knows which accounts exist, so the honest answer is
           * always available and the gap no longer has a reason to exist. Cash
           * is the opposite case: the drawer belongs to no account, and
           * `ck_payments_cash_no_account` refuses one.
           */
          if (pay.method !== 'cash' && !accountBin) {
            throw new BadRequestException('Choose the account this money was received into');
          }

          const account = accountBin
            ? await tx.receivingAccount.findFirst({
                where: { id: accountBin },
                select: { label: true, provider: true, providerName: true, isActive: true },
              })
            : null;
          if (accountBin && !account) {
            // The tenant client scopes this lookup, so another company's
            // account is simply not found — it can never be referenced here.
            throw new BadRequestException('That receiving account does not exist');
          }
          /**
           * A deactivated account may not take new money.
           *
           * Deactivation is how a shop closes a channel; accepting a sale into
           * one would create a balance nobody is reconciling, in an account the
           * Owner believes is shut. Past payments keep pointing at it, which is
           * why the row is deactivated rather than deleted.
           */
          if (account && !account.isActive) {
            throw new BadRequestException('That receiving account is no longer active');
          }
          await tx.payment.create({
            data: {
              id: newUuidV7Bin(),
              companyId,
              saleId,
              // Taken with the sale, by the person selling. A later collection
              // is `collection` and goes through recordCollection instead.
              kind: 'at_sale',
              recordedById: userId,
              paidAt: soldAt,
              businessDate: dateValue(businessDate),
              method: pay.method,
              amount: pay.amount,
              receivingAccountId: accountBin,
              accountLabelSnapshot: account?.label ?? null,
              // Frozen beside the label: a rename or a provider change later
              // must not rewrite what this receipt said at the counter.
              accountProviderSnapshot: account
                ? account.provider === 'other'
                  ? (account.providerName ?? 'other')
                  : account.provider
                : null,
            },
          });
        }

        // The customer's running balance is a cache of what their sales still
        // owe. A store's balance is never cached: it is read from the sales.
        if (debtor.customerId && balanceDue > 0) {
          await tx.customer.update({
            where: { id: debtor.customerId },
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
        if (resolvedPolicy.overridden) {
          /**
           * A row of its own, not merged into the below-cost override above:
           * they are different decisions, possibly by different people, and one
           * row could answer "why was this sale different?" in only one of the
           * two senses.
           *
           * `action` stays `override` — the existing enum value means exactly
           * this, someone with authority departing from a default and saying
           * why. Adding an enum member would be a schema change for a label,
           * outside what this phase is authorised to migrate; `field` carries
           * the distinction instead, explicitly rather than left to be inferred
           * from the shape of the payload.
           */
          await this.audit.recordTx(tx, {
            entityType: 'Sale',
            entityId: saleId,
            action: 'override',
            reason: resolvedPolicy.overrideReason ?? undefined,
            before: { field: 'returnPolicy', returnWindowHours: settings?.returnWindowHours ?? NO_RETURNS },
            after: {
              field: 'returnPolicy',
              returnWindowHours: policySnapshot.windowHours,
              returnDeadlineAt: policySnapshot.deadlineAt,
            },
            branchId,
          });
        }

        /**
         * A sale after a counted close reopens the day, inside this very
         * transaction (0076). A close is a counted snapshot and a history
         * event; it never refuses a sale. The Owner is told after commit.
         */
        const reopen = await this.closing.autoReopenTx(tx, {
          branchId,
          businessDate,
          cause: { kind: 'sale', id: saleId },
        });

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

        /**
         * The day's figures and the branch's stock snapshots must be recomputed —
         * requested here, so the request commits with the sale or not at all
         * (0081, docs/52). The event after commit only works it sooner.
         */
        await requestRollupTx(tx as never, [
          { kind: 'daily', companyId, branchId, day: businessDate, cause: 'sale', sourceId: saleId },
          { kind: 'branch', companyId, branchId, cause: 'sale', sourceId: saleId },
        ]);

        return {
          saleId,
          invoiceNo,
          total,
          margin,
          balanceDue,
          payStatus,
          soldAt,
          businessDate,
          reopen,
          returnWindowHours: policySnapshot.windowHours,
          returnDeadlineAt: policySnapshot.deadlineAt,
        };
      });
    } catch (e) {
      /*
       * Not an error. The transaction was abandoned on purpose so that a sale
       * nobody has confirmed leaves nothing behind, and the caller gets the
       * warnings with a token to come back with.
       */
      if (e instanceof WarningsPending) return e.response;
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('A unit in this sale was just sold — please refresh and retry');
      }
      throw e;
    }

    // After commit: work the requests written above now (they survive a stop), and the closing's side effects.
    this.events.emit('sale.recorded', {
      saleId: result.saleId,
      companyId,
      branchId,
      day: result.businessDate,
      total: result.total,
      margin: result.margin,
    });
    // After commit, never inside it: a notice that fails must not undo a sale.
    void this.closing.afterSaleCommitted(result.saleId, result.reopen);

    return {
      id: binToUuid(result.saleId),
      invoiceNo: result.invoiceNo,
      total: result.total,
      margin: result.margin,
      balanceDue: result.balanceDue,
      payStatus: result.payStatus,
      // The receipt used to timestamp itself with the phone's clock. The sale
      // time and the deadline measured from it must come from the same machine,
      // and it is not the one in the customer's hand.
      soldAt: result.soldAt,
      businessDate: result.businessDate,
      // A receipt that does not state the return policy is how a shop ends up
      // arguing about one.
      returnPolicy: {
        windowHours: result.returnWindowHours,
        deadlineAt: result.returnDeadlineAt,
      },
    };
  }

  /**
   * `returnUnit` was removed in I1.
   *
   * It voided the sale line, rewrote the original sale's totals, restocked a
   * defective phone by default and accepted any refund amount the caller sent.
   * The replacement is the reviewed ReturnRequest lifecycle (I2); until then
   * the route answers 410 and writes nothing. See `docs/27`.
   */
  /**
   * Sale history for the ACTIVE branch, newest first, searched and paged.
   *
   * ## What this used to be
   *
   * `list()` took no arguments, required no permission, and fell back to `{}`
   * when no branch header was present — so any signed-in user could read every
   * sale in the company, including cost and margin, by sending no header at
   * all. It then returned raw rows with `take: 100`, which quietly amputates the
   * history of any shop past its first few weeks.
   *
   * ## Why the branch is not re-checked here
   *
   * `sale.view` is absent from `COMPANY_PERMISSIONS`, so it is branch-scoped:
   * `getEffectivePermissions` throws `No access to the requested branch` when
   * the caller is not assigned to the branch in the header, and returns only
   * company-wide keys when there is no header — which cannot contain
   * `sale.view`. Both cases are a 403 before this method runs. Repeating the
   * assignment lookup here would add a query per request and a second place to
   * drift; `assertAssignedToBranch` exists for reads that require NO permission,
   * which is not this one. `requireBranchId()` below is the assertion that the
   * guard's guarantee actually held.
   */
  /**
   * Turn the chosen debtor into the ids the sale stores (0074).
   *
   * - An existing customer must be one of THIS company's. The tenant client
   *   scopes the lookup, so another shop's customer is simply not found.
   * - A new customer is created here, inside the sale's transaction, so a
   *   refused sale leaves no orphan customer behind. Selecting an existing
   *   customer never reaches this branch, so it can never duplicate one.
   * - A store must be a store (never a person or an employee), active, and —
   *   the approved Partners rule — one this shop may start NEW business with:
   *   a connection the other store has accepted. A manual store stays readable
   *   and settleable but cannot be given new credit. The connection row is held
   *   `FOR UPDATE`, so a removal racing this sale either wins or waits.
   *
   * No stock, purchase or record of any kind is written into the other store's
   * company. This is OUR sale with a balance owed by them — not the bilateral
   * inter-store sale, which remains undecided (docs/21).
   */
  private async resolveDebtor(
    tx: Prisma.TransactionClient,
    companyId: Buffer,
    choice: DebtorChoice,
  ): Promise<{ customerId: Buffer | null; counterpartyId: Buffer | null }> {
    switch (choice.kind) {
      case 'none':
        return { customerId: null, counterpartyId: null };

      case 'customer_existing': {
        const found = await tx.customer.findFirst({
          where: { id: uuidToBin(choice.customerId), deletedAt: null },
          select: { id: true },
        });
        if (!found) throw new BadRequestException({ code: 'customer_not_found', message: 'That customer does not exist' });
        return { customerId: found.id, counterpartyId: null };
      }

      case 'customer_new': {
        const id = newUuidV7Bin();
        await tx.customer.create({ data: { id, companyId, name: choice.name, phone: choice.phone } });
        return { customerId: id, counterpartyId: null };
      }

      case 'store': {
        const id = uuidToBin(choice.counterpartyId);
        const store = await tx.counterparty.findFirst({
          where: { id, isActive: true, kind: { in: [...STORE_KINDS] } },
          select: { id: true },
        });
        if (!store) {
          throw new BadRequestException({ code: 'store_not_found', message: 'That partner store is not available' });
        }
        await assertMayStartDealing(tx, id);
        return { customerId: null, counterpartyId: id };
      }
    }
  }

  /**
   * Every balance still owed at this branch, grouped by who owes it (0074).
   *
   * Read straight from the sales — `balance_due` is the receivable, and there
   * is no second ledger to disagree with it. A customer and a store are listed
   * side by side because "who owes us money" is one question.
   */
  async outstanding() {
    const branchId = this.tenant.requireBranchId();
    const sales = await this.db.sale.findMany({
      where: { branchId, isReversed: false, balanceDue: { gt: 0 } },
      select: {
        id: true,
        invoiceNo: true,
        soldAt: true,
        total: true,
        amountPaid: true,
        balanceDue: true,
        payStatus: true,
        customer: { select: { id: true, name: true, phone: true } },
        counterparty: { select: { id: true, name: true, phone: true } },
        items: {
          where: { voided: false },
          take: 1,
          select: {
            unit: { select: { product: { select: { brand: true, model: true, variant: true } } } },
            product: { select: { brand: true, model: true, variant: true } },
          },
        },
      },
      orderBy: { soldAt: 'asc' },
      // A branch with more open balances than this has a conversation to have
      // that no list will settle; the total below still counts them all.
      take: 500,
    });

    type Group = {
      kind: 'customer' | 'store' | 'unknown';
      id: string | null;
      name: string | null;
      phone: string | null;
      owed: number;
      oldest: Date;
      sales: {
        id: string;
        invoiceNo: string;
        soldAt: Date;
        product: string | null;
        total: number;
        received: number;
        remaining: number;
        payStatus: string;
      }[];
    };
    const groups = new Map<string, Group>();
    for (const s of sales) {
      const debtor = s.customer
        ? { kind: 'customer' as const, id: binToUuid(s.customer.id), name: s.customer.name, phone: s.customer.phone }
        : s.counterparty
          ? { kind: 'store' as const, id: binToUuid(s.counterparty.id), name: s.counterparty.name, phone: s.counterparty.phone }
          : // Only possible for a balance recorded before 0074 with no debtor.
            // Listed honestly rather than hidden.
            { kind: 'unknown' as const, id: null, name: null, phone: null };
      const key = `${debtor.kind}:${debtor.id ?? ''}`;
      const group = groups.get(key) ?? { ...debtor, owed: 0, oldest: s.soldAt, sales: [] };
      group.owed = Math.round((group.owed + Number(s.balanceDue)) * 100) / 100;
      if (s.soldAt < group.oldest) group.oldest = s.soldAt;
      const item = s.items[0];
      group.sales.push({
        id: binToUuid(s.id),
        invoiceNo: s.invoiceNo,
        soldAt: s.soldAt,
        product: item ? describeProduct(item.unit?.product ?? item.product) : null,
        total: Number(s.total),
        received: Number(s.amountPaid),
        remaining: Number(s.balanceDue),
        payStatus: s.payStatus,
      });
      groups.set(key, group);
    }

    const debtors = [...groups.values()].sort((a, b) => b.owed - a.owed);
    return {
      total: Math.round(debtors.reduce((n, d) => n + d.owed, 0) * 100) / 100,
      sales: sales.length,
      debtors,
    };
  }

  /**
   * One line per day: the sales made, their full value, the phones among them,
   * and what is still owed on them now (0074).
   *
   * The day is the SALE's day. What was collected on a day is a different fact,
   * dated by when money arrived, and lives on the Money overview.
   */
  async byDay(from: string, to: string) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const range = parseDateRange(from, to);
    if (!range || !from || !to) throw new BadRequestException('from and to must be YYYY-MM-DD');

    const rows = await this.db.$queryRaw<
      { day: string; sales: bigint; value: unknown; owed: unknown; phones: unknown }[]
    >(Prisma.sql`
      SELECT DATE_FORMAT(s.business_date, '%Y-%m-%d') AS day,
             COUNT(*)                            AS sales,
             SUM(s.total)                        AS value,
             SUM(s.balance_due)                  AS owed,
             SUM((SELECT COUNT(*) FROM sale_items si
                    JOIN units u ON u.id = si.unit_id
                    JOIN products p ON p.id = u.product_id
                   WHERE si.sale_id = s.id AND si.voided = 0 AND p.tracking_type = 'imei')) AS phones
      FROM sales s
      WHERE s.company_id = ${companyId} AND s.branch_id = ${branchId}
        AND s.is_reversed = 0
        AND s.business_date BETWEEN ${from} AND ${to}
      GROUP BY day
      ORDER BY day DESC`);

    return {
      from,
      to,
      days: rows.map((r) => ({
        day: r.day,
        sales: Number(r.sales),
        phones: Number(r.phones ?? 0),
        value: Math.round(Number(r.value ?? 0) * 100) / 100,
        outstanding: Math.round(Number(r.owed ?? 0) * 100) / 100,
      })),
    };
  }

  async list(query: ListSalesDto) {
    const branchId = this.tenant.requireBranchId();
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);

    const payStatuses = parseEnumList<SalePayStatus>(query.payStatus, PAY_STATUSES, 'payment status');
    const methods = parseEnumList<PaymentMethod>(query.paymentMethod, PAYMENT_METHODS, 'payment method');
    const soldAt = parseDateRange(query.from, query.to);

    const rows = await this.db.sale.findMany({
      where: {
        branchId,
        ...(payStatuses.length > 0 ? { payStatus: { in: payStatuses } } : {}),
        ...(methods.length > 0 ? { payments: { some: { method: { in: methods } } } } : {}),
        // Two bare dates mean business dates (0076); an instant range still
        // filters on the moment of sale.
        ...(query.from && query.to && isDateString(query.from) && isDateString(query.to)
          ? { businessDate: { gte: dateValue(query.from), lte: dateValue(query.to) } }
          : soldAt
            ? { soldAt }
            : {}),
        ...this.searchWhere(query.search),
      },
      include: {
        user: { select: { name: true } },
        customer: { select: { name: true } },
        counterparty: { select: { name: true } },
        payments: { select: { method: true, accountLabelSnapshot: true } },
        corrections: { where: { status: { in: ['requested', 'approved'] } }, select: { status: true } },
        items: {
          select: {
            unitId: true,
            quantity: true,
            voided: true,
            releasedByCorrectionId: true,
            // What was sold, as a row can say it without a second request.
            unit: { select: { product: { select: { brand: true, model: true, variant: true, trackingType: true } } } },
            product: { select: { brand: true, model: true, variant: true, trackingType: true } },
          },
        },
        returns: { select: { id: true } },
      },
      /**
       * The PK is a UUIDv7: unique, immutable and time-ordered, so `id desc` is
       * both "newest first" and a total order. Keyset paging on it cannot skip
       * or repeat a row when somebody completes a sale mid-scroll, which
       * skip/take would. Verified against the live data: ordering the seven
       * existing sales by id reproduces their `sold_at` order exactly.
       */
      ...(query.cursor ? { cursor: { id: uuidToBin(query.cursor) }, skip: 1 } : {}),
      orderBy: { id: 'desc' },
      take: limit + 1,
    });

    const page = rows.slice(0, limit);
    const now = new Date();
    return {
      rows: page.map((s) => {
        const live = s.items.filter((i) => !i.voided && !i.releasedByCorrectionId);
        const cancelled = s.corrections.some((c) => c.status === 'approved');
        return {
          id: binToUuid(s.id),
          invoiceNo: s.invoiceNo,
          soldAt: s.soldAt,
          total: Number(s.total),
          totalCost: Number(s.totalCost),
          margin: Number(s.margin),
          amountPaid: Number(s.amountPaid),
          balanceDue: Number(s.balanceDue),
          payStatus: s.payStatus,
          isReversed: s.isReversed,
          /** Cancelled by an approved correction (0079): shown as Cancelled, never by its pay status. */
          cancelled,
          cancellationRequested: !cancelled && s.corrections.some((c) => c.status === 'requested'),
          // Rows and things are different numbers: "10 chargers" is one line
          // and ten items, and a list that says "1 item" misleads whoever is
          // trying to match it against what left the shop.
          lineCount: (cancelled ? s.items.filter((i) => !i.voided) : live).length,
          itemCount: (cancelled ? s.items.filter((i) => !i.voided) : live).reduce((n, i) => n + i.quantity, 0),
          serializedCount: (cancelled ? s.items.filter((i) => !i.voided) : live).filter((i) => i.unitId !== null).length,
          soldBy: s.user?.name ?? null,
          customer: s.customer?.name ?? null,
          /** Who owes the balance, whichever kind (0074). Null when nothing is owed to anyone named. */
          debtor: s.customer
            ? { kind: 'customer' as const, name: s.customer.name }
            : s.counterparty
              ? { kind: 'store' as const, name: s.counterparty.name }
              : null,
          /** The first item, which is the whole sale in the common one-phone case. */
          product: s.items.find((i) => !i.voided) ? describeProduct(s.items.find((i) => !i.voided)!.unit?.product ?? s.items.find((i) => !i.voided)!.product) : null,
          // De-duplicated: a split payment of cash+cash is one method twice.
          paymentMethods: [...new Set(s.payments.map((p) => p.method))],
          /** The accounts money landed in, by the label frozen at the time. */
          accountLabels: [...new Set(s.payments.map((p) => p.accountLabelSnapshot).filter((l): l is string => !!l))],
          returnPolicy: this.policySummary(s, live, now),
        };
      }),
      nextCursor: rows.length > limit ? binToUuid(page[page.length - 1]!.id) : null,
    };
  }

  /**
   * Search in SQL, across what someone actually remembers when they are holding
   * a receipt or a phone: the number on the paperwork, the number printed on
   * the device, what it was, or who sold it.
   *
   * MySQL's default collation is case-insensitive, so `contains` needs no
   * lowering — and lowering would defeat the index anyway.
   */
  private searchWhere(search?: string): Prisma.SaleWhereInput {
    const q = search?.trim();
    if (!q) return {};
    return {
      OR: [
        { invoiceNo: { contains: q } },
        { user: { name: { contains: q } } },
        { customer: { name: { contains: q } } },
        { customer: { phone: { contains: q } } },
        { items: { some: { unit: { imeiPrimary: { contains: q } } } } },
        { items: { some: { unit: { imeiSecondary: { contains: q } } } } },
        { items: { some: { unit: { serialNo: { contains: q } } } } },
        { items: { some: { unit: { product: { brand: { contains: q } } } } } },
        { items: { some: { unit: { product: { model: { contains: q } } } } } },
        { items: { some: { unit: { product: { variant: { contains: q } } } } } },
        // Quantity lines name their product directly, with no unit in between.
        { items: { some: { product: { brand: { contains: q } } } } },
        { items: { some: { product: { model: { contains: q } } } } },
        { items: { some: { product: { variant: { contains: q } } } } },
        { items: { some: { product: { barcode: { contains: q } } } } },
      ],
    };
  }

  /**
   * The policy this sale was sold under, plus what the SERVER says about it now.
   *
   * The client is told the answer rather than asked for it: a phone's clock can
   * be wrong, and "can this still be returned?" is not a question a device
   * should get to answer about a promise the shop made.
   */
  private policySummary(
    sale: { returnWindowHours: number; returnDeadlineAt: Date | null; isReversed: boolean },
    liveItems: { unitId: Buffer | null }[],
    now: Date,
    hasReturn = false,
  ) {
    const eligibility = evaluateEligibility({
      windowHours: sale.returnWindowHours,
      deadlineAt: sale.returnDeadlineAt,
      now,
      isReversed: sale.isReversed,
      hasReturn,
      // Accessory-only sales have no serialized unit to take back and no
      // reviewed path yet; saying which beats a vague refusal (I2).
      quantityOnly: liveItems.length > 0 && liveItems.every((i) => i.unitId === null),
    });
    return {
      windowHours: sale.returnWindowHours,
      deadlineAt: eligibility.deadlineAt,
      eligible: eligibility.eligibleByPolicy,
      reason: eligibility.reason,
      remainingMs: eligibility.remainingMs,
      requiresOwnerException: eligibility.requiresOwnerException,
    };
  }

  /**
   * One sale in full.
   *
   * Fails closed three ways, and all three answer identically. The tenant
   * extension injects `companyId` into the unique lookup, so another company's
   * sale is simply not found; a sale belonging to a different branch of the same
   * company is refused here; and an id nobody has ever used is not found either.
   * A caller must not be able to tell which of the three happened — "no such
   * sale" and "not yours" leak different facts, and the difference is enough to
   * confirm that an invoice number exists elsewhere in the company.
   *
   * Cost and margin are named exactly as `FINANCIAL_FIELDS` expects, so the
   * global cost-gating interceptor strips them for a caller without
   * `cost.view` — the gating is not re-implemented here, deliberately.
   */
  async getById(idStr: string) {
    const branchId = this.tenant.requireBranchId();
    /**
     * A malformed id is a FOURTH way in, and it must answer like the other
     * three. `uuidToBin` throws a plain Error on anything that is not a UUID,
     * which Nest turns into a 500 — found by live verification, not by the
     * suite. That is worse than untidy: a 500 tells a caller "that id was
     * structurally invalid" while a real-but-not-yours id says 404, and the
     * difference is exactly the signal the identical-404 rule below exists to
     * withhold. Same guard as `devices.service`.
     */
    if (!isUuid(idStr)) throw new NotFoundException('Sale not found');
    const sale = await this.db.sale.findUnique({
      where: { id: uuidToBin(idStr) },
      include: {
        user: { select: { name: true } },
        customer: { select: { id: true, name: true, phone: true } },
        counterparty: { select: { id: true, name: true, phone: true, kind: true } },
        branch: { select: { id: true, name: true } },
        payments: { orderBy: { paidAt: 'asc' }, select: paymentSelect },
        returns: { select: { id: true } },
        returnPolicyOverriddenBy: { select: { name: true } },
        corrections: {
          where: { status: { in: ['requested', 'approved'] } },
          orderBy: { requestedAt: 'desc' },
          select: {
            status: true,
            reason: true,
            requestedAt: true,
            decidedAt: true,
            correctionDate: true,
            requestedBy: { select: { name: true } },
            decidedBy: { select: { name: true } },
            legs: { select: { method: true, accountLabelSnapshot: true, amount: true } },
          },
        },
        items: {
          include: {
            unit: {
              select: {
                id: true,
                imeiPrimary: true,
                imeiSecondary: true,
                serialNo: true,
                product: { select: { brand: true, model: true, variant: true, trackingType: true } },
              },
            },
            product: { select: { brand: true, model: true, variant: true, barcode: true, trackingType: true } },
          },
        },
      },
    });
    if (!sale || !sale.branchId.equals(branchId)) throw new NotFoundException('Sale not found');

    // A cancelled sale's lines are released: nothing on it can be returned (0079).
    const live = sale.items.filter((i) => !i.voided && !i.releasedByCorrectionId);
    const approvedCancel = sale.corrections.find((c) => c.status === 'approved') ?? null;
    const requestedCancel = sale.corrections.find((c) => c.status === 'requested') ?? null;
    return {
      id: binToUuid(sale.id),
      invoiceNo: sale.invoiceNo,
      soldAt: sale.soldAt,
      /**
       * An approved cancellation (0079): who asked, who approved, when, why, the day
       * it posted to and the money it gave back. The sale itself is never rewritten.
       */
      cancellation: approvedCancel
        ? {
            status: 'approved' as const,
            reason: approvedCancel.reason,
            requestedBy: approvedCancel.requestedBy?.name ?? null,
            decidedBy: approvedCancel.decidedBy?.name ?? null,
            decidedAt: approvedCancel.decidedAt,
            correctionDate: approvedCancel.correctionDate ? dayKey(approvedCancel.correctionDate) : null,
            moneyBack: approvedCancel.legs.map((l) => ({ method: l.method, accountLabel: l.accountLabelSnapshot, amount: Number(l.amount) })),
          }
        : requestedCancel
          ? { status: 'requested' as const, reason: requestedCancel.reason, requestedBy: requestedCancel.requestedBy?.name ?? null, requestedAt: requestedCancel.requestedAt }
          : null,
      branch: { id: binToUuid(sale.branch.id), name: sale.branch.name },
      soldBy: sale.user?.name ?? null,
      customer: sale.customer
        ? { id: binToUuid(sale.customer.id), name: sale.customer.name, phone: sale.customer.phone }
        : null,
      /**
       * Who owes the balance, as ONE field whichever kind it is (0074). A
       * screen answering "who do I chase?" should not have to know there are
       * two tables behind the answer.
       */
      debtor: sale.customer
        ? { kind: 'customer' as const, id: binToUuid(sale.customer.id), name: sale.customer.name, phone: sale.customer.phone }
        : sale.counterparty
          ? { kind: 'store' as const, id: binToUuid(sale.counterparty.id), name: sale.counterparty.name, phone: sale.counterparty.phone }
          : null,
      subtotal: Number(sale.subtotal),
      discount: Number(sale.discount),
      taxTotal: Number(sale.taxTotal),
      total: Number(sale.total),
      totalCost: Number(sale.totalCost),
      margin: Number(sale.margin),
      amountPaid: Number(sale.amountPaid),
      balanceDue: Number(sale.balanceDue),
      payStatus: sale.payStatus,
      dueDate: sale.dueDate,
      isReversed: sale.isReversed,
      lines: sale.items.map((i) => ({
        id: binToUuid(i.id),
        // A serialized line names the unit and the number printed on it; a
        // quantity line names the product and how many left the shelf.
        unitId: i.unitId ? binToUuid(i.unitId) : null,
        imei: i.unit?.imeiPrimary ?? null,
        imeiSecondary: i.unit?.imeiSecondary ?? null,
        serialNo: i.unit?.serialNo ?? null,
        product: describeProduct(i.unit?.product ?? i.product),
        barcode: i.product?.barcode ?? null,
        trackingType: i.unit?.product?.trackingType ?? i.product?.trackingType ?? null,
        quantity: i.quantity,
        price: Number(i.price),
        discount: Number(i.discount),
        taxAmount: Number(i.taxAmount),
        cost: Number(i.cost),
        voided: i.voided,
      })),
      // Every payment, at the sale and after it, with the account label as it
      // stood when the money arrived and the person who recorded it.
      payments: sale.payments.map(toPaymentView),
      returnPolicy: {
        ...this.policySummary(sale, live, new Date(), sale.returns.length > 0),
        // Recorded only when a manager or owner actually changed it, so the
        // question "why was this sale different?" has an answer on the screen
        // rather than in an audit table nobody opens.
        overriddenBy: sale.returnPolicyOverriddenBy?.name ?? null,
        overrideReason: sale.returnPolicyOverrideReason,
      },
    };
  }

  /**
   * The idempotent replay of an offline retry. It must answer with the SAME
   * policy the original sale carried — re-deriving it from today's setting
   * would let a retry print a different promise from the one already given to
   * the customer.
   */
  /**
   * What the server thinks looks wrong about the prices on this sale (A1).
   *
   * The reference is the **configured selling price** where the shop has set
   * one — the same ladder the sale itself priced from, never a second answer to
   * "what does this sell for?". Where it has not, the fallback is what this
   * product has actually been selling for at this branch over ninety days, and
   * below five sales that is not a median and nothing is said.
   *
   * Silence is the common case and the correct one. A new product has no
   * history, and inventing a reference for it would fire on every genuinely new
   * item until people learned to tap through the dialog.
   */
  private async magnitudeWarnings(
    tx: MagnitudeReads,
    prepared: readonly PreparedLine[],
    branchId: Buffer,
  ): Promise<Warning[]> {
    const out: Warning[] = [];
    for (const [index, line] of prepared.entries()) {
      const reference =
        this.magnitude.configuredPrice(line.configuredPrice) ??
        (await this.magnitude.medianSalePrice(tx, line.productId, branchId));
      const warning = magnitudeWarning({
        code: 'magnitude.sale_price',
        field: `lines.${index}.price`,
        submitted: line.price,
        reference,
        minSample: SALE_PRICE_MIN_SAMPLE,
      });
      if (warning) out.push(warning);
    }
    return out;
  }

  /**
   * The sale a client key already made, if any — how a phone finds out what
   * happened to a submission whose answer was lost.
   *
   * A timeout is the one outcome where the client genuinely does not know: the
   * request may have been processed and only the response dropped. Before it
   * offers another submission it asks here, with its own key, and gets either
   * the sale (so it can finish as a success) or a 404 (so it can retry with the
   * SAME key). Company-scoped by the tenant client; the key is the client's own
   * random uuid, so nothing enumerable is exposed.
   */
  async findByClientUuid(clientUuid: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientUuid)) {
      throw new BadRequestException({ code: 'client_uuid_invalid', message: 'That is not a client key' });
    }
    const existing = await this.db.sale.findFirst({
      where: { companyId: this.tenant.companyId(), clientUuid: uuidToBin(clientUuid) },
    });
    if (!existing) throw new NotFoundException({ code: 'not_found', message: 'No sale was recorded for that key' });
    return this.toResponse(existing);
  }

  /**
   * Is this payload the one the existing sale was made from?
   *
   * Compared on what the sale actually is: each line's unit (resolved from its
   * identifier the same way the sale resolved it) or product-and-quantity, the
   * price when the client stated one, the money taken at the counter, and the
   * discount. Anything else in the body — a note, a return window — does not
   * change what was sold, so it does not make a replay a different sale.
   */
  private async assertReplayMatches(existing: Sale, dto: CreateSaleDto): Promise<void> {
    const [items, payments] = await Promise.all([
      this.db.saleItem.findMany({
        where: { saleId: existing.id },
        select: { unitId: true, productId: true, quantity: true, price: true },
      }),
      this.db.payment.findMany({ where: { saleId: existing.id, kind: 'at_sale' }, select: { method: true, amount: true } }),
    ]);

    const stored = items
      .map((i) =>
        i.unitId
          ? `u:${i.unitId.toString('hex')}@${Number(i.price)}`
          : `p:${i.productId!.toString('hex')}x${i.quantity}@${Number(i.price)}`,
      )
      .sort();

    const requested: string[] = [];
    for (const l of dto.lines) {
      if (l.identifier) {
        const unit = await this.db.unit.findFirst({
          where: {
            OR: [{ imeiPrimary: l.identifier }, { imeiSecondary: l.identifier }, { serialNo: l.identifier }],
          },
          select: { id: true },
        });
        const hex = unit ? unit.id.toString('hex') : `missing:${l.identifier}`;
        // A stated price must match; an omitted one means "the ladder", which is
        // whatever the sale stored — so only the unit is compared then.
        const match = stored.find((s) => s.startsWith(`u:${hex}@`));
        requested.push(match && l.price === undefined ? match : `u:${hex}@${l.price ?? 'ladder'}`);
      } else {
        const hex = uuidToBin(l.productId as string).toString('hex');
        const qty = l.quantity ?? 1;
        const match = stored.find((s) => s.startsWith(`p:${hex}x${qty}@`));
        requested.push(match && l.price === undefined ? match : `p:${hex}x${qty}@${l.price ?? 'ladder'}`);
      }
    }
    requested.sort();

    const storedPayments = payments.map((p) => `${p.method}:${Number(p.amount)}`).sort();
    const requestedPayments = dto.payments.map((p) => `${p.method}:${p.amount}`).sort();
    const requestedDiscount = this.policy.round(
      dto.lines.reduce((s, l) => s + (l.discount ?? 0), 0) + (dto.saleDiscount ?? 0),
    );

    const same =
      stored.length === requested.length &&
      stored.every((s, i) => s === requested[i]) &&
      storedPayments.length === requestedPayments.length &&
      storedPayments.every((s, i) => s === requestedPayments[i]) &&
      requestedDiscount === Number(existing.discount);

    if (!same) {
      throw new ConflictException({
        code: 'idempotency_conflict',
        message: 'This key already recorded a different sale. Refresh and start the sale again.',
      });
    }
  }

  private toResponse(sale: Sale) {
    return {
      id: binToUuid(sale.id),
      invoiceNo: sale.invoiceNo,
      total: Number(sale.total),
      margin: Number(sale.margin),
      balanceDue: Number(sale.balanceDue),
      payStatus: sale.payStatus,
      soldAt: sale.soldAt,
      returnPolicy: {
        windowHours: sale.returnWindowHours,
        deadlineAt: sale.returnDeadlineAt,
      },
    };
  }
}
