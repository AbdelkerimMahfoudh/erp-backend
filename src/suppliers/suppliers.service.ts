import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { AppClsStore } from '../common/context/request-context';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { binToUuid, isUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { settlementNotCorrected } from '../corrections/correction-sql';
import {
  allocateOldestFirst,
  assertAllocationFits,
  assertStillPayable,
  purchaseStatusOf,
  round2,
  settlementFingerprint,
  type AllocationInput,
  type OutstandingPurchase,
} from './payable';
import {
  ConfirmSettlementDto,
  CorrectSettlementDto,
  CreateSupplierDto,
  ListSuppliersDto,
  ReportSettlementDto,
  UpdateSupplierDto,
} from './dto/supplier.dto';

const num = (d: Prisma.Decimal | number | null | undefined): number => (d == null ? 0 : Number(d));

type Tx = Omit<TenantPrisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

/**
 * Suppliers, what the shop owes them, and recording that it paid.
 *
 * **The app records payments. It does not move money.** No provider is called,
 * no balance is looked up and no credential is held — every figure here comes
 * from what somebody says happened at the counter, and from purchases the shop
 * already made.
 *
 * The outstanding payable is **derived** from immutable rows: purchase totals
 * minus confirmed allocations. `Supplier.balance` is kept in step for
 * compatibility but nothing decides from it (`docs/28` §3.1) — a debt that
 * lives in a mutable counter is a debt that can silently disappear.
 */
@Injectable()
export class SuppliersService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  private has(permission: string): boolean {
    return this.cls.get('permissions')?.has(permission) ?? false;
  }

  /** May this caller see what the shop owes? */
  private seesMoney(): boolean {
    return this.has('supplier.manage') || this.has('supplier.payment.confirm');
  }

  // ──────────────────────────────── suppliers ────────────────────────────────

  /**
   * Browse suppliers.
   *
   * Open to anyone signed in, because receiving needs to pick one — but the
   * **money is gated**. Before J1 this returned every supplier's outstanding
   * balance to every user (`docs/28` §3.7).
   */
  async list(query: ListSuppliersDto) {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
    const status = query.status ?? 'active';
    const search = query.search?.trim();

    const where: Prisma.SupplierWhereInput = {
      ...(status === 'active' ? { deletedAt: null } : {}),
      ...(status === 'inactive' ? { deletedAt: { not: null } } : {}),
      ...(search
        ? { OR: [{ name: { contains: search } }, { phone: { contains: search } }] }
        : {}),
    };

    const rows = await this.db.supplier.findMany({
      where,
      // UUIDv7 keys are time-ordered and unique, so a keyset cursor cannot skip
      // or repeat a row when somebody adds a supplier mid-scroll.
      ...(query.cursor ? { cursor: { id: uuidToBin(query.cursor) }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      take: limit + 1,
    });

    const page = rows.slice(0, limit);
    const money = this.seesMoney() ? await this.outstandingBySupplier(page.map((s) => s.id)) : null;

    return {
      rows: page.map((s) => ({
        id: binToUuid(s.id),
        name: s.name,
        phone: s.phone,
        isActive: s.deletedAt === null,
        // Absent, not zero, for anyone who may not see it — the same rule cost
        // gating uses everywhere else.
        ...(money ? { outstanding: money.get(s.id.toString('hex')) ?? 0 } : {}),
      })),
      nextCursor: rows.length > limit ? binToUuid(page[page.length - 1]!.id) : null,
    };
  }

  /** Outstanding per supplier, derived from purchases minus confirmed payments. */
  private async outstandingBySupplier(ids: Buffer[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (ids.length === 0) return out;

    const totals = await this.db.purchase.groupBy({
      by: ['supplierId'],
      where: { supplierId: { in: ids } },
      _sum: { total: true },
    });
    const paid = await this.db.$queryRaw<{ supplier_id: Buffer; paid: Prisma.Decimal }[]>(Prisma.sql`
      SELECT s.supplier_id, COALESCE(SUM(a.amount), 0) AS paid
        FROM supplier_settlements s
        JOIN supplier_settlement_allocations a ON a.settlement_id = s.id
       WHERE s.company_id = ${this.tenant.companyId()}
         AND s.status = 'confirmed'
         -- A corrected payment no longer settles anything: the debt is owed
         -- again, so it must not count as paid here (Milestone B).
         ${settlementNotCorrected('s')}
       GROUP BY s.supplier_id`);
    const paidBy = new Map(paid.map((p) => [p.supplier_id.toString('hex'), num(p.paid)]));

    for (const t of totals) {
      const key = t.supplierId.toString('hex');
      out.set(key, round2(num(t._sum.total) - (paidBy.get(key) ?? 0)));
    }
    // Also record any purchase-free supplier the caller asked about.
    for (const id of ids) {
      const key = id.toString('hex');
      if (!out.has(key)) out.set(key, round2(-(paidBy.get(key) ?? 0)));
    }
    return out;
  }

  async create(dto: CreateSupplierDto) {
    const companyId = this.tenant.companyId();
    try {
      const supplier = await this.db.supplier.create({
        data: {
          id: newUuidV7Bin(),
          companyId,
          name: dto.name,
          phone: dto.phone ?? null,
          notes: dto.notes ?? null,
        },
      });
      await this.audit.record({
        entityType: 'Supplier',
        entityId: supplier.id,
        action: 'create',
        after: { name: supplier.name, phone: supplier.phone },
      });
      return this.detail(binToUuid(supplier.id));
    } catch (e) {
      throw this.mapDuplicate(e, dto.name);
    }
  }

  async update(idStr: string, dto: UpdateSupplierDto) {
    const supplier = await this.load(idStr);
    if (Object.keys(dto).length === 0) {
      throw new BadRequestException('Nothing to change');
    }

    const data: Prisma.SupplierUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.phone !== undefined) data.phone = dto.phone || null;
    if (dto.notes !== undefined) data.notes = dto.notes || null;
    /**
     * Deactivation is a timestamp, never a delete. An inactive supplier
     * disappears from new receiving and stays everywhere history is shown.
     */
    if (dto.isActive !== undefined) data.deletedAt = dto.isActive ? null : new Date();

    try {
      await this.db.supplier.update({ where: { id: supplier.id }, data });
    } catch (e) {
      throw this.mapDuplicate(e, dto.name ?? supplier.name);
    }

    await this.audit.record({
      entityType: 'Supplier',
      entityId: supplier.id,
      action: 'update',
      before: { name: supplier.name, phone: supplier.phone, active: supplier.deletedAt === null },
      after: { ...dto },
    });
    return this.detail(idStr);
  }

  /**
   * A supplier, with as much of the ledger as the caller may see.
   *
   * The purchase and payment history is the financial part; the name and phone
   * are what receiving needs. They are gated separately for that reason.
   */
  async detail(idStr: string) {
    const supplier = await this.load(idStr);
    const base = {
      id: binToUuid(supplier.id),
      name: supplier.name,
      phone: supplier.phone,
      notes: supplier.notes,
      isActive: supplier.deletedAt === null,
    };
    if (!this.seesMoney()) return { ...base, ledger: null };

    const [purchases, settlements] = await Promise.all([
      this.db.purchase.findMany({
        where: { supplierId: supplier.id },
        select: {
          id: true, total: true, date: true, referenceNo: true, dueDate: true,
          branch: { select: { id: true, name: true } },
        },
        orderBy: { date: 'asc' },
      }),
      this.db.supplierSettlement.findMany({
        where: { supplierId: supplier.id },
        include: {
          allocations: true,
          reportedBy: { select: { name: true } },
          confirmedBy: { select: { name: true } },
          branch: { select: { name: true } },
        },
        orderBy: { id: 'desc' },
      }),
    ]);

    const paidByPurchase = new Map<string, number>();
    for (const s of settlements) {
      if (s.status !== 'confirmed') continue;
      for (const a of s.allocations) {
        const key = a.purchaseId.toString('hex');
        paidByPurchase.set(key, round2((paidByPurchase.get(key) ?? 0) + num(a.amount)));
      }
    }

    const ledger = purchases.map((p) => {
      const paid = paidByPurchase.get(p.id.toString('hex')) ?? 0;
      const total = num(p.total);
      return {
        purchaseId: binToUuid(p.id),
        referenceNo: p.referenceNo,
        date: p.date,
        dueDate: p.dueDate,
        branch: { id: binToUuid(p.branch.id), name: p.branch.name },
        total,
        paid: round2(paid),
        outstanding: round2(total - paid),
        // Derived, every time. Never a stored decision that drifted.
        status: purchaseStatusOf(total, paid),
      };
    });

    const outstanding = round2(ledger.reduce((s, l) => s + l.outstanding, 0));
    const confirmed = settlements.filter((s) => s.status === 'confirmed');
    const pending = settlements.filter((s) => s.status === 'reported');

    return {
      ...base,
      ledger: {
        totalPurchased: round2(ledger.reduce((s, l) => s + l.total, 0)),
        totalConfirmedPaid: round2(confirmed.reduce((s, x) => s + num(x.amount), 0)),
        /** What the shop still owes. Derived from immutable rows, all time. */
        outstanding,
        /** Reported and waiting on a manager. NOT a cash movement, NOT settled. */
        awaitingConfirmation: round2(pending.reduce((s, x) => s + num(x.amount), 0)),
        purchases: ledger,
        settlements: settlements.map((s) => this.settlementView(s)),
      },
    };
  }

  private settlementView(s: {
    id: Buffer; status: string; amount: Prisma.Decimal; method: string; version: number;
    accountLabelSnapshot: string | null; transactionReference: string | null; note: string | null;
    reportedAt: Date; confirmedAt: Date | null; confirmationDate: Date | null;
    reportedBy?: { name: string } | null; confirmedBy?: { name: string } | null;
    branch?: { name: string } | null;
    allocations: { purchaseId: Buffer; amount: Prisma.Decimal }[];
  }) {
    return {
      id: binToUuid(s.id),
      status: s.status,
      version: s.version,
      amount: num(s.amount),
      method: s.method,
      accountLabel: s.accountLabelSnapshot,
      transactionReference: s.transactionReference,
      note: s.note,
      branch: s.branch?.name ?? null,
      reportedBy: s.reportedBy?.name ?? null,
      reportedAt: s.reportedAt,
      confirmedBy: s.confirmedBy?.name ?? null,
      confirmedAt: s.confirmedAt,
      confirmationDate: s.confirmationDate,
      allocations: s.allocations.map((a) => ({
        purchaseId: binToUuid(a.purchaseId),
        amount: num(a.amount),
      })),
    };
  }

  // ──────────────────────────────── payments ─────────────────────────────────

  /**
   * What is still owed, oldest first, with a suggested split of `amount`.
   *
   * The suggestion is returned so the person can SEE where the money would go
   * before sending it. Nothing is allocated by this call.
   */
  async payableFor(idStr: string, amount?: number) {
    const supplier = await this.load(idStr);
    const open = await this.openPurchases(supplier.id);
    return {
      supplier: { id: binToUuid(supplier.id), name: supplier.name, isActive: supplier.deletedAt === null },
      outstanding: round2(open.reduce((s, p) => s + p.outstanding, 0)),
      purchases: open.map((p) => ({
        purchaseId: p.purchaseId,
        total: p.total,
        paid: p.paid,
        outstanding: p.outstanding,
        date: p.date,
      })),
      suggested: amount && amount > 0 ? allocateOldestFirst(amount, open) : [],
    };
  }

  /** Every purchase with something still owed on it, oldest first. */
  private async openPurchases(supplierId: Buffer): Promise<OutstandingPurchase[]> {
    const purchases = await this.db.purchase.findMany({
      where: { supplierId },
      select: { id: true, total: true, date: true },
      orderBy: { date: 'asc' },
    });
    const rows = await this.db.$queryRaw<{ purchase_id: Buffer; paid: Prisma.Decimal }[]>(Prisma.sql`
      SELECT a.purchase_id, COALESCE(SUM(a.amount), 0) AS paid
        FROM supplier_settlement_allocations a
        JOIN supplier_settlements s ON s.id = a.settlement_id
       WHERE s.company_id = ${this.tenant.companyId()}
         AND s.supplier_id = ${supplierId}
         AND s.status = 'confirmed'
         -- Per-delivery outstanding. A corrected payment stops covering the
         -- purchases it was allocated to, exactly once (Milestone B).
         ${settlementNotCorrected('s')}
       GROUP BY a.purchase_id`);
    const paidBy = new Map(rows.map((r) => [r.purchase_id.toString('hex'), num(r.paid)]));

    return purchases
      .map((p) => {
        const total = num(p.total);
        const paid = paidBy.get(p.id.toString('hex')) ?? 0;
        return {
          purchaseId: binToUuid(p.id),
          total,
          paid: round2(paid),
          outstanding: round2(total - paid),
          date: p.date,
        };
      })
      .filter((p) => p.outstanding > 0);
  }

  /**
   * Report that a supplier was paid.
   *
   * A CLAIM, not the record: no cash movement, no change to what is owed, until
   * a manager or owner confirms. `clientUuid` is minted once per attempt by the
   * caller and reused across retries, so a timeout cannot record two payments.
   */
  async report(dto: ReportSettlementDto) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const supplier = await this.load(dto.supplierId);

    if (supplier.deletedAt !== null) {
      throw new ConflictException({
        code: 'supplier_inactive',
        message: 'That supplier is no longer active. Reactivate it before recording a payment.',
      });
    }

    const allocations: AllocationInput[] = dto.allocations.map((a) => ({
      purchaseId: a.purchaseId,
      amount: a.amount,
    }));
    const fingerprint = settlementFingerprint({
      supplierId: dto.supplierId,
      amount: dto.amount,
      method: dto.method,
      receivingAccountId: dto.receivingAccountId ?? null,
      allocations,
    });

    const replay = await this.findReplay(dto.clientUuid, fingerprint);
    if (replay) return replay;

    const open = await this.openPurchases(supplier.id);
    assertAllocationFits(dto.amount, allocations, new Map(open.map((p) => [p.purchaseId, p])));

    const account = await this.resolveAccount(dto.method, dto.receivingAccountId, true);
    const userId = this.tenant.userId();

    try {
      const id = newUuidV7Bin();
      await this.db.$transaction(async (tx) => {
        await tx.supplierSettlement.create({
          data: {
            id, companyId, branchId, supplierId: supplier.id,
            status: 'reported',
            amount: dto.amount,
            method: dto.method,
            receivingAccountId: account?.id ?? null,
            accountLabelSnapshot: account?.label ?? null,
            transactionReference: dto.transactionReference ?? null,
            note: dto.note ?? null,
            clientUuid: uuidToBin(dto.clientUuid),
            clientRequestHash: fingerprint,
            reportedById: userId ?? null,
          },
        });
        for (const a of allocations) {
          await tx.supplierSettlementAllocation.create({
            data: {
              id: newUuidV7Bin(), companyId, settlementId: id,
              purchaseId: uuidToBin(a.purchaseId), amount: a.amount,
            },
          });
        }
        await this.audit.recordTx(tx, {
          entityType: 'SupplierSettlement',
          entityId: id,
          action: 'create',
          after: {
            supplier: supplier.name,
            amount: dto.amount,
            method: dto.method,
            account: account?.label ?? null,
            allocations: allocations.length,
          },
          branchId,
        });
      });
      return this.settlement(binToUuid(id));
    } catch (e) {
      // A concurrent replay of the same key loses the unique race; the winner's
      // settlement is the honest answer rather than a conflict.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await this.findReplay(dto.clientUuid, fingerprint);
        if (winner) return winner;
      }
      throw e;
    }
  }

  /** Has this exact request already been recorded? */
  private async findReplay(clientUuid: string, fingerprint: string) {
    const prior = await this.db.supplierSettlement.findFirst({
      where: { companyId: this.tenant.companyId(), clientUuid: uuidToBin(clientUuid) },
    });
    if (!prior) return null;
    if (prior.clientRequestHash !== fingerprint) {
      throw new ConflictException(
        'This request id was already used for a different payment. Start a new one.',
      );
    }
    return this.settlement(binToUuid(prior.id));
  }

  /**
   * Fix how a reported payment was made, before it is confirmed.
   *
   * The amount is never here: a different amount is a different payment, not a
   * correction of this one.
   */
  async correct(idStr: string, dto: CorrectSettlementDto) {
    const companyId = this.tenant.companyId();
    const settlement = await this.loadSettlement(idStr);
    if (settlement.status === 'confirmed') {
      throw new ConflictException({
        code: 'already_confirmed',
        message: 'This payment has been confirmed and cannot be changed.',
      });
    }

    const method = dto.method ?? (settlement.method as 'cash' | 'account');
    const account = await this.resolveAccount(
      method,
      dto.receivingAccountId ??
        (method === 'account' && settlement.receivingAccountId
          ? binToUuid(settlement.receivingAccountId)
          : undefined),
      // Choosing a NEW account needs an active one; keeping the recorded one
      // does not, so deactivating an account cannot strand a payment.
      Boolean(dto.receivingAccountId),
    );

    const allocations: AllocationInput[] | null = dto.allocations
      ? dto.allocations.map((a) => ({ purchaseId: a.purchaseId, amount: a.amount }))
      : null;

    if (allocations) {
      const open = await this.openPurchases(settlement.supplierId);
      assertAllocationFits(num(settlement.amount), allocations, new Map(open.map((p) => [p.purchaseId, p])));
    }

    await this.db.$transaction(async (tx) => {
      const moved = await tx.supplierSettlement.updateMany({
        where: { id: settlement.id, companyId, version: dto.expectedVersion, status: 'reported' },
        data: {
          method,
          receivingAccountId: account?.id ?? null,
          // Re-snapshotted only when the account actually changes; a rename
          // between report and confirmation never rewrites what was recorded.
          ...(dto.receivingAccountId || method === 'cash'
            ? { accountLabelSnapshot: account?.label ?? null }
            : {}),
          ...(dto.transactionReference !== undefined
            ? { transactionReference: dto.transactionReference || null }
            : {}),
          ...(dto.note !== undefined ? { note: dto.note || null } : {}),
          version: { increment: 1 },
        },
      });
      if (moved.count === 0) {
        throw new ConflictException({
          code: 'refresh_required',
          message: 'Someone else changed this payment. Refresh and try again.',
        });
      }
      if (allocations) {
        await tx.supplierSettlementAllocation.deleteMany({ where: { settlementId: settlement.id } });
        for (const a of allocations) {
          await tx.supplierSettlementAllocation.create({
            data: {
              id: newUuidV7Bin(), companyId, settlementId: settlement.id,
              purchaseId: uuidToBin(a.purchaseId), amount: a.amount,
            },
          });
        }
      }
      await this.audit.recordTx(tx, {
        entityType: 'SupplierSettlement',
        entityId: settlement.id,
        action: 'update',
        before: { method: settlement.method, reference: settlement.transactionReference },
        after: { method, account: account?.label ?? null, reference: dto.transactionReference ?? null },
        branchId: settlement.branchId,
      });
    });
    return this.settlement(idStr);
  }

  /**
   * Confirm the payment. This is the authoritative record.
   *
   * Atomic, and in this order for a reason: the version check decides who wins,
   * the day check refuses a closed book, the outstanding re-check runs against
   * COMMITTED rows so two confirmations cannot overpay, and only then does the
   * liability move. **No profit effect** — inventory cost reaches profit through
   * COGS when the goods sell, not when the supplier is paid.
   */
  async confirm(idStr: string, dto: ConfirmSettlementDto) {
    const companyId = this.tenant.companyId();
    const settlement = await this.loadSettlement(idStr);
    if (settlement.status === 'confirmed') {
      throw new ConflictException({
        code: 'already_confirmed',
        message: 'This payment has already been confirmed.',
      });
    }

    const today = new Date();
    const day = new Date(`${today.toISOString().slice(0, 10)}T00:00:00.000Z`);
    const closed = await this.db.dailyClosing.findFirst({
      where: { branchId: settlement.branchId, closingDate: day, isLocked: true },
    });
    if (closed) {
      throw new ConflictException({
        code: 'day_locked',
        message: `${day.toISOString().slice(0, 10)} is already closed for this branch. Confirm this payment tomorrow, or ask the owner to review the closing.`,
      });
    }

    const allocations = await this.db.supplierSettlementAllocation.findMany({
      where: { settlementId: settlement.id },
    });
    const userId = this.tenant.userId();

    await this.db.$transaction(async (tx) => {
      // Re-checked against committed rows, not against what the screen showed.
      const open = await this.openPurchases(settlement.supplierId);
      assertStillPayable(
        allocations.map((a) => ({ purchaseId: binToUuid(a.purchaseId), amount: num(a.amount) })),
        new Map(open.map((p) => [p.purchaseId, p])),
      );

      const moved = await tx.supplierSettlement.updateMany({
        where: { id: settlement.id, companyId, version: dto.expectedVersion, status: 'reported' },
        data: {
          status: 'confirmed',
          confirmedById: userId ?? null,
          confirmedAt: new Date(),
          confirmationDate: day,
          version: { increment: 1 },
        },
      });
      if (moved.count === 0) {
        throw new ConflictException({
          code: 'refresh_required',
          message: 'Someone else acted on this payment. Refresh and try again.',
        });
      }

      /**
       * The stored counter, kept in step. It is a cache: the derived figure is
       * what every screen and decision reads, and a drift test compares them.
       */
      await tx.supplier.update({
        where: { id: settlement.supplierId },
        data: { balance: { decrement: num(settlement.amount) } },
      });

      // The projection on each purchase, recomputed from allocations. The
      // purchase TOTAL is never touched.
      for (const a of allocations) {
        const purchase = await tx.purchase.findUnique({
          where: { id: a.purchaseId },
          select: { total: true },
        });
        const paidRows = await tx.$queryRaw<{ paid: Prisma.Decimal }[]>(Prisma.sql`
          SELECT COALESCE(SUM(al.amount), 0) AS paid
            FROM supplier_settlement_allocations al
            JOIN supplier_settlements st ON st.id = al.settlement_id
           WHERE st.company_id = ${companyId}
             AND st.status = 'confirmed'
             -- Recomputing the purchase's paid status. Without this a delivery
             -- would stay marked paid after the payment covering it was
             -- corrected (Milestone B).
             ${settlementNotCorrected('st')}
             AND al.purchase_id = ${a.purchaseId}`);
        const paid = num(paidRows[0]?.paid);
        await tx.purchase.update({
          where: { id: a.purchaseId },
          data: { amountPaid: paid, status: purchaseStatusOf(num(purchase?.total), paid) },
        });
      }

      await this.audit.recordTx(tx, {
        entityType: 'SupplierSettlement',
        entityId: settlement.id,
        action: 'status_change',
        before: { status: 'reported' },
        after: {
          status: 'confirmed',
          amount: num(settlement.amount),
          method: settlement.method,
          account: settlement.accountLabelSnapshot,
          allocations: allocations.length,
        },
        branchId: settlement.branchId,
      });
    });

    return this.settlement(idStr);
  }

  async settlement(idStr: string) {
    if (!isUuid(idStr)) throw new NotFoundException('Payment not found');
    const s = await this.db.supplierSettlement.findUnique({
      where: { id: uuidToBin(idStr) },
      include: {
        allocations: true,
        reportedBy: { select: { name: true } },
        confirmedBy: { select: { name: true } },
        branch: { select: { name: true } },
        supplier: { select: { id: true, name: true } },
      },
    });
    if (!s) throw new NotFoundException('Payment not found');
    return {
      ...this.settlementView(s),
      supplier: { id: binToUuid(s.supplier.id), name: s.supplier.name },
    };
  }

  /**
   * Confirmed supplier payments for a branch and day — what reconciliation and
   * the closing read. Cash and account are kept apart because only cash left
   * the till.
   */
  async paidOn(branchId: Buffer, date: Date) {
    const rows = await this.db.$queryRaw<{ method: string; total: Prisma.Decimal }[]>(Prisma.sql`
      SELECT method, COALESCE(SUM(amount), 0) AS total
        FROM supplier_settlements
       WHERE company_id = ${this.tenant.companyId()}
         AND branch_id = ${branchId}
         AND status = 'confirmed'
         AND confirmation_date = ${date}
       GROUP BY method`);
    const by = new Map(rows.map((r) => [r.method, num(r.total)]));
    return {
      total: round2((by.get('cash') ?? 0) + (by.get('account') ?? 0)),
      cash: round2(by.get('cash') ?? 0),
    };
  }

  // ──────────────────────────────── helpers ──────────────────────────────────

  private async load(idStr: string) {
    // A malformed id cannot name anything, so it is a 404 — not the 500 that
    // `uuidToBin` throwing would otherwise produce. The returns module already
    // guards this way; suppliers did not, and a live probe found it.
    if (!isUuid(idStr)) throw new NotFoundException('Supplier not found');
    const supplier = await this.db.supplier.findUnique({ where: { id: uuidToBin(idStr) } });
    // Unknown, another company's and a malformed id all answer the same 404.
    if (!supplier) throw new NotFoundException('Supplier not found');
    return supplier;
  }

  private async loadSettlement(idStr: string) {
    if (!isUuid(idStr)) throw new NotFoundException('Payment not found');
    const s = await this.db.supplierSettlement.findUnique({ where: { id: uuidToBin(idStr) } });
    if (!s) throw new NotFoundException('Payment not found');
    return s;
  }

  /** Cash names no account; account names an active one when it is being chosen. */
  private async resolveAccount(
    method: 'cash' | 'account',
    accountId: string | undefined,
    mustBeActive: boolean,
  ) {
    if (method === 'cash') {
      if (accountId) throw new BadRequestException('A cash payment does not name an account');
      return null;
    }
    if (!accountId) throw new BadRequestException('Choose the account the money went from');
    const account = await this.db.receivingAccount.findUnique({ where: { id: uuidToBin(accountId) } });
    if (!account) throw new NotFoundException('Account not found');
    if (mustBeActive && !account.isActive) {
      throw new ConflictException({
        code: 'account_inactive',
        message: 'That account is no longer active. Choose another, or pay in cash.',
      });
    }
    return account;
  }

  private mapDuplicate(e: unknown, name: string): unknown {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return new ConflictException({
        code: 'supplier_exists',
        message: `A supplier called "${name}" already exists. Search for it rather than adding a second one.`,
      });
    }
    return e;
  }
}
