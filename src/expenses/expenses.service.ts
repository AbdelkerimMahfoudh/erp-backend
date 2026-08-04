import { Inject, Injectable } from '@nestjs/common';
import { Expense } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { ROLLUP_QUEUE, RollupQueue } from '../analytics/rollup-queue';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import { dayKey } from '../common/utils/date.util';
import { CreateExpenseDto } from './dto/create-expense.dto';

@Injectable()
export class ExpensesService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    @Inject(ROLLUP_QUEUE) private readonly rollups: RollupQueue,
  ) {}

  async create(dto: CreateExpenseDto): Promise<Expense> {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const spentOnKey = dto.spentOn ?? dayKey(new Date());
    const spentOn = new Date(`${spentOnKey}T00:00:00.000Z`);

    const expense = await this.db.expense.create({
      data: {
        id: newUuidV7Bin(),
        companyId,
        branchId,
        category: dto.category,
        amount: dto.amount,
        spentOn,
        note: dto.note ?? null,
        createdById: this.tenant.userId() ?? null,
      },
    });
    await this.audit.record({
      entityType: 'Expense',
      entityId: expense.id,
      action: 'create',
      after: { category: expense.category, amount: dto.amount },
      branchId,
    });

    // Net profit = gross − expenses(day); refresh the branch-day rollup.
    this.rollups.enqueueDailyRecompute({ companyId, branchId, day: spentOnKey });
    return expense;
  }

  list(date?: string): Promise<Expense[]> {
    const branchId = this.tenant.branchId();
    const where = {
      ...(branchId ? { branchId } : {}),
      ...(date ? { spentOn: new Date(`${date}T00:00:00.000Z`) } : {}),
    };
    return this.db.expense.findMany({ where, orderBy: { spentOn: 'desc' }, take: 200 });
  }
}
