import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../common/audit/audit.service';
import { BusinessDayService } from '../common/business-day/business-day.service';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { binToUuid, isUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';

export const CASH_LOCATION = 'cash';
export const locationOf = (c: { channel: string; accountId: string | null }) => (c.channel === 'cash' ? CASH_LOCATION : c.accountId ?? '');



/**
 * Whether a store treats a money location as dedicated to it (D227). OFF by default, for every location: sales, payment totals
 * and amounts owed carry on, and nothing claims what that cash, wallet or bank actually holds. ON needs an opening amount and
 * its date. Turning it off keeps the row and hides the claim; turning it on again needs a new opening, never the stale one.
 */
@Injectable()
export class MoneyTrackingStore {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly businessDay: BusinessDayService,
  ) {}

  /** The locations this store tracks. Null only where a test builds the closing by hand without the table. */
  async tracked(branchId: Buffer): Promise<Map<string, { openingAmount: number; effectiveDate: string; version: number }> | null> {
    const model = this.db.moneyLocationTracking as TenantPrisma['moneyLocationTracking'] | undefined;
    if (!model) return null;
    const rows = await model.findMany({ where: { branchId, isOn: true } });
    return new Map(rows.map((r) => [r.location, { openingAmount: Number(r.openingAmount), effectiveDate: r.effectiveDate!.toISOString().slice(0, 10), version: r.version }]));
  }

  async set(input: { location: string; on: boolean; openingAmount?: number; effectiveDate?: string; expectedVersion?: number }) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    if (input.location !== CASH_LOCATION) {
      const account = isUuid(input.location) ? await this.db.receivingAccount.findFirst({ where: { id: uuidToBin(input.location) }, select: { id: true } }) : null;
      if (!account) throw new BadRequestException({ code: 'location_unknown', message: 'That money location does not exist.' });
    }
    if (input.on) {
      if (input.openingAmount == null || !input.effectiveDate) {
        throw new BadRequestException({ code: 'opening_required', message: 'Enter the opening balance and its date.' });
      }
      if (input.effectiveDate > (await this.businessDay.today(branchId))) {
        throw new BadRequestException({ code: 'date_in_future', message: 'The date cannot be in the future.' });
      }
    }
    const current = await this.db.moneyLocationTracking.findFirst({ where: { branchId, location: input.location } });
    if (input.expectedVersion !== undefined && (current?.version ?? 0) !== input.expectedVersion) {
      throw new ConflictException({ code: 'stale_version', message: 'Someone changed this first. Look again.' });
    }
    const data = input.on
      ? { isOn: true, openingAmount: new Prisma.Decimal(input.openingAmount!.toFixed(2)), effectiveDate: new Date(`${input.effectiveDate}T00:00:00.000Z`), updatedById: this.tenant.userId() ?? null }
      : // The figures stay for the record, and are read only while it is on.
        { isOn: false, updatedById: this.tenant.userId() ?? null };
    await this.db.$transaction(async (tx) => {
      const id = current?.id ?? newUuidV7Bin();
      if (current) {
        const moved = await tx.moneyLocationTracking.updateMany({ where: { id, version: current.version }, data: { ...data, version: { increment: 1 } } });
        if (!moved.count) throw new ConflictException({ code: 'stale_version', message: 'Someone changed this first. Look again.' });
      } else {
        await tx.moneyLocationTracking.create({ data: { id, companyId, branchId, location: input.location, ...data } });
      }
      await this.audit.recordTx(tx, {
        entityType: 'MoneyLocationTracking',
        entityId: id,
        action: 'update',
        before: current ? { on: current.isOn, openingAmount: Number(current.openingAmount ?? 0), effectiveDate: current.effectiveDate?.toISOString().slice(0, 10) ?? null } : { on: false },
        after: { location: input.location === CASH_LOCATION ? CASH_LOCATION : binToUuid(uuidToBin(input.location)), on: input.on, ...(input.on ? { openingAmount: input.openingAmount, effectiveDate: input.effectiveDate } : {}) },
        branchId,
      });
    });
  }

}
