import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { binToUuid, isUuid, uuidToBin } from '../common/utils/uuid.util';
import { dayKey } from '../common/utils/date.util';
import { maskIdentifier } from '../sales/sale-selection-rules';
import {
  afterReversal,
  assertDebtorFor,
  assertExpenseReversible,
  assertPurchaseCancellable,
  assertReclassifiable,
  assertReversible,
  assertSaleCancellable,
  averageAfterRemoval,
  cancellationLegs,
  positionsOf,
  type ChannelRef,
  type CorrectionAction,
  type CorrectionKind,
  type Leg,
  type Method,
} from './correction-rules';

/**
 * Every correction, planned before anything is written (docs/51 §15).
 *
 * A plan loads the record being corrected at the caller's branch, checks whether
 * it may be corrected this way, and prices exactly what an approval would post —
 * the legs, the stock, the debt. The same plan answers three questions:
 *
 *   preview  — what would this do? (nothing written; a refusal is returned, not thrown)
 *   request  — may it be asked for? (a refusal is thrown)
 *   approval — may it still be done, now? (re-planned inside the approval's
 *              transaction, after the rows are locked, so a return, a sale or a
 *              transfer that landed in between refuses the approval by name)
 *
 * A record of another branch or another company is not found — the same 404 an
 * unknown id gives — so a correction can never post against a drawer the caller
 * is not standing in.
 */

/** The tenant client or one of its transactions: both are scoped to the company. */
export type CorrectionDb = Prisma.TransactionClient;

const num = (d: Prisma.Decimal | number | null | undefined): number => (d == null ? 0 : Number(d));
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const channelOf = (method: string): Method => (method === 'cash' ? 'cash' : 'account');
const productName = (p: { brand: string; model: string; variant: string | null } | null | undefined): string =>
  p ? [p.brand, p.model, p.variant].filter(Boolean).join(' ') : '';

export interface Refusal {
  code: string;
  message: string;
  [param: string]: unknown;
}

export interface PlannedLeg extends Leg {
  sourcePaymentId?: Buffer;
  sourceSupplierPaymentId?: Buffer;
  sourceExpenseId?: Buffer;
}

export interface TargetPlan {
  kind: CorrectionKind;
  action: CorrectionAction;
  branchId: Buffer;
  /** The target column the correction row carries. */
  target: Partial<Record<'targetPaymentId' | 'targetSaleId' | 'targetExpenseId' | 'targetSupplierPaymentId' | 'targetPurchaseId', Buffer>>;
  /** The money moved, or for a cancellation the value cancelled. */
  amount: number;
  /** The channel the money is in now; null for a cancellation (its legs say). */
  method: Method | null;
  accountLabel: string | null;
  to: (ChannelRef & { label: string | null }) | null;
  /** Exactly what an approval would post now. */
  legs: PlannedLeg[];
  /** What the person deciding sees. */
  summary: Record<string, unknown>;
  /** Why it cannot be done, if it cannot. */
  refusal: Refusal | null;
  /** The rows an approval writes besides its legs — never the corrected record itself. */
  effects: PlanEffects;
}

export interface PlanEffects {
  /** The sale's receivable caches (never its lines, totals or payments). */
  sale?: { id: Buffer; customerId: Buffer | null; owedBefore: number; collected: number; owed: number; payStatus: 'paid' | 'partial' | 'credit' };
  /** Phones whose status moves, from what to what. */
  units?: { id: Buffer; from: 'sold' | 'in_stock'; to: 'in_stock' | 'voided' }[];
  /** Sale lines released from the sold-once index. */
  releaseLines?: Buffer[];
  /** Quantity goods back on the shelf, at the cost the sale recorded. */
  restock?: { productId: Buffer; quantity: number; unitCost: number }[];
  /** Quantity goods taken back out of stock: the branch's stock of them afterwards. */
  destock?: { productId: Buffer; quantity: number; cost: number }[];
}

export interface PlanInput {
  kind: CorrectionKind;
  action: CorrectionAction;
  targetId: string;
  toMethod?: Method;
  toAccountId?: string;
  amount?: number;
}

export interface PlanContext {
  companyId: Buffer;
  branchId: Buffer;
  /** The branch's current business date: a fixed expense due later cannot be reversed yet. */
  today: string;
  /** Whether the caller may see cost (the preview's cost line). */
  costView: boolean;
  /** The correction being approved: it is not an open request against its own record. */
  ignoreCorrectionId?: Buffer;
}

/** A conflict thrown by a rule, captured as a refusal the phone can show. */
export function refusalOf(check: () => void): Refusal | null {
  try {
    check();
    return null;
  } catch (e) {
    if (e instanceof ConflictException) return e.getResponse() as Refusal;
    throw e;
  }
}

function requireId(idStr: string, what: string): Buffer {
  if (!isUuid(idStr)) throw new NotFoundException(`That ${what} does not exist.`);
  return uuidToBin(idStr);
}

async function destinationOf(db: CorrectionDb, toMethod: Method | undefined, toAccountId: string | undefined) {
  if (!toMethod) throw new BadRequestException({ code: 'destination_required', message: 'Say which channel the money really went through.' });
  if (toMethod === 'cash' || !toAccountId) return { method: toMethod, accountId: null as string | null, label: null as string | null, active: true };
  if (!isUuid(toAccountId)) throw new BadRequestException({ code: 'account_required', message: 'Say which account the money went through.' });
  const account = await db.receivingAccount.findFirst({ where: { id: uuidToBin(toAccountId) }, select: { isActive: true, label: true } });
  if (!account) throw new BadRequestException({ code: 'account_required', message: 'That account does not exist.' });
  return { method: toMethod, accountId: toAccountId, label: account.label, active: account.isActive };
}

/** The approved legs already posted against some payments, purchase payments or expenses. */
async function postedLegs(db: CorrectionDb, where: Prisma.FinancialCorrectionLegWhereInput) {
  const rows = await db.financialCorrectionLeg.findMany({
    where: { ...where, correction: { status: 'approved' } },
    select: { direction: true, method: true, receivingAccountId: true, accountLabelSnapshot: true, amount: true, sourcePaymentId: true, sourceSupplierPaymentId: true },
  });
  return rows.map((l) => ({
    direction: l.direction === 'incoming' ? ('in' as const) : ('out' as const),
    method: l.method as Method,
    accountId: l.receivingAccountId ? binToUuid(l.receivingAccountId) : null,
    label: l.accountLabelSnapshot,
    amount: round2(num(l.amount)),
    sourcePaymentId: l.sourcePaymentId,
    sourceSupplierPaymentId: l.sourceSupplierPaymentId,
  }));
}

/**
 * The corrections already on a record. At an approval (`ignore` is the one being decided)
 * only an APPROVED one counts: another open request stops a second request, never a
 * decision — two requests raced in at the same moment must not block each other for
 * ever. The database's one-approved-per-record key settles who wins.
 */
const openOrApproved = (rows: { id: Buffer; status: string }[], ignore?: Buffer) => {
  const others = ignore ? rows.filter((c) => !c.id.equals(ignore)) : rows;
  return { approved: others.some((c) => c.status === 'approved'), requested: !ignore && others.some((c) => c.status === 'requested') };
};

// ── A sale payment: moved to its real channel, or reversed as never received ──

export async function planSalePayment(db: CorrectionDb, ctx: PlanContext, input: PlanInput): Promise<TargetPlan> {
  const id = requireId(input.targetId, 'payment');
  const p = await db.payment.findFirst({
    where: { id, sale: { branchId: ctx.branchId } },
    select: {
      id: true,
      kind: true,
      amount: true,
      method: true,
      receivingAccountId: true,
      accountLabelSnapshot: true,
      businessDate: true,
      corrections: { select: { id: true, status: true } },
      sale: {
        select: {
          id: true,
          branchId: true,
          invoiceNo: true,
          total: true,
          amountPaid: true,
          balanceDue: true,
          payStatus: true,
          customerId: true,
          counterpartyId: true,
          customer: { select: { name: true } },
          counterparty: { select: { name: true } },
          corrections: { select: { id: true, status: true } },
        },
      },
    },
  });
  if (!p) throw new NotFoundException('That payment does not exist.');
  const sale = p.sale;
  const amountPaid = round2(num(p.amount));
  const from: ChannelRef = {
    method: channelOf(p.method),
    accountId: p.method === 'cash' ? null : p.receivingAccountId ? binToUuid(p.receivingAccountId) : null,
    label: p.method === 'cash' ? null : p.accountLabelSnapshot,
  };
  const amount = round2(input.amount ?? amountPaid);
  const payment = {
    id: binToUuid(p.id),
    kind: p.kind,
    amount: amountPaid,
    method: from.method,
    accountLabel: from.label,
    paymentDay: dayKey(p.businessDate),
  };
  const saleState = openOrApproved(sale.corrections, ctx.ignoreCorrectionId);
  const own = openOrApproved(p.corrections, ctx.ignoreCorrectionId);
  const saleRefusal: Refusal | null = saleState.approved
    ? { code: 'sale_cancelled', message: 'This sale was cancelled; its payments cannot be corrected.' }
    : saleState.requested
      ? { code: 'sale_cancellation_pending', message: 'A cancellation of this sale is waiting for the Owner.' }
      : null;
  const ownRefusal: Refusal | null = own.approved
    ? { code: 'already_corrected', message: 'This payment has already been corrected.' }
    : own.requested
      ? { code: 'request_pending', message: 'Someone has already asked for this payment to be corrected. That request is waiting for the Owner.' }
      : null;

  if (input.action === 'reclassify') {
    const to = await destinationOf(db, input.toMethod, input.toAccountId);
    assertReclassifiable({ amount: amountPaid, fromMethod: from.method, fromAccountId: from.accountId }, { toMethod: to.method, toAccountId: to.accountId, toAccountActive: to.active }, amount);
    return {
      kind: 'sale_payment',
      action: 'reclassify',
      branchId: sale.branchId,
      target: { targetPaymentId: p.id },
      amount,
      method: from.method,
      accountLabel: from.label,
      to: { method: to.method, accountId: to.accountId, label: to.label },
      legs: [
        { direction: 'out', ...from, amount, sourcePaymentId: p.id },
        { direction: 'in', method: to.method, accountId: to.accountId, label: to.label, amount, sourcePaymentId: p.id },
      ],
      summary: {
        payment: { ...payment, saleId: binToUuid(sale.id), invoiceNo: sale.invoiceNo },
        move: { amount, from: { method: from.method, accountId: from.accountId, accountLabel: from.label }, to: { method: to.method, accountId: to.accountId, accountLabel: to.label } },
        unchanged: { saleTotal: round2(num(sale.total)), collected: round2(num(sale.amountPaid)), owed: round2(num(sale.balanceDue)) },
      },
      refusal: saleRefusal ?? ownRefusal,
      effects: {},
    };
  }

  // Reversed: the money never arrived.
  assertReversible(amountPaid, amount);
  const before = { collected: round2(num(sale.amountPaid)), owed: round2(num(sale.balanceDue)), payStatus: sale.payStatus };
  const after = afterReversal({ total: num(sale.total), received: num(sale.amountPaid) }, amount);
  return {
    kind: 'sale_payment',
    action: 'reverse',
    branchId: sale.branchId,
    target: { targetPaymentId: p.id },
    amount,
    method: from.method,
    accountLabel: from.label,
    to: null,
    legs: [{ direction: 'out', ...from, amount, sourcePaymentId: p.id }],
    summary: {
      payment: { ...payment, saleId: binToUuid(sale.id), invoiceNo: sale.invoiceNo },
      reverse: { amount, from: { method: from.method, accountId: from.accountId, accountLabel: from.label } },
      sale: { total: round2(num(sale.total)), before, after: { collected: after.received, owed: after.remaining, payStatus: after.payStatus } },
      debtor: sale.customer ? { kind: 'customer', name: sale.customer.name } : sale.counterparty ? { kind: 'store', name: sale.counterparty.name } : null,
    },
    refusal: saleRefusal ?? ownRefusal ?? refusalOf(() => assertDebtorFor(sale)),
    effects: {
      sale: { id: sale.id, customerId: sale.customerId, owedBefore: before.owed, collected: after.received, owed: after.remaining, payStatus: after.payStatus },
    },
  };
}

// ── A sale that should not exist as recorded ──

export async function planSale(db: CorrectionDb, ctx: PlanContext, input: PlanInput): Promise<TargetPlan> {
  const id = requireId(input.targetId, 'sale');
  const sale = await db.sale.findFirst({
    where: { id, branchId: ctx.branchId },
    select: {
      id: true,
      branchId: true,
      invoiceNo: true,
      total: true,
      totalCost: true,
      amountPaid: true,
      balanceDue: true,
      businessDate: true,
      soldAt: true,
      customerId: true,
      customer: { select: { name: true } },
      counterparty: { select: { name: true } },
      corrections: { select: { id: true, status: true } },
      returnRequests: { select: { status: true } },
      returnReversals: { select: { id: true } },
      returns: { select: { id: true } },
      items: {
        select: {
          id: true,
          quantity: true,
          voided: true,
          productId: true,
          cost: true,
          unit: { select: { id: true, status: true, imeiPrimary: true, serialNo: true, product: { select: { brand: true, model: true, variant: true } } } },
          product: { select: { brand: true, model: true, variant: true } },
        },
      },
      payments: {
        select: { id: true, amount: true, method: true, receivingAccountId: true, accountLabelSnapshot: true, corrections: { select: { id: true, status: true } } },
      },
    },
  });
  if (!sale) throw new NotFoundException('That sale does not exist.');
  const lines = sale.items.filter((i) => !i.voided);
  const legs = await postedLegs(db, { sourcePaymentId: { in: sale.payments.map((p) => p.id) } });
  const holdings = sale.payments.map((p) => ({
    sourceId: binToUuid(p.id),
    positions: positionsOf(
      {
        method: channelOf(p.method),
        accountId: p.method === 'cash' ? null : p.receivingAccountId ? binToUuid(p.receivingAccountId) : null,
        label: p.method === 'cash' ? null : p.accountLabelSnapshot,
        amount: round2(num(p.amount)),
      },
      legs.filter((l) => l.sourcePaymentId?.equals(p.id)),
    ),
  }));
  const out = cancellationLegs(holdings, 'out');
  const state = openOrApproved(sale.corrections, ctx.ignoreCorrectionId);
  const refusal = refusalOf(() =>
    assertSaleCancellable({
      alreadyCancelled: state.approved,
      requestPending: state.requested,
      paymentRequestPending: sale.payments.some((p) => !ctx.ignoreCorrectionId && p.corrections.some((c) => c.status === 'requested')),
      hasReturn: sale.returnRequests.some((r) => r.status !== 'rejected') || sale.returnReversals.length > 0 || sale.returns.length > 0,
      unitStatuses: lines.filter((l) => l.unit).map((l) => l.unit!.status),
    }),
  );
  return {
    kind: 'sale',
    action: 'cancel',
    branchId: sale.branchId,
    target: { targetSaleId: sale.id },
    amount: round2(num(sale.total)),
    method: null,
    accountLabel: null,
    to: null,
    legs: out.map((l) => ({ direction: l.direction, method: l.method, accountId: l.accountId, label: l.label, amount: l.amount, sourcePaymentId: uuidToBin(l.sourceId) })),
    summary: {
      sale: {
        id: binToUuid(sale.id),
        invoiceNo: sale.invoiceNo,
        total: round2(num(sale.total)),
        ...(ctx.costView ? { recordedCost: round2(num(sale.totalCost)) } : {}),
        saleDay: dayKey(sale.businessDate),
        soldAt: sale.soldAt.toISOString(),
        owed: round2(num(sale.balanceDue)),
      },
      items: lines.map((l) => ({
        name: productName(l.unit?.product ?? l.product),
        identifier: l.unit ? maskIdentifier(l.unit.imeiPrimary ?? l.unit.serialNo) : null,
        quantity: l.quantity,
      })),
      moneyBack: out.map((l) => ({ method: l.method, accountId: l.accountId, accountLabel: l.label, amount: l.amount })),
      moneyBackTotal: round2(out.reduce((n, l) => n + l.amount, 0)),
      debtor: sale.customer ? { kind: 'customer', name: sale.customer.name } : sale.counterparty ? { kind: 'store', name: sale.counterparty.name } : null,
    },
    refusal,
    effects: {
      // Nothing is owed on a sale that should not exist; what it collected is given back by the legs.
      sale: { id: sale.id, customerId: sale.customerId, owedBefore: round2(num(sale.balanceDue)), collected: round2(num(sale.amountPaid)), owed: 0, payStatus: 'paid' },
      units: lines.filter((l) => l.unit).map((l) => ({ id: l.unit!.id, from: 'sold' as const, to: 'in_stock' as const })),
      releaseLines: lines.map((l) => l.id),
      restock: lines.filter((l) => !l.unit && l.productId).map((l) => ({ productId: l.productId!, quantity: l.quantity, unitCost: round2(num(l.cost)) })),
    },
  };
}

// ── A confirmed expense that was wrong ──

export async function planExpense(db: CorrectionDb, ctx: PlanContext, input: PlanInput): Promise<TargetPlan> {
  const id = requireId(input.targetId, 'expense');
  const e = await db.expense.findFirst({
    where: { id, branchId: ctx.branchId },
    select: {
      id: true,
      branchId: true,
      status: true,
      amount: true,
      category: true,
      expenseClass: true,
      isSalary: true,
      method: true,
      receivingAccountId: true,
      accountLabelSnapshot: true,
      dueDate: true,
      confirmationDate: true,
      corrections: { select: { id: true, status: true } },
    },
  });
  if (!e || !e.branchId) throw new NotFoundException('That expense does not exist.');
  const recorded = round2(num(e.amount));
  const amount = round2(input.amount ?? recorded);
  const accountingDay = e.expenseClass === 'fixed' ? (e.dueDate ? dayKey(e.dueDate) : null) : e.confirmationDate ? dayKey(e.confirmationDate) : null;
  const channel: ChannelRef = {
    method: channelOf(e.method),
    accountId: e.method === 'cash' ? null : e.receivingAccountId ? binToUuid(e.receivingAccountId) : null,
    label: e.method === 'cash' ? null : e.accountLabelSnapshot,
  };
  if (!(amount > 0)) throw new BadRequestException({ code: 'amount_required', message: 'Say how much of the expense was wrong.' });
  if (Math.round(amount * 100) > Math.round(recorded * 100)) {
    throw new BadRequestException({ code: 'amount_above_expense', message: 'You cannot reverse more than the expense recorded.' });
  }
  const own = openOrApproved(e.corrections, ctx.ignoreCorrectionId);
  const refusal: Refusal | null = own.approved
    ? { code: 'already_corrected', message: 'This expense has already been corrected.' }
    : own.requested
      ? { code: 'request_pending', message: 'Someone has already asked for this expense to be corrected. That request is waiting for the Owner.' }
      : refusalOf(() => assertExpenseReversible({ status: e.status, amount: recorded, accountingDay }, amount, ctx.today));
  return {
    kind: 'expense',
    action: 'reverse',
    branchId: e.branchId,
    target: { targetExpenseId: e.id },
    amount,
    method: channel.method,
    accountLabel: channel.label,
    to: null,
    legs: [{ direction: 'in', ...channel, amount, sourceExpenseId: e.id }],
    summary: {
      expense: {
        id: binToUuid(e.id),
        category: e.category,
        amount: recorded,
        expenseClass: e.expenseClass,
        isSalary: e.isSalary,
        day: accountingDay,
        method: channel.method,
        accountLabel: channel.label,
      },
      reverse: { amount, to: { method: channel.method, accountId: channel.accountId, accountLabel: channel.label } },
    },
    refusal,
    effects: {},
  };
}

// ── A purchase payment in the wrong channel ──

export async function planSupplierPayment(db: CorrectionDb, ctx: PlanContext, input: PlanInput): Promise<TargetPlan> {
  const id = requireId(input.targetId, 'payment');
  const sp = await db.supplierPayment.findFirst({
    where: { id, purchase: { branchId: ctx.branchId } },
    select: {
      id: true,
      amount: true,
      method: true,
      receivingAccountId: true,
      accountLabelSnapshot: true,
      businessDate: true,
      corrections: { select: { id: true, status: true } },
      purchase: { select: { id: true, branchId: true, total: true, date: true, corrections: { select: { id: true, status: true } } } },
    },
  });
  if (!sp || !sp.purchase) throw new NotFoundException('That payment does not exist.');
  const paid = round2(num(sp.amount));
  const amount = round2(input.amount ?? paid);
  const from: ChannelRef = {
    method: channelOf(sp.method),
    accountId: sp.method === 'cash' ? null : sp.receivingAccountId ? binToUuid(sp.receivingAccountId) : null,
    label: sp.method === 'cash' ? null : sp.accountLabelSnapshot,
  };
  const to = await destinationOf(db, input.toMethod, input.toAccountId);
  assertReclassifiable({ amount: paid, fromMethod: from.method, fromAccountId: from.accountId }, { toMethod: to.method, toAccountId: to.accountId, toAccountActive: to.active }, amount);
  const own = openOrApproved(sp.corrections, ctx.ignoreCorrectionId);
  const purchase = openOrApproved(sp.purchase.corrections, ctx.ignoreCorrectionId);
  const refusal: Refusal | null = purchase.approved
    ? { code: 'purchase_cancelled', message: 'This purchase was cancelled; its payment cannot be corrected.' }
    : purchase.requested
      ? { code: 'purchase_cancellation_pending', message: 'A cancellation of this purchase is waiting for the Owner.' }
      : own.approved
        ? { code: 'already_corrected', message: 'This payment has already been corrected.' }
        : own.requested
          ? { code: 'request_pending', message: 'Someone has already asked for this payment to be corrected. That request is waiting for the Owner.' }
          : null;
  return {
    kind: 'supplier_payment',
    action: 'reclassify',
    branchId: sp.purchase.branchId,
    target: { targetSupplierPaymentId: sp.id },
    amount,
    method: from.method,
    accountLabel: from.label,
    to: { method: to.method, accountId: to.accountId, label: to.label },
    legs: [
      { direction: 'in', ...from, amount, sourceSupplierPaymentId: sp.id },
      { direction: 'out', method: to.method, accountId: to.accountId, label: to.label, amount, sourceSupplierPaymentId: sp.id },
    ],
    summary: {
      payment: { id: binToUuid(sp.id), amount: paid, method: from.method, accountLabel: from.label, paymentDay: dayKey(sp.businessDate), purchaseId: binToUuid(sp.purchase.id) },
      move: { amount, from: { method: from.method, accountId: from.accountId, accountLabel: from.label }, to: { method: to.method, accountId: to.accountId, accountLabel: to.label } },
    },
    refusal,
    effects: {},
  };
}

// ── A purchase that should not exist as recorded ──

export async function planPurchase(db: CorrectionDb, ctx: PlanContext, input: PlanInput): Promise<TargetPlan> {
  const id = requireId(input.targetId, 'purchase');
  const purchase = await db.purchase.findFirst({
    where: { id, branchId: ctx.branchId },
    select: {
      id: true,
      branchId: true,
      total: true,
      date: true,
      referenceNo: true,
      corrections: { select: { id: true, status: true } },
      items: { select: { productId: true, quantity: true, unitCost: true, product: { select: { trackingType: true, brand: true, model: true, variant: true } } } },
      units: { select: { id: true, status: true, branchId: true, imeiPrimary: true, serialNo: true, product: { select: { brand: true, model: true, variant: true } } } },
      payments: {
        select: { id: true, amount: true, method: true, receivingAccountId: true, accountLabelSnapshot: true, corrections: { select: { id: true, status: true } } },
      },
    },
  });
  if (!purchase) throw new NotFoundException('That purchase does not exist.');

  // Quantity lines, one per product, against the branch's stock of it now.
  const byProduct = new Map<string, { productId: Buffer; bought: number; value: number; name: string }>();
  for (const it of purchase.items) {
    if (it.product.trackingType !== 'quantity') continue;
    const key = it.productId.toString('hex');
    const cur = byProduct.get(key) ?? { productId: it.productId, bought: 0, value: 0, name: productName(it.product) };
    cur.bought += it.quantity;
    cur.value = round2(cur.value + it.quantity * num(it.unitCost));
    byProduct.set(key, cur);
  }
  const stockRows = byProduct.size
    ? await db.stockItem.findMany({
        where: { branchId: purchase.branchId, productId: { in: [...byProduct.values()].map((b) => b.productId) } },
        select: { productId: true, quantity: true, reservedQuantity: true, cost: true },
      })
    : [];
  const stock = [...byProduct.values()].map((b) => {
    const row = stockRows.find((r) => r.productId.equals(b.productId));
    const unitCost = b.bought > 0 ? b.value / b.bought : 0;
    const onHand = row?.quantity ?? 0;
    const averageCost = num(row?.cost);
    return { ...b, onHand, reserved: row?.reservedQuantity ?? 0, averageCost, unitCost, after: averageAfterRemoval(onHand, averageCost, b.bought, unitCost) };
  });

  const legs = await postedLegs(db, { sourceSupplierPaymentId: { in: purchase.payments.map((p) => p.id) } });
  const holdings = purchase.payments.map((p) => ({
    sourceId: binToUuid(p.id),
    positions: positionsOf(
      {
        method: channelOf(p.method),
        accountId: p.method === 'cash' ? null : p.receivingAccountId ? binToUuid(p.receivingAccountId) : null,
        label: p.method === 'cash' ? null : p.accountLabelSnapshot,
        amount: round2(num(p.amount)),
      },
      // A purchase payment is money that LEFT: a move puts it `in` the recorded channel and `out` of the real one,
      // so its position is where it really left from — the opposite sign of a sale payment's.
      legs.filter((l) => l.sourceSupplierPaymentId?.equals(p.id)).map((l) => ({ ...l, direction: l.direction === 'in' ? ('out' as const) : ('in' as const) })),
    ),
  }));
  const back = cancellationLegs(holdings, 'in');
  const state = openOrApproved(purchase.corrections, ctx.ignoreCorrectionId);
  const refusal = refusalOf(() =>
    assertPurchaseCancellable({
      alreadyCancelled: state.approved,
      requestPending: state.requested,
      paymentRequestPending: purchase.payments.some((p) => !ctx.ignoreCorrectionId && p.corrections.some((c) => c.status === 'requested')),
      units: purchase.units.map((u) => ({ status: u.status, atBranch: u.branchId.equals(purchase.branchId) })),
      stock: stock.map((s) => ({ onHand: s.onHand, reserved: s.reserved, bought: s.bought, averageCost: s.averageCost, unitCost: s.unitCost })),
    }),
  );
  return {
    kind: 'purchase',
    action: 'cancel',
    branchId: purchase.branchId,
    target: { targetPurchaseId: purchase.id },
    amount: round2(num(purchase.total)),
    method: null,
    accountLabel: null,
    to: null,
    legs: back.map((l) => ({ direction: l.direction, method: l.method, accountId: l.accountId, label: l.label, amount: l.amount, sourceSupplierPaymentId: uuidToBin(l.sourceId) })),
    summary: {
      purchase: { id: binToUuid(purchase.id), total: round2(num(purchase.total)), date: purchase.date.toISOString(), reference: purchase.referenceNo },
      units: purchase.units.map((u) => ({ name: productName(u.product), identifier: maskIdentifier(u.imeiPrimary ?? u.serialNo) })),
      stock: stock.map((s) => ({ name: s.name, bought: s.bought, onHand: s.onHand, onHandAfter: s.after?.quantity ?? null })),
      moneyBack: back.map((l) => ({ method: l.method, accountId: l.accountId, accountLabel: l.label, amount: l.amount })),
      moneyBackTotal: round2(back.reduce((n, l) => n + l.amount, 0)),
    },
    refusal,
    effects: {
      units: purchase.units.map((u) => ({ id: u.id, from: 'in_stock' as const, to: 'voided' as const })),
      destock: stock.filter((s) => s.after).map((s) => ({ productId: s.productId, quantity: s.after!.quantity, cost: s.after!.cost })),
    },
  };
}

/** The plan for any kind the new path handles. */
export function planFor(db: CorrectionDb, ctx: PlanContext, input: PlanInput): Promise<TargetPlan> {
  switch (input.kind) {
    case 'sale_payment':
      return planSalePayment(db, ctx, input);
    case 'sale':
      return planSale(db, ctx, input);
    case 'expense':
      return planExpense(db, ctx, input);
    case 'supplier_payment':
      return planSupplierPayment(db, ctx, input);
    case 'purchase':
      return planPurchase(db, ctx, input);
    default:
      throw new BadRequestException({ code: 'not_planned', message: 'That correction is made on its own record.' });
  }
}
