import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { CodeType, Prisma, Product } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { InventoryService } from '../inventory/inventory.service';
import { receiveQuantityAtCost } from '../inventory/stock-cost';
import { withLockRetry } from '../common/db/deadlock-retry';
import { TrackingStrategyRegistry } from '../tracking/tracking-strategy.registry';
import { RecognitionService } from '../scanner/recognition.service';
import { RecognitionOutboxService } from '../scanner/recognition-outbox.service';
import { ROLLUP_QUEUE, RollupQueue } from '../analytics/rollup-queue';
import { BusinessDayService, dateValue } from '../common/business-day/business-day.service';
import { ClosingService, type AutoReopenResult } from '../closing/closing.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { CreatePurchaseDto, ReceiveItemDto } from './dto/create-purchase.dto';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Stable fingerprint of what the client asked for.
 *
 * Only the fields that define the DELIVERY are hashed — payment, reference and
 * the item lines. Identifier order is normalised so a client that re-sends the
 * same scans in a different order is still recognised as the same request
 * rather than being rejected as a conflict.
 */
function fingerprint(dto: CreatePurchaseDto): string {
  const canonical = {
    /*
     * How it was paid is part of what was asked for: the same scans replayed
     * with a different method or account are a different purchase, not a
     * retry. `?? null` because `JSON.stringify` drops undefined properties.
     *
     * The first-release contract changed this canonical shape (no supplier, no
     * paid amount), so a request id issued BEFORE the change and replayed after
     * it will read as a conflict rather than a replay. That can only affect a
     * retry left pending across the deploy, and a conflict is the safe answer.
     */
    paymentMethod: dto.paymentMethod,
    receivingAccountId: dto.receivingAccountId?.toLowerCase() ?? null,
    referenceNo: dto.referenceNo ?? null,
    items: (dto.items ?? [])
      .map((i) => {
        const entries = unitEntries(i);
        const secondaries = entries
          .filter((e) => e.imeiSecondary)
          .map((e) => `${e.identifier}|${e.imeiSecondary}`)
          .sort();
        return {
          productId: i.productId,
          unitCost: i.unitCost,
          quantity: i.quantity ?? null,
          price: i.price ?? null,
          identifiers: entries.map((e) => e.identifier).sort(),
          // Only present when a second IMEI was sent, so a request without one
          // hashes exactly as it did before `units[]` existed — a replay of a
          // delivery received earlier still matches its stored fingerprint.
          ...(secondaries.length ? { secondaries } : {}),
        };
      })
      .sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0)),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Every unit on a line, whichever form the client used. */
function unitEntries(item: ReceiveItemDto): { identifier: string; imeiSecondary?: string }[] {
  return [
    ...(item.identifiers ?? []).map((identifier) => ({ identifier })),
    ...(item.units ?? []).map((u) => ({ identifier: u.identifier, imeiSecondary: u.imeiSecondary })),
  ];
}

interface RejectedLine {
  identifier: string;
  reason: string;
  /** The IMEI 2 sent with a refused unit, so the client can keep the pair together. */
  secondary?: string;
}

interface PreparedUnit {
  productId: Buffer;
  identifier: string;
  imeiPrimary: string | null;
  imeiSecondary: string | null;
  serialNo: string | null;
  cost: number;
}

interface PreparedStock {
  productId: Buffer;
  quantity: number;
  cost: number;
  /**
   * Selling price for a branch that has never priced this product. `null` means
   * genuinely unpriced — Sell then asks. It used to fall back to `0`, which
   * reads as "sells for free" rather than "nobody has set a price yet".
   */
  price: number | null;
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
    private readonly outbox: RecognitionOutboxService,
    @Inject(ROLLUP_QUEUE) private readonly rollups: RollupQueue,
    private readonly businessDay: BusinessDayService,
    private readonly closing: ClosingService,
  ) {}

  async createPurchase(dto: CreatePurchaseDto) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const items = dto.items ?? [];
    if (items.length === 0) throw new BadRequestException('Purchase must include at least one item');

    /**
     * Idempotent retry.
     *
     * Receiving is the strongest recognition-learning signal, so a retried
     * request did more than duplicate stock — it also ran teach-on-confirm a
     * second time and inflated `confirmations` for one logical action. Both
     * failures are fixed by making the enclosing purchase idempotent.
     *
     * The fingerprint matters: without it, replaying a key with different
     * contents would silently return the FIRST purchase, quietly discarding
     * the delivery the employee actually scanned.
     */
    const replay = await this.findReplay(dto, companyId);
    if (replay) return replay;

    /**
     * First release: an ordinary purchase is anonymous. Nobody is asked who sold
     * the phone, no supplier is looked up or created, and there is deliberately
     * no "Unknown supplier" row — that would put a fictional counterparty into a
     * payables ledger that no longer exists in the launch app.
     *
     * The payment method is validated BEFORE anything is written, so a refused
     * account never leaves half a purchase behind.
     */
    if (dto.paymentMethod === 'cash' && dto.receivingAccountId) {
      throw new BadRequestException({
        code: 'cash_has_no_account',
        message: 'Cash is paid from the drawer, not from an account',
      });
    }
    if (dto.paymentMethod !== 'cash' && !dto.receivingAccountId) {
      throw new BadRequestException({
        code: 'account_required',
        message: 'Choose the account this purchase was paid from',
      });
    }
    const account = dto.receivingAccountId
      ? await this.db.receivingAccount.findFirst({
          where: { id: uuidToBin(dto.receivingAccountId) },
          select: { id: true, label: true, isActive: true },
        })
      : null;
    // The tenant client scopes the lookup, so another company's account is
    // simply not found.
    if (dto.receivingAccountId && !account) {
      throw new BadRequestException({ code: 'account_not_found', message: 'That payment account does not exist' });
    }
    if (account && !account.isActive) {
      throw new BadRequestException({ code: 'account_inactive', message: 'That payment account is no longer active' });
    }

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
        const entries = unitEntries(item);
        if (entries.length === 0) {
          rejected.push({ identifier: item.productId, reason: `${strategy.identifierLabel} required` });
          continue;
        }
        const imei = this.strategies.get('imei');
        for (const entry of entries) {
          const raw = entry.identifier;
          const check = strategy.validateIdentifier(raw);
          const normalized = strategy.normalize(raw);
          /*
           * IMEI 2 is optional and belongs to the SAME phone. It is checked here
           * with the same rules as IMEI 1 — Luhn, never equal to IMEI 1, never
           * on a product that has no IMEIs — so a bad second number refuses this
           * one unit rather than the delivery, and never reaches the triggers.
           */
          const secondary = entry.imeiSecondary ? imei.normalize(entry.imeiSecondary) : null;
          const refuse = (reason: string) =>
            rejected.push({ identifier: check.ok ? normalized : raw, reason, ...(secondary ? { secondary } : {}) });

          if (!check.ok) refuse(check.reason ?? 'invalid identifier');
          else if (secondary && product.trackingType !== 'imei') refuse('secondary IMEI on a product without IMEIs');
          else if (secondary && !imei.validateIdentifier(secondary).ok) refuse('invalid secondary IMEI');
          else if (secondary && secondary === normalized) refuse('secondary IMEI equals primary');
          // Either number already used in this delivery — as anybody's IMEI 1 or IMEI 2.
          else if (seen.has(normalized) || (secondary && seen.has(secondary))) refuse('duplicate in batch');
          else {
            seen.add(normalized);
            if (secondary) seen.add(secondary);
            preparedUnits.push({
              productId: product.id,
              identifier: normalized,
              ...this.identifierColumns(product, normalized),
              imeiSecondary: secondary,
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
          price: item.price ?? (product.defaultPrice === null ? null : Number(product.defaultPrice)),
        });
      }

      const plan = this.learnPlanFor(product, item);
      if (plan) learnPlans.push(plan);
    }

    // 2. Same-company duplicate pre-check (global unique index is the backstop).
    // Both IMEIs are looked up, across all three identifier columns.
    const existing = await this.inventory.findExistingIdentifiers(
      preparedUnits.flatMap((u) => (u.imeiSecondary ? [u.identifier, u.imeiSecondary] : [u.identifier])),
    );
    const committableUnits = preparedUnits.filter((u) => {
      if (existing.has(u.identifier) || (u.imeiSecondary && existing.has(u.imeiSecondary))) {
        rejected.push({
          identifier: u.identifier,
          reason: 'already registered',
          ...(u.imeiSecondary ? { secondary: u.imeiSecondary } : {}),
        });
        return false;
      }
      return true;
    });

    if (committableUnits.length === 0 && preparedStock.length === 0) {
      return {
        purchaseId: null,
        unitsCreated: 0,
        stockLines: 0,
        total: 0,
        rejected,
        accepted: { identifiers: [] as string[], stockProductIds: [] as string[] },
      };
    }

    // 3. Totals.
    const unitsCost = committableUnits.reduce((s, u) => s + u.cost, 0);
    const stockCost = preparedStock.reduce((s, l) => s + l.cost * l.quantity, 0);
    const total = Number((unitsCost + stockCost).toFixed(2));
    /**
     * Paid in full, by the server.
     *
     * The amount paid is not an input: the client cannot send one, so it can
     * neither under-pay nor leave an ordinary purchase unpaid, and an omitted
     * field can never quietly become a zero. Cost and payment are the same
     * number, recorded in the same transaction as the stock.
     */
    const amountPaid = round2(total);
    const status = 'paid' as const;

    // 4. Commit — one atomic transaction (the Receiving Session "Finish").
    /**
     * Lock the stock rows in a deterministic order.
     *
     * Two concurrent multi-line purchases that touch the same two products in
     * OPPOSITE orders will deadlock on each other. Sorting by product id gives
     * every transaction the same order, which removes that class of conflict
     * entirely rather than relying on the retry below to paper over it.
     */
    preparedStock.sort((a, b) => Buffer.compare(a.productId, b.productId));

    let purchaseId: Buffer;
    let reopen: AutoReopenResult | null = null;
    let paidDay: string | null = null;
    try {
      /**
       * Retried only if InnoDB rolled the whole transaction back for a lock
       * conflict — see `deadlock-retry.ts`. Two simultaneous purchases of the
       * same product insert the same unique key and can deadlock; the victim's
       * work is gone entirely, so re-running it is the only correct response,
       * and re-entering here re-enters the idempotency guard too.
       */
      purchaseId = await withLockRetry(() => this.db.$transaction(async (tx) => {
        const pid = newUuidV7Bin();
        await tx.purchase.create({
          data: {
            id: pid,
            companyId,
            branchId,
            supplierId: null,
            userId: this.tenant.userId() ?? null,
            referenceNo: dto.referenceNo ?? null,
            clientUuid: uuidToBin(dto.clientUuid),
            clientRequestHash: fingerprint(dto),
            date: new Date(),
            subtotal: total,
            taxTotal: 0,
            total,
            amountPaid,
            status,
            dueDate: null,
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
            imeiSecondary: u.imeiSecondary,
            serialNo: u.serialNo,
            cost: u.cost,
            supplierId: null,
            purchaseId: pid,
          });
        }

        for (const l of preparedStock) {
          await tx.purchaseItem.create({
            data: { id: newUuidV7Bin(), companyId, purchaseId: pid, productId: l.productId, quantity: l.quantity, unitCost: l.cost, taxAmount: 0 },
          });
          /**
           * Re-average the branch cost (H1.4.1).
           *
           * This used to be `update: { quantity: { increment } }` — quantity
           * moved and `cost` stayed at whatever the FIRST ever receipt paid, so
           * buying the same cable again at a higher price never changed the
           * recorded cost. The purchase line above keeps the ACTUAL price paid,
           * which is what was paid for it; only the branch's running
           * average moves.
           */
          await receiveQuantityAtCost(tx, {
            companyId,
            productId: l.productId,
            branchId,
            received: l.quantity,
            unitCost: l.cost,
            priceIfNew: l.price,
          });
        }

        /*
         * The full payment, in the same transaction as the purchase and the
         * units: all three exist, or none do. No balance is created anywhere —
         * nothing is owed. Closing and the period summary read this row as money
         * leaving the drawer (cash) or the named account.
         */
        const payDay = await this.businessDay.assign(branchId, new Date(), tx as unknown as Prisma.TransactionClient);
        await tx.supplierPayment.create({
          data: {
            id: newUuidV7Bin(),
            companyId,
            supplierId: null,
            purchaseId: pid,
            amount: amountPaid,
            method: dto.paymentMethod,
            receivingAccountId: account?.id ?? null,
            accountLabelSnapshot: account?.label ?? null,
            // The business date the money left on (0076).
            businessDate: dateValue(payDay),
            createdById: this.tenant.userId() ?? null,
          },
        });
        /**
         * Money left the drawer or an account on this business day. If the day was
         * already closed, it reopens — as a sale does — so the payment is in the
         * next close's figures instead of silently outside every close (D10).
         */
        paidDay = payDay;
        reopen = amountPaid > 0
          ? await this.closing.autoReopenTx(tx as never, { branchId, businessDate: payDay, cause: { kind: 'purchase', id: pid } })
          : null;

        await this.audit.recordTx(tx, {
          entityType: 'Purchase',
          entityId: pid,
          action: 'create',
          after: { total, units: committableUnits.length, stockLines: preparedStock.length },
          branchId,
        });

        /**
         * Queue teach-on-confirm in the SAME transaction as the purchase.
         *
         * This is the whole point of the outbox: stock and the intent to learn
         * from it either both exist or neither does. One event per code, so a
         * delivery carrying several codes retries each independently.
         */
        await this.outbox.enqueueTx(tx as never, learnPlans.map((plan) => ({
          companyId,
          purchaseId: pid,
          codeType: plan.codeType,
          code: plan.code,
          productId: plan.productId,
          supplierId: null,
          source: 'receiving',
        })));

        return pid;
      }));
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        /**
         * Two identical requests racing.
         *
         * The pre-flight replay check ran before either committed, so both got
         * past it and the unique key on `(company_id, client_uuid)` rejected
         * the loser. That loser is not a failure: the delivery it describes has
         * just been received by its twin. Ask whether this request id already
         * produced a purchase and, if so, return it — the same treatment
         * transfers have given this race since H1.1.
         *
         * Without this, a client retrying on a flaky connection could receive
         * "a duplicate identifier was detected" for a purchase that actually
         * succeeded, which is both alarming and wrong: no identifier was
         * duplicated, and there is nothing to retry.
         */
        const winner = await this.findReplay(dto, companyId);
        if (winner) return winner;
        throw new ConflictException('A duplicate identifier was detected during commit — please retry');
      }
      throw e;
    }

    const reopened = reopen as AutoReopenResult | null;
    if (reopened?.reopened && paidDay) void this.closing.afterReopenCommitted(branchId, paidDay, reopened);

    // 5. Post-commit side effects: notifications + recognition learning.
    // Receiving is the STRONGEST learning signal, and only fires on a confirmed
    // (committed) purchase. Supplier context is stamped for future intelligence.
    // Intents were queued in the SAME transaction as the purchase, so nothing
    // can be lost here. Draining now is only an optimisation — if this process
    // dies the sweeper picks the events up.
    await this.outbox.processNow();

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
      /*
       * What this purchase actually received, by name. A partly refused
       * delivery keeps its refused lines on the phone for correction; this is
       * how the client knows which lines to drop, so correcting and finishing
       * again can never send an accepted line a second time.
       */
      accepted: {
        identifiers: committableUnits.map((u) => u.identifier),
        stockProductIds: [...new Set(preparedStock.map((l) => binToUuid(l.productId)))],
      },
    };
  }

  /**
   * Look for a prior purchase created under this request identity.
   *
   * Returns the ORIGINAL outcome on an exact replay. A key reused with
   * different contents is a client bug — two different deliveries sharing one
   * key — and is rejected rather than silently answered with the wrong result.
   *
   * Scoped by company: the unique index is (company_id, client_uuid), so one
   * company's key can never suppress another company's receiving.
   */
  private async findReplay(dto: CreatePurchaseDto, companyId: Buffer) {
    const prior = await this.db.purchase.findFirst({
      where: { companyId, clientUuid: uuidToBin(dto.clientUuid) },
      include: {
        items: true,
        units: { select: { id: true, productId: true, imeiPrimary: true, serialNo: true } },
      },
    });
    if (!prior) return null;

    if (prior.clientRequestHash && prior.clientRequestHash !== fingerprint(dto)) {
      throw new ConflictException(
        'This request id was already used for a different delivery. Start a new one.',
      );
    }

    const stockLines = prior.items.length - prior.units.length;
    // Rebuilt from what was stored, not from the request: after a lost response
    // the client needs to learn which of its lines the FIRST attempt received.
    const unitProducts = new Set(prior.units.map((u) => u.productId.toString('hex')));
    return {
      purchaseId: binToUuid(prior.id),
      unitsCreated: prior.units.length,
      stockLines: stockLines > 0 ? stockLines : 0,
      total: Number(prior.total),
      rejected: [] as unknown[],
      accepted: {
        identifiers: prior.units.map((u) => u.imeiPrimary ?? u.serialNo ?? '').filter(Boolean),
        stockProductIds: [
          ...new Set(
            prior.items
              .filter((i) => !unitProducts.has(i.productId.toString('hex')))
              .map((i) => binToUuid(i.productId)),
          ),
        ],
      },
      replayed: true,
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
