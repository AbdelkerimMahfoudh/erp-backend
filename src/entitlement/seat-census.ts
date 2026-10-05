import type { PrismaClient } from '@prisma/client';
import { binToUuid } from '../common/utils/uuid.util';
import type { BranchSeatUsage } from './entitlement-rules';

/**
 * Who is seated where, and what the shop holds for each store (docs/21,
 * 2026-10-05).
 *
 * One query set shared by entitlement (may one more person be seated?) and
 * billing (what does the shop owe?), so the two can never count differently.
 *
 * Three rules do the work, and each is easy to get wrong:
 *
 *  - **Per store, distinct within it.** A person assigned to two stores holds a
 *    seat at each; a person with two roles at one store holds one. Counting
 *    `user_branches` rows would do the first right and the second wrong.
 *  - **The Owner is never counted.** Charging for the account that pays the
 *    bill would be absurd.
 *  - **Only the living.** Inactive and soft-deleted users, archived stores and
 *    accounts still waiting to be activated hold nothing. A pending account is
 *    `is_active = 0` until the server activates it, so it falls out here by
 *    construction.
 */

/** Any client that can run the two raw queries — the service's, or a transaction's. */
export type CensusClient = Pick<PrismaClient, '$queryRaw' | 'branch'>;

export interface SeatCensus {
  activeBranchCount: number;
  /** Active non-Owner assignments summed over stores. */
  seatsUsed: number;
  branches: BranchSeatUsage[];
}

export async function seatCensus(db: CensusClient, companyId: Buffer): Promise<SeatCensus> {
  const branches = await db.branch.findMany({
    where: { companyId, isActive: true, deletedAt: null },
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  });

  const staff = await db.$queryRaw<{ branch_hex: string; n: bigint }[]>`
    SELECT HEX(ub.branch_id) AS branch_hex, COUNT(DISTINCT u.id) AS n
    FROM users u
    JOIN user_branches ub ON ub.user_id = u.id
    JOIN roles r ON r.id = ub.role_id
    WHERE u.company_id = ${companyId}
      AND u.is_active = 1
      AND u.deleted_at IS NULL
      AND r.\`key\` <> 'owner'
    GROUP BY ub.branch_id
  `;

  const held = await db.$queryRaw<{ branch_hex: string; status: string; n: bigint }[]>`
    SELECT HEX(branch_id) AS branch_hex, status, COUNT(*) AS n
    FROM seat_allocations
    WHERE company_id = ${companyId}
      AND kind = 'seat'
      AND branch_id IS NOT NULL
      AND status IN ('paid', 'granted')
    GROUP BY branch_id, status
  `;

  const staffBy = new Map(staff.map((r) => [r.branch_hex.toLowerCase(), Number(r.n)]));
  const paidBy = new Map<string, number>();
  const grantedBy = new Map<string, number>();
  for (const r of held) {
    const k = r.branch_hex.toLowerCase();
    if (r.status === 'paid') paidBy.set(k, Number(r.n));
    else grantedBy.set(k, Number(r.n));
  }

  const lines: BranchSeatUsage[] = branches.map((b) => {
    const hex = Buffer.from(b.id).toString('hex').toLowerCase();
    return {
      branchId: binToUuid(b.id),
      name: b.name,
      seatsUsed: staffBy.get(hex) ?? 0,
      paidSeats: paidBy.get(hex) ?? 0,
      grantedSeats: grantedBy.get(hex) ?? 0,
    };
  });

  return {
    activeBranchCount: branches.length,
    seatsUsed: lines.reduce((n, l) => n + l.seatsUsed, 0),
    branches: lines,
  };
}
