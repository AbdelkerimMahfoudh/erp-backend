import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../common/audit/audit.service';
import { BusinessDayService } from '../common/business-day/business-day.service';
import { ClosingService } from '../closing/closing.service';
import { AppClsStore } from '../common/context/request-context';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { binToUuid, isUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';

export interface RecordMaintenanceInput {
  clientUuid: string;
  description: string;
  repairCost: number;
  customerPaid: number;
  paidMethod?: 'cash' | 'account';
  paidAccountId?: string;
  costMethod?: 'cash' | 'account';
  costAccountId?: string;
  businessDate?: string;
  note?: string;
  /** Both zero is recorded only when the person says so. */
  confirmZero?: boolean;
}

const money = (n: number) => new Prisma.Decimal(n.toFixed(2));
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Maintenance income (D227): money from a repair, on its own. It is never a sale, touches no stock and no item sold, and has
 * its own lines in the closing. A record commits whole, once per request id. It is never edited: a correction is a reversing
 * entry dated the day it is made, so a closed day keeps the figures it was closed on.
 */
@Injectable()
export class MaintenanceService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly closing: ClosingService,
    private readonly businessDay: BusinessDayService,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  async record(input: RecordMaintenanceInput) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.userId();
    const description = input.description?.trim();
    if (!description) throw new BadRequestException({ code: 'description_required', message: 'Say what was repaired.' });
    const { repairCost: cost, customerPaid: paid } = input;
    if (cost === 0 && paid === 0 && !input.confirmZero) {
      throw new BadRequestException({ code: 'zero_needs_confirmation', message: 'Both amounts are zero. Confirm to record it anyway.' });
    }
    if (paid > 0 && !input.paidMethod) throw new BadRequestException({ code: 'paid_destination_required', message: 'Say where the payment went.' });
    if (cost > 0 && !input.costMethod) throw new BadRequestException({ code: 'cost_source_required', message: 'Say where the cost was paid from.' });

    const clientUuid = uuidToBin(input.clientUuid);
    const hash = createHash('sha256').update(JSON.stringify([description, cost, paid, input.paidMethod, input.paidAccountId, input.costMethod, input.costAccountId, input.businessDate, input.note ?? null])).digest('hex');
    const replay = await this.db.maintenanceRecord.findFirst({ where: { companyId, clientUuid } });
    if (replay) {
      if (replay.requestHash !== hash) throw new ConflictException({ code: 'idempotency_conflict', message: 'That request id was already used with different details.' });
      return this.view(replay);
    }

    const today = await this.businessDay.today(branchId);
    const day = input.businessDate ?? today;
    if (day > today) throw new BadRequestException({ code: 'date_in_future', message: 'The date cannot be in the future.' });
    const paidAccount = paid > 0 ? await this.account(input.paidMethod!, input.paidAccountId) : null;
    const costAccount = cost > 0 ? await this.account(input.costMethod!, input.costAccountId) : null;

    await this.closing.assertCounterOpen(branchId, 'payment');
    const id = newUuidV7Bin();
    try {
      await this.db.$transaction(async (tx) => {
        // A closed day is refused under its lock, and the day's money version moves with the entry.
        await this.closing.lockDayForMoneyTx(tx as never, { branchId, businessDate: day, operation: 'backdated_payment' });
        await tx.maintenanceRecord.create({
          data: {
            id,
            companyId,
            branchId,
            businessDate: new Date(`${day}T00:00:00.000Z`),
            description: description.slice(0, 200),
            repairCost: money(cost),
            customerPaid: money(paid),
            paidMethod: paid > 0 ? input.paidMethod : null,
            paidAccountId: paidAccount?.id ?? null,
            paidLabel: paidAccount?.label ?? null,
            costMethod: cost > 0 ? input.costMethod : null,
            costAccountId: costAccount?.id ?? null,
            costLabel: costAccount?.label ?? null,
            note: input.note?.trim().slice(0, 500) || null,
            createdById: userId ?? null,
            clientUuid,
            requestHash: hash,
          },
        });
        await this.audit.recordTx(tx, { entityType: 'MaintenanceRecord', entityId: id, action: 'create', after: { repairCost: cost, customerPaid: paid, businessDate: day }, branchId });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const twin = await this.db.maintenanceRecord.findFirst({ where: { companyId, clientUuid } });
        if (twin?.requestHash === hash) return this.view(twin);
      }
      throw e;
    }
    return this.view(await this.db.maintenanceRecord.findUniqueOrThrow({ where: { id } }));
  }

  /** The correction: the same amounts with the opposite sign, today. Once per record, with the established authority. */
  async reverse(idStr: string, reason: string, clientUuid: string) {
    if (!this.cls.get('permissions')?.has('financial.correction.approve')) throw new ForbiddenException('Only someone who approves corrections may reverse this.');
    const why = reason?.trim();
    if (!why) throw new BadRequestException({ code: 'reason_required', message: 'Say why.' });
    const branchId = this.tenant.requireBranchId();
    const companyId = this.tenant.companyId();
    const original = isUuid(idStr) ? await this.db.maintenanceRecord.findFirst({ where: { id: uuidToBin(idStr), branchId } }) : null;
    if (!original) throw new NotFoundException('No such record');
    if (original.reversesId) throw new ConflictException({ code: 'is_reversal', message: 'This entry is itself a reversal.' });
    const key = uuidToBin(clientUuid);
    const replay = await this.db.maintenanceRecord.findFirst({ where: { companyId, reversesId: original.id } });
    if (replay) return this.view(replay);

    const day = await this.businessDay.today(branchId);
    await this.closing.assertCounterOpen(branchId, 'payment');
    const id = newUuidV7Bin();
    try {
      await this.db.$transaction(async (tx) => {
        await this.closing.lockDayForMoneyTx(tx as never, { branchId, businessDate: day, operation: 'backdated_payment' });
        await tx.maintenanceRecord.create({
          data: {
            id,
            companyId,
            branchId,
            businessDate: new Date(`${day}T00:00:00.000Z`),
            description: original.description,
            repairCost: original.repairCost.negated(),
            customerPaid: original.customerPaid.negated(),
            paidMethod: original.paidMethod,
            paidAccountId: original.paidAccountId,
            paidLabel: original.paidLabel,
            costMethod: original.costMethod,
            costAccountId: original.costAccountId,
            costLabel: original.costLabel,
            note: why.slice(0, 500),
            createdById: this.tenant.userId() ?? null,
            clientUuid: key,
            requestHash: 'reversal',
            reversesId: original.id,
          },
        });
        await this.audit.recordTx(tx, { entityType: 'MaintenanceRecord', entityId: id, action: 'create', after: { reverses: idStr }, reason: why, branchId });
      });
    } catch (e) {
      // Unique per record: two reversals at once make one.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const twin = await this.db.maintenanceRecord.findFirst({ where: { companyId, reversesId: original.id } });
        if (twin) return this.view(twin);
      }
      throw e;
    }
    return this.view(await this.db.maintenanceRecord.findUniqueOrThrow({ where: { id } }));
  }

  /** History with its totals, newest first. The totals are of the whole range, net of reversals, never of one page. */
  async list(query: { from?: string; to?: string }) {
    const branchId = this.tenant.requireBranchId();
    const where: Prisma.MaintenanceRecordWhereInput = {
      branchId,
      ...(query.from || query.to
        ? { businessDate: { ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}), ...(query.to ? { lte: new Date(`${query.to}T00:00:00.000Z`) } : {}) } }
        : {}),
    };
    const [rows, sum] = await Promise.all([
      this.db.maintenanceRecord.findMany({ where, orderBy: { id: 'desc' }, take: 100 }),
      this.db.maintenanceRecord.aggregate({ where, _sum: { repairCost: true, customerPaid: true } }),
    ]);
    const revenue = Number(sum._sum.customerPaid ?? 0);
    const cost = Number(sum._sum.repairCost ?? 0);
    return { rows: rows.map((r) => this.view(r)), totals: { revenue, cost, profit: round2(revenue - cost) } };
  }

  async get(idStr: string) {
    const row = isUuid(idStr) ? await this.db.maintenanceRecord.findFirst({ where: { id: uuidToBin(idStr), branchId: this.tenant.requireBranchId() } }) : null;
    if (!row) throw new NotFoundException('No such record');
    const reversal = row.reversesId ? null : await this.db.maintenanceRecord.findFirst({ where: { reversesId: row.id }, select: { id: true } });
    return { ...this.view(row), reversedBy: reversal ? binToUuid(reversal.id) : null };
  }

  private async account(method: 'cash' | 'account', id?: string) {
    if (method === 'cash') return null;
    if (!id || !isUuid(id)) throw new BadRequestException({ code: 'account_required', message: 'Choose the account.' });
    const account = await this.db.receivingAccount.findFirst({ where: { id: uuidToBin(id), isActive: true }, select: { id: true, label: true } });
    if (!account) throw new BadRequestException({ code: 'account_required', message: 'Choose the account.' });
    return account;
  }

  private view(r: { id: Buffer; businessDate: Date; description: string; repairCost: Prisma.Decimal; customerPaid: Prisma.Decimal; paidMethod: string | null; paidLabel: string | null; costMethod: string | null; costLabel: string | null; note: string | null; reversesId: Buffer | null; createdAt: Date }) {
    const paid = Number(r.customerPaid);
    const cost = Number(r.repairCost);
    return {
      id: binToUuid(r.id),
      businessDate: r.businessDate.toISOString().slice(0, 10),
      description: r.description,
      customerPaid: paid,
      repairAmount: cost,
      profit: round2(paid - cost),
      paidMethod: r.paidMethod,
      paidLabel: r.paidLabel,
      costMethod: r.costMethod,
      costLabel: r.costLabel,
      note: r.note,
      reversesId: r.reversesId ? binToUuid(r.reversesId) : null,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
