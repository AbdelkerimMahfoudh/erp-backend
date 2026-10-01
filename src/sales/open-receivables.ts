import type { TenantPrisma } from '../prisma/tenant.extension';

/**
 * What customers and partner stores owe this branch right now: every sale with a balance
 * still due (0074), whatever day it was made. The Money overview's "owed to us" and the
 * report documents (docs/66) both read it here, so the two can never print different sums.
 *
 * A point-in-time figure, not a period one: a balance from March is still owed in October.
 */
export async function openReceivables(db: Pick<TenantPrisma, 'sale'>, branchId: Buffer): Promise<{ amount: number; sales: number }> {
  const owed = await db.sale.aggregate({
    where: { branchId, isReversed: false, balanceDue: { gt: 0 } },
    _sum: { balanceDue: true },
    _count: true,
  });
  return { amount: Math.round(Number(owed._sum.balanceDue ?? 0) * 100) / 100, sales: owed._count };
}
