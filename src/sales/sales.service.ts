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
import { binToUuid, isUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { dayKey } from '../common/utils/date.util';
import { canTransition } from '../inventory/unit-state-machine';
import { PricingService } from '../pricing/pricing.service';
import { SalesPolicyService } from './sales-policy.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import { ListSalesDto } from './dto/list-sales.dto';
import { evaluateEligibility, NO_RETURNS, resolveWindowForSale, snapshotPolicy } from './return-policy';
import { describeProduct, parseDateRange, parseEnumList } from './sale-query';

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

    let result: {
      saleId: Buffer;
      invoiceNo: string;
      total: number;
      margin: number;
      balanceDue: number;
      payStatus: Sale['payStatus'];
      soldAt: Date;
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
            prepared.push({ unitId: unit.id, productId: unit.productId, quantity: 1, price, discount, cost: Number(unit.cost) });
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

        const saleId = newUuidV7Bin();
        await tx.sale.create({
          data: {
            id: saleId,
            companyId,
            branchId,
            userId,
            customerId: dto.customerId ? uuidToBin(dto.customerId) : null,
            invoiceNo,
            soldAt,
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
          const account = accountBin
            ? await tx.receivingAccount.findFirst({ where: { id: accountBin }, select: { label: true } })
            : null;
          if (accountBin && !account) {
            throw new BadRequestException('That receiving account does not exist');
          }
          await tx.payment.create({
            data: {
              id: newUuidV7Bin(),
              companyId,
              saleId,
              method: pay.method,
              amount: pay.amount,
              receivingAccountId: accountBin,
              accountLabelSnapshot: account?.label ?? null,
            },
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

        return {
          saleId,
          invoiceNo,
          total,
          margin,
          balanceDue,
          payStatus,
          soldAt,
          returnWindowHours: policySnapshot.windowHours,
          returnDeadlineAt: policySnapshot.deadlineAt,
        };
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
      // The receipt used to timestamp itself with the phone's clock. The sale
      // time and the deadline measured from it must come from the same machine,
      // and it is not the one in the customer's hand.
      soldAt: result.soldAt,
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
        ...(soldAt ? { soldAt } : {}),
        ...this.searchWhere(query.search),
      },
      include: {
        user: { select: { name: true } },
        customer: { select: { name: true } },
        payments: { select: { method: true } },
        items: { select: { unitId: true, quantity: true, voided: true } },
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
        const live = s.items.filter((i) => !i.voided);
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
          // Rows and things are different numbers: "10 chargers" is one line
          // and ten items, and a list that says "1 item" misleads whoever is
          // trying to match it against what left the shop.
          lineCount: live.length,
          itemCount: live.reduce((n, i) => n + i.quantity, 0),
          serializedCount: live.filter((i) => i.unitId !== null).length,
          soldBy: s.user?.name ?? null,
          customer: s.customer?.name ?? null,
          // De-duplicated: a split payment of cash+cash is one method twice.
          paymentMethods: [...new Set(s.payments.map((p) => p.method))],
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
        branch: { select: { id: true, name: true } },
        payments: { orderBy: { paidAt: 'asc' } },
        returns: { select: { id: true } },
        returnPolicyOverriddenBy: { select: { name: true } },
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

    const live = sale.items.filter((i) => !i.voided);
    return {
      id: binToUuid(sale.id),
      invoiceNo: sale.invoiceNo,
      soldAt: sale.soldAt,
      branch: { id: binToUuid(sale.branch.id), name: sale.branch.name },
      soldBy: sale.user?.name ?? null,
      customer: sale.customer
        ? { id: binToUuid(sale.customer.id), name: sale.customer.name, phone: sale.customer.phone }
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
      payments: sale.payments.map((p) => ({
        id: binToUuid(p.id),
        method: p.method,
        amount: Number(p.amount),
        paidAt: p.paidAt,
      })),
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
