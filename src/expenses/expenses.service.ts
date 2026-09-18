import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { AppClsStore } from '../common/context/request-context';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { ROLLUP_QUEUE, RollupQueue } from '../analytics/rollup-queue';
import { binToUuid, isUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { dayKey } from '../common/utils/date.util';
import {
  assertAmount,
  assertClassAndDueDate,
  assertDayOpen,
  assertDecidable,
  assertMethodAndAccount,
  assertSalaryIsFixed,
  fingerprintExpense,
  needsReasonWarning,
} from './expense-rules';
import { CreateExpenseDto, DecideExpenseDto, ListExpensesDto } from './dto/create-expense.dto';
import { STORAGE_PROVIDER, type StorageProvider } from '../storage/storage.types';
import { assertReceipt, detectReceiptType, receiptKey } from './receipt-rules';

const num = (d: Prisma.Decimal | number | null | undefined): number => (d == null ? 0 : Number(d));

/**
 * Expenses — reported by whoever spent the money, confirmed by the Owner.
 *
 * The D0 audit found three things wrong with what this replaced, and the design
 * follows from them:
 *
 * **A report used to be final.** `POST /expenses` wrote a row that immediately
 * reached the day's profit, so "a report changes nothing" could not be true.
 * Now a report is a claim; only a confirmation moves anything.
 *
 * **A cash expense never reduced expected cash.** Expenses fed net profit but
 * the till figure subtracted refunds and supplier payments only — so a shop
 * that paid for electricity out of the drawer reported a shortage that was not
 * one. Fixed by keying `expensesCash` into the rollup and subtracting it in the
 * closing, exactly once.
 *
 * **There was no channel.** Cash and bank transfer were indistinguishable, so
 * even once expenses reached the till figure there was no way to subtract only
 * the ones that touched the drawer.
 *
 * Two accounting classes, and the difference is not cosmetic: a **variable**
 * expense belongs to the day it is confirmed; a **fixed** one belongs to its due
 * date and is never spread across every day.
 */
@Injectable()
export class ExpensesService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly cls: ClsService<AppClsStore>,
    @Inject(ROLLUP_QUEUE) private readonly rollups: RollupQueue,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  private has(permission: string): boolean {
    return this.cls.get('permissions')?.has(permission) ?? false;
  }

  /** May this caller see the whole branch's expenses, or only their own? */
  private seesAll(): boolean {
    return this.has('expense.review') || this.has('expense.manage');
  }

  // ─────────────────────────────── report ────────────────────────────────

  /**
   * Report an expense. **Moves no money and reaches no report.**
   *
   * Available to every store role: the person who spent the money is the one
   * who knows it happened. It does not reveal anybody else's expenses — see
   * `list()`.
   */
  async create(dto: CreateExpenseDto) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.userId();

    assertAmount(dto.amount);
    const cls = dto.expenseClass ?? 'variable';
    const method = dto.method ?? 'cash';
    assertMethodAndAccount(method, dto.receivingAccountId);
    assertClassAndDueDate(cls, dto.dueDate);
    assertSalaryIsFixed(dto.isSalary ?? false, cls);

    const fingerprint = fingerprintExpense({
      category: dto.category,
      amount: dto.amount,
      method,
      receivingAccountId: dto.receivingAccountId,
      expenseClass: cls,
      dueDate: dto.dueDate,
      note: dto.note,
    });

    /**
     * The idempotent replay, checked before any work. Same key and same payload
     * returns the original; same key and a different payload is a 409, because
     * that is not a retry.
     */
    if (dto.clientUuid) {
      const replay = await this.db.expense.findFirst({
        where: { companyId, clientUuid: uuidToBin(dto.clientUuid) },
      });
      if (replay) {
        if (replay.clientRequestHash !== fingerprint) {
          throw new ConflictException({
            code: 'idempotency_conflict',
            message: 'That request id was already used for a different expense.',
          });
        }
        return this.detail(binToUuid(replay.id));
      }
    }

    /**
     * The account must be ACTIVE to report against. Reporting money out of a
     * channel the shop has retired is almost always a mistake — and the label
     * is snapshotted here, at report time, so a later rename or deactivation
     * cannot retitle the movement or strand its confirmation.
     */
    let accountLabel: string | null = null;
    if (method === 'account') {
      if (!isUuid(dto.receivingAccountId!)) throw new NotFoundException('Account not found');
      const account = await this.db.receivingAccount.findFirst({
        where: { id: uuidToBin(dto.receivingAccountId!), isActive: true },
        select: { label: true },
      });
      if (!account) {
        throw new NotFoundException({
          code: 'account_unavailable',
          message: 'That account is not available. Choose an active one.',
        });
      }
      accountLabel = account.label;
    }

    const id = newUuidV7Bin();
    await this.db.expense.create({
      data: {
        id,
        companyId,
        branchId,
        category: dto.category.trim(),
        amount: dto.amount,
        // Kept for continuity with the pre-workflow column; the ACCOUNTING date
        // is `confirmationDate` (variable) or `dueDate` (fixed).
        spentOn: new Date(`${dto.spentOn ?? dayKey(new Date())}T00:00:00.000Z`),
        status: 'reported',
        expenseClass: cls,
        isSalary: dto.isSalary ?? false,
        dueDate: dto.dueDate ? new Date(`${dto.dueDate}T00:00:00.000Z`) : null,
        method,
        receivingAccountId: dto.receivingAccountId ? uuidToBin(dto.receivingAccountId) : null,
        accountLabelSnapshot: accountLabel,
        reference: dto.reference?.trim() || null,
        note: dto.note?.trim() || null,
        reportedById: userId ?? null,
        reportedAt: new Date(),
        createdById: userId ?? null,
        clientUuid: dto.clientUuid ? uuidToBin(dto.clientUuid) : null,
        clientRequestHash: dto.clientUuid ? fingerprint : null,
      },
    });

    await this.audit.record({
      entityType: 'Expense',
      entityId: id,
      action: 'create',
      after: { category: dto.category, amount: dto.amount, status: 'reported', method },
      branchId,
    });

    // Deliberately NO rollup recompute: a report changes no figure.
    return this.detail(binToUuid(id));
  }

  // ─────────────────────────────── decide ────────────────────────────────

  /**
   * Confirm. **This is the only moment money is treated as having left.**
   *
   * Owner-only at the route. A variable expense lands on today, which must be
   * open; a fixed one lands on its own due date and does not touch today's
   * till at all.
   */
  async confirm(idStr: string, dto: DecideExpenseDto) {
    const expense = await this.load(idStr);
    assertDecidable(expense);

    const companyId = this.tenant.companyId();
    const day = dayKey(new Date());
    const confirmationDate = new Date(`${day}T00:00:00.000Z`);

    /**
     * Only a VARIABLE expense touches today's till, so only it needs today
     * open. A fixed expense is recognised on its due date and would not change
     * a closed day's figures either way.
     */
    if (expense.expenseClass === 'variable') {
      const closing = await this.db.dailyClosing.findUnique({
        where: { branchId_closingDate: { branchId: expense.branchId!, closingDate: confirmationDate } },
      });
      assertDayOpen(closing, day);
    }

    const moved = await this.db.expense.updateMany({
      where: { id: expense.id, companyId, version: dto.expectedVersion, status: 'reported' },
      data: {
        status: 'confirmed',
        confirmedById: this.tenant.userId() ?? null,
        confirmedAt: new Date(),
        confirmationDate,
        // Recorded as an explicit state, never as invented copy.
        reasonOmitted: dto.reasonOmitted ?? needsReasonWarning(expense),
        version: { increment: 1 },
      },
    });
    if (moved.count === 0) {
      throw new ConflictException({
        code: 'refresh_required',
        message: 'This expense changed while you were looking at it. Open it again.',
      });
    }

    await this.audit.record({
      entityType: 'Expense',
      entityId: expense.id,
      action: 'status_change',
      after: { status: 'confirmed', confirmationDate: day, amount: num(expense.amount) },
      branchId: expense.branchId ?? undefined,
    });

    /**
     * The accounting day: today for a variable expense, the due date for a
     * fixed one. Recomputing the wrong day would leave the movement invisible
     * where it belongs and phantom where it does not.
     */
    const accountingDay =
      expense.expenseClass === 'fixed' && expense.dueDate ? dayKey(expense.dueDate) : day;
    this.rollups.enqueueDailyRecompute({ companyId, branchId: expense.branchId!, day: accountingDay });

    return this.detail(idStr);
  }

  /** Reject. Changes nothing financial; no figure ever included it. */
  async reject(idStr: string, dto: DecideExpenseDto) {
    const expense = await this.load(idStr);
    assertDecidable(expense);

    const moved = await this.db.expense.updateMany({
      where: {
        id: expense.id,
        companyId: this.tenant.companyId(),
        version: dto.expectedVersion,
        status: 'reported',
      },
      data: {
        status: 'rejected',
        rejectedReason: dto.reason?.trim() || null,
        version: { increment: 1 },
      },
    });
    if (moved.count === 0) {
      throw new ConflictException({
        code: 'refresh_required',
        message: 'This expense changed while you were looking at it. Open it again.',
      });
    }

    await this.audit.record({
      entityType: 'Expense',
      entityId: expense.id,
      action: 'status_change',
      reason: dto.reason?.trim(),
      after: { status: 'rejected' },
      branchId: expense.branchId ?? undefined,
    });

    // No recompute: a rejected report was never in any figure.
    return this.detail(idStr);
  }

  // ──────────────────────────────── reads ────────────────────────────────

  /**
   * List expenses.
   *
   * **A submitter sees only their own.** `expense.submit` lets somebody report
   * what they spent; it must not hand them the shop's whole outgoings. Only a
   * reviewer or manager sees everything.
   */
  async list(query: ListExpensesDto) {
    const branchId = this.tenant.branchId();
    const userId = this.tenant.userId();

    const where: Prisma.ExpenseWhereInput = {
      ...(branchId ? { branchId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.date ? { spentOn: new Date(`${query.date}T00:00:00.000Z`) } : {}),
      // The gate that keeps `expense.submit` from becoming company-wide
      // visibility.
      ...(this.seesAll() ? {} : { reportedById: userId ?? undefined }),
    };

    const rows = await this.db.expense.findMany({
      where,
      orderBy: { id: 'desc' },
      take: Math.min(Math.max(query.limit ?? 50, 1), 200),
      include: this.includes(),
    });
    return { rows: rows.map((r) => this.shape(r)) };
  }

  async detail(idStr: string) {
    const row = await this.loadFull(idStr);
    if (!this.seesAll()) {
      const userId = this.tenant.userId();
      // Someone else's expense is simply not found, rather than refused — the
      // 404 says nothing about whether it exists.
      if (!row.reportedById || !userId || !row.reportedById.equals(userId)) {
        throw new NotFoundException('Expense not found');
      }
    }
    return this.shape(row);
  }

  // ────────────────────────────── internals ──────────────────────────────

  private includes() {
    return {
      reportedBy: { select: { name: true } },
      confirmedBy: { select: { name: true } },
    } as const;
  }

  /**
   * Attach a receipt photo to an expense at this branch (0074).
   *
   * Optional evidence only: it changes no amount, no status and no day, so it
   * may be added to a reported or a confirmed expense alike. A second photo
   * replaces the first.
   */
  async attachReceipt(idStr: string, bytes: Buffer | undefined) {
    const expense = await this.loadHere(idStr);
    const type = assertReceipt(bytes);
    const key = receiptKey(binToUuid(expense.companyId), binToUuid(expense.id), type.ext);
    if (expense.receiptKey && expense.receiptKey !== key) await this.storage.delete(expense.receiptKey).catch(() => undefined);
    await this.storage.put(key, bytes as Buffer, type.contentType);
    await this.db.expense.update({ where: { id: expense.id }, data: { receiptKey: key } });
    await this.audit.record({
      entityType: 'Expense',
      entityId: expense.id,
      action: 'update',
      reason: 'receipt_attached',
      branchId: expense.branchId ?? undefined,
    });
    return { hasReceipt: true };
  }

  /** The receipt photo, for whoever may read the expense at this branch. */
  async readReceipt(idStr: string): Promise<{ bytes: Buffer; contentType: string }> {
    const expense = await this.loadHere(idStr);
    if (!expense.receiptKey) throw new NotFoundException('No receipt for this expense');
    const bytes = await this.storage.get(expense.receiptKey);
    return { bytes, contentType: detectReceiptType(bytes)?.contentType ?? 'application/octet-stream' };
  }

  /**
   * An expense of THIS branch that the caller may see. Another branch's, and —
   * for somebody who only reports expenses — another person's, answer exactly
   * like a missing one, the same rule `detail()` applies.
   */
  private async loadHere(idStr: string) {
    const expense = await this.load(idStr);
    const branchId = this.tenant.requireBranchId();
    if (!expense.branchId || !expense.branchId.equals(branchId)) throw new NotFoundException('Expense not found');
    if (!this.seesAll()) {
      const userId = this.tenant.userId();
      if (!expense.reportedById || !userId || !expense.reportedById.equals(userId)) {
        throw new NotFoundException('Expense not found');
      }
    }
    return expense;
  }

  /** A malformed id is a 404, not a 500 — shipped as a real defect twice. */
  private async load(idStr: string) {
    if (!isUuid(idStr)) throw new NotFoundException('Expense not found');
    const row = await this.db.expense.findFirst({ where: { id: uuidToBin(idStr) } });
    if (!row) throw new NotFoundException('Expense not found');
    return row;
  }

  private async loadFull(idStr: string) {
    if (!isUuid(idStr)) throw new NotFoundException('Expense not found');
    const row = await this.db.expense.findFirst({
      where: { id: uuidToBin(idStr) },
      include: this.includes(),
    });
    if (!row) throw new NotFoundException('Expense not found');
    return row;
  }

  private shape(r: {
    id: Buffer;
    category: string;
    amount: Prisma.Decimal;
    status: string;
    expenseClass: string;
    isSalary: boolean;
    dueDate: Date | null;
    method: string;
    accountLabelSnapshot: string | null;
    reference: string | null;
    note: string | null;
    reasonOmitted: boolean;
    rejectedReason: string | null;
    spentOn: Date;
    reportedAt: Date | null;
    confirmedAt: Date | null;
    confirmationDate: Date | null;
    version: number;
    reportedBy?: { name: string } | null;
    confirmedBy?: { name: string } | null;
  }) {
    return {
      id: binToUuid(r.id),
      category: r.category,
      amount: num(r.amount),
      status: r.status,
      expenseClass: r.expenseClass,
      isSalary: r.isSalary,
      dueDate: r.dueDate ? dayKey(r.dueDate) : null,
      method: r.method,
      accountLabel: r.accountLabelSnapshot,
      reference: r.reference,
      note: r.note,
      /** True when the Owner knowingly confirmed without stating a reason. */
      reasonOmitted: r.reasonOmitted,
      rejectedReason: r.rejectedReason,
      spentOn: dayKey(r.spentOn),
      reportedBy: r.reportedBy?.name ?? null,
      reportedAt: r.reportedAt?.toISOString() ?? null,
      confirmedBy: r.confirmedBy?.name ?? null,
      confirmedAt: r.confirmedAt?.toISOString() ?? null,
      /** The business day the money is counted against. */
      confirmationDate: r.confirmationDate ? dayKey(r.confirmationDate) : null,
      version: r.version,
    };
  }
}
