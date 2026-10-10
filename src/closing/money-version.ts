import { Prisma } from '@prisma/client';
import type { TenantPrisma } from '../prisma/tenant.extension';

/**
 * The day's money version (0091, D159, docs/73 §11.2).
 *
 * Every write that moves money on a business day bumps that day's `daily_closings.money_version`, inside its own
 * transaction and under the row lock the close takes. The close reads the version with its report and again under
 * its own lock: money that landed in between is never closed silently, whatever it did to a count or a sum. A day
 * with no row yet has nothing to bump — nobody has counted or closed it, and the close's own report will read the
 * money.
 */

type Writer = Pick<TenantPrisma, '$executeRaw'>;

/** The business day the money lands on. */
export async function bumpMoneyVersionTx(tx: Writer, a: { companyId: Buffer; branchId: Buffer; businessDate: string }): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    UPDATE daily_closings SET money_version = money_version + 1
     WHERE company_id = ${a.companyId} AND branch_id = ${a.branchId} AND closing_date = ${a.businessDate}`);
}

/**
 * Every later day of the branch still open: money dated on an earlier day moves the opening of each day after it,
 * because the drawer is carried from day to day. A locked day keeps the version it was closed on — its figures are
 * the ones it was closed with.
 */
export async function bumpLaterOpenDaysTx(tx: Writer, a: { companyId: Buffer; branchId: Buffer; after: string }): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    UPDATE daily_closings SET money_version = money_version + 1
     WHERE company_id = ${a.companyId} AND branch_id = ${a.branchId} AND closing_date > ${a.after} AND status <> 'locked'`);
}
