import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { binToUuid, isUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { BusinessDayService, dateValue } from '../common/business-day/business-day.service';
import { ClosingService, type AutoReopenResult } from '../closing/closing.service';
import { assertDayOpen } from '../expenses/expense-rules';
import { RecordSalePaymentDto } from './dto/record-payment.dto';
import { afterPayment, assertCollectable, collectionFingerprint, resolvePaidAt } from './sale-payment-rules';

const num = (v: unknown): number => (v == null ? 0 : Number(v));

/**
 * Money received LATER against a sale's balance (0074).
 *
 * ## The accounting, which is the whole point
 *
 * The phone was sold once, on the original sale. Its selling price, its cost
 * and its profit live on that sale's `sale_items`, on that sale's day, and
 * nothing here writes to them. A collection is a movement of money, not a sale:
 *
 * - it is a `payments` row dated `paid_at` — the day the money arrived — which
 *   is what closing, reconciliation and "collected" all read (0074 moved them
 *   off the sale's date for exactly this reason);
 * - cash raises the drawer, an account payment raises that account, and never
 *   the other;
 * - the sale's `amount_paid` rises and `balance_due` falls by the same amount,
 *   and the status is recomputed from what was received;
 * - no `sale.recorded` event is emitted, so the rollup — revenue, cost, profit,
 *   the count of phones sold — is not recomputed and cannot move.
 *
 * ## Safety
 *
 * The sale row is locked `FOR UPDATE` for the whole write, so two collections
 * against one balance are serialised and the second sees what the first left:
 * together they can never exceed what was owed. A retried request carries the
 * same key; the unique `(company, client_uuid)` index arbitrates a race between
 * two identical retries, and the payload hash refuses a key reused for a
 * different payment.
 */
@Injectable()
export class SalePaymentsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly businessDay: BusinessDayService,
    private readonly closing: ClosingService,
  ) {}

  async record(saleIdStr: string, dto: RecordSalePaymentDto) {
    if (!isUuid(saleIdStr)) throw new NotFoundException('No such sale');
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    let reopen: AutoReopenResult = { reopened: false, closingId: null, reopenCount: 0, at: null };
    let reopenDay = '';
    const userId = this.tenant.userId();
    if (!userId) throw new BadRequestException('No authenticated user');

    const saleId = uuidToBin(saleIdStr);
    const clientUuid = uuidToBin(dto.clientUuid);
    const hash = collectionFingerprint({
      saleId: saleIdStr,
      amount: dto.amount,
      method: dto.method,
      receivingAccountId: dto.receivingAccountId ?? null,
      paidAt: dto.paidAt ?? null,
      reference: dto.reference ?? null,
      note: dto.note ?? null,
    });

    // A retry of something already recorded answers with what it recorded.
    const replay = await this.replay(companyId, clientUuid, hash);
    if (replay) return replay;

    const accountBin = dto.method === 'cash' || !dto.receivingAccountId ? null : uuidToBin(dto.receivingAccountId);
    if (dto.method !== 'cash' && !accountBin) {
      throw new BadRequestException({ code: 'account_required', message: 'Choose the account this money was received into' });
    }
    if (dto.method === 'cash' && dto.receivingAccountId) {
      // The drawer belongs to no account; `ck_payments_cash_no_account` agrees.
      throw new BadRequestException({ code: 'cash_has_no_account', message: 'Cash is not received into an account' });
    }

    try {
      await this.db.$transaction(async (tx) => {
        /**
         * Lock the sale. Scoped by company AND the active branch, so another
         * company's sale is not found and another branch's is refused — the
         * collection is recorded where the money is.
         */
        const rows = await tx.$queryRaw<
          {
            id: Buffer;
            total: unknown;
            amount_paid: unknown;
            balance_due: unknown;
            sold_at: Date;
            is_reversed: number;
            customer_id: Buffer | null;
            branch_id: Buffer;
          }[]
        >(Prisma.sql`
          SELECT id, total, amount_paid, balance_due, sold_at, is_reversed, customer_id, branch_id
          FROM sales
          WHERE id = ${saleId} AND company_id = ${companyId}
          FOR UPDATE`);
        const sale = rows[0];
        if (!sale) throw new NotFoundException('No such sale');
        if (!Buffer.from(sale.branch_id).equals(branchId)) {
          throw new NotFoundException('No such sale at this branch');
        }
        if (Number(sale.is_reversed) === 1) {
          throw new ConflictException({ code: 'sale_reversed', message: 'This sale was reversed; nothing is owed on it' });
        }
        // A cancelled sale should never have been recorded (0079): nothing is owed on it.
        const cancelled = await tx.financialCorrection.findFirst({ where: { targetSaleId: saleId, status: 'approved' }, select: { id: true } });
        if (cancelled) {
          throw new ConflictException({ code: 'sale_cancelled', message: 'This sale was cancelled; nothing is owed on it' });
        }

        const balance = { total: num(sale.total), received: num(sale.amount_paid) };
        assertCollectable(balance, dto.amount);

        const paidAt = resolvePaidAt(dto.paidAt, new Date(sale.sold_at));
        /**
         * The day the money arrived must still be open. Writing into a signed
         * off day would change a count the shop has already reconciled — the
         * same rule an expense and a correction follow.
         */
        const reader = tx as unknown as Prisma.TransactionClient;
        const day = await this.businessDay.assign(branchId, paidAt, reader);
        const today = await this.businessDay.today(branchId, reader);
        const closing = await tx.dailyClosing.findUnique({
          where: { branchId_closingDate: { branchId, closingDate: dateValue(day) } },
          select: { isLocked: true },
        });
        if (day === today) {
          /**
           * Money arriving on the CURRENT business day after a counted close
           * reopens the day (0076), exactly as a sale does. A payment back-dated
           * into an earlier locked day is still refused: that day is behind the
           * boundary and is corrected through Milestone B.
           */
          reopen = await this.closing.autoReopenTx(tx, { branchId, businessDate: day, cause: { kind: 'payment', id: saleId } });
          reopenDay = day;
        } else {
          assertDayOpen(closing, day);
        }

        const account = accountBin
          ? await tx.receivingAccount.findFirst({
              where: { id: accountBin },
              select: { label: true, provider: true, providerName: true, isActive: true },
            })
          : null;
        if (accountBin && !account) {
          throw new BadRequestException({ code: 'account_not_found', message: 'That receiving account does not exist' });
        }
        if (account && !account.isActive) {
          // A closed channel takes no new money. Past payments keep their label.
          throw new BadRequestException({ code: 'account_inactive', message: 'That receiving account is no longer active' });
        }

        const next = afterPayment(balance, dto.amount);

        await tx.payment.create({
          data: {
            id: newUuidV7Bin(),
            companyId,
            saleId,
            kind: 'collection',
            method: dto.method,
            amount: dto.amount,
            paidAt,
            businessDate: dateValue(day),
            recordedById: userId,
            clientUuid,
            clientRequestHash: hash,
            reference: dto.reference?.trim() || null,
            note: dto.note?.trim() || null,
            receivingAccountId: accountBin,
            // Frozen now: renaming or closing the account later must not
            // rewrite what this payment was recorded as.
            accountLabelSnapshot: account?.label ?? null,
            accountProviderSnapshot: account
              ? account.provider === 'other'
                ? (account.providerName ?? 'other')
                : account.provider
              : null,
          },
        });

        await tx.sale.update({
          where: { id: saleId },
          data: { amountPaid: next.received, balanceDue: next.remaining, payStatus: next.payStatus },
        });

        // The customer's running balance is a cache of their open sales.
        if (sale.customer_id) {
          await tx.customer.update({
            where: { id: sale.customer_id },
            data: { balance: { decrement: dto.amount } },
          });
        }

        await this.audit.recordTx(tx, {
          entityType: 'Sale',
          entityId: saleId,
          action: 'update',
          reason: 'payment_collected',
          after: { amount: dto.amount, method: dto.method, paidAt, remaining: next.remaining, payStatus: next.payStatus },
          branchId,
        });
      });
    } catch (e) {
      /**
       * Two identical retries raced and the other one committed first. The
       * unique key refused this one; answer with what the winner recorded, or
       * refuse if the payload differs.
       */
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await this.replay(companyId, clientUuid, hash);
        if (winner) return winner;
      }
      throw e;
    }

    if (reopen.reopened) void this.closing.afterReopenCommitted(branchId, reopenDay, reopen);
    return this.state(saleId);
  }

  /** The result of an earlier request with this key, or null if there was none. */
  private async replay(companyId: Buffer, clientUuid: Buffer, hash: string) {
    const existing = await this.db.payment.findFirst({
      where: { companyId, clientUuid },
      select: { saleId: true, clientRequestHash: true },
    });
    if (!existing) return null;
    if (existing.clientRequestHash !== hash) {
      throw new ConflictException({
        code: 'idempotency_key_reused',
        message: 'This payment key was already used for a different payment',
      });
    }
    return this.state(existing.saleId);
  }

  /** What the sale owes now, and every payment it has received. */
  async state(saleId: Buffer) {
    const sale = await this.db.sale.findFirst({
      where: { id: saleId },
      select: {
        id: true,
        invoiceNo: true,
        total: true,
        amountPaid: true,
        balanceDue: true,
        payStatus: true,
        payments: {
          orderBy: { paidAt: 'asc' },
          select: paymentSelect,
        },
      },
    });
    if (!sale) throw new NotFoundException('No such sale');
    return {
      id: binToUuid(sale.id),
      invoiceNo: sale.invoiceNo,
      total: num(sale.total),
      received: num(sale.amountPaid),
      remaining: num(sale.balanceDue),
      payStatus: sale.payStatus,
      payments: sale.payments.map(toPaymentView),
    };
  }
}

/** What a payment row exposes. Never the idempotency key or its hash. */
export const paymentSelect = {
  id: true,
  kind: true,
  method: true,
  amount: true,
  paidAt: true,
  reference: true,
  note: true,
  accountLabelSnapshot: true,
  accountProviderSnapshot: true,
  recordedBy: { select: { name: true } },
} satisfies Prisma.PaymentSelect;

type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof paymentSelect }>;

export function toPaymentView(p: PaymentRow) {
  return {
    id: binToUuid(p.id),
    kind: p.kind,
    method: p.method,
    amount: num(p.amount),
    paidAt: p.paidAt,
    reference: p.reference,
    note: p.note,
    // The label as it stood when the money arrived — a later rename or
    // deactivation of the account does not reach back into this history.
    accountLabel: p.accountLabelSnapshot,
    accountProvider: p.accountProviderSnapshot,
    recordedBy: p.recordedBy?.name ?? null,
  };
}
