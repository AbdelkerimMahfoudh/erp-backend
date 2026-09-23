import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { binToUuid } from '../common/utils/uuid.util';

export interface PartnerRankRow {
  rank: number;
  counterpartyId: string;
  name: string;
  completedTrades: number;
  value: number;
}

export interface PartnerRanking {
  rows: PartnerRankRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Whether this shop has any partner at all — an empty ranking then means "no completed trade yet". */
  partnersExist: boolean;
  generatedAt: string;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * "Most business together" (docs/50 §3.5): every partner this branch has
 * completed a trade with, all time, ordered by the value of those trades.
 *
 * A completed trade is one of exactly two records the existing model already
 * holds with a value attached, and they cannot overlap:
 *
 *   1. a consignment sent from THIS branch that reached `settled` — its value
 *      is the receivable it raised (what the partner's sales of our phones
 *      came to);
 *   2. a sale at this branch whose debtor is a partner store (0074) and which
 *      is fully paid — its value is the sale total.
 *
 * The outright sale of a phone to another store is still not a thing this
 * product records (`docs/21`, contract gap), so it is not counted here rather
 * than approximated. Everything is scoped by the tenant's company and the
 * counterparties it created: nothing of another tenant can appear.
 */
@Injectable()
export class PartnerRankingService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
  ) {}

  async ranking(page = 1, pageSize = 20): Promise<PartnerRanking> {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const size = Math.min(Math.max(pageSize, 1), 50);
    const current = Math.max(page, 1);
    const offset = (current - 1) * size;

    const trades = Prisma.sql`
      SELECT s.counterparty_id AS cp_id, s.total AS value
        FROM sales s
       WHERE s.company_id = ${companyId} AND s.branch_id = ${branchId}
         AND s.counterparty_id IS NOT NULL AND s.is_reversed = 0 AND s.balance_due = 0
      UNION ALL
      SELECT c.counterparty_id,
             COALESCE((SELECT SUM(l.amount) FROM consignment_ledger l
                        WHERE l.consignment_id = c.id AND l.kind = 'receivable_raised'), c.agreed_amount, 0)
        FROM consignments c
       WHERE c.source_company_id = ${companyId} AND c.source_branch_id = ${branchId}
         AND c.status = 'settled'`;

    const [rows, totals, partners] = await Promise.all([
      this.db.$queryRaw<{ id: Buffer; name: string; trades: bigint; value: unknown }[]>(Prisma.sql`
        SELECT cp.id, cp.name, COUNT(*) AS trades, SUM(t.value) AS value
          FROM (${trades}) t
          JOIN counterparties cp ON cp.id = t.cp_id AND cp.company_id = ${companyId}
         GROUP BY cp.id, cp.name
         ORDER BY value DESC, trades DESC, cp.name ASC, cp.id ASC
         LIMIT ${size} OFFSET ${offset}`),
      this.db.$queryRaw<{ total: bigint }[]>(Prisma.sql`
        SELECT COUNT(DISTINCT t.cp_id) AS total FROM (${trades}) t
          JOIN counterparties cp ON cp.id = t.cp_id AND cp.company_id = ${companyId}`),
      this.db.counterparty.count({ where: { isActive: true } }),
    ]);

    return {
      rows: rows.map((r, i) => ({
        rank: offset + i + 1,
        counterpartyId: binToUuid(r.id),
        name: r.name,
        completedTrades: Number(r.trades),
        value: round2(num(r.value)),
      })),
      total: Number(totals[0]?.total ?? 0),
      page: current,
      pageSize: size,
      partnersExist: partners > 0,
      generatedAt: new Date().toISOString(),
    };
  }

  /** The first row alone, for Home. */
  async top(): Promise<{ top: PartnerRankRow | null; partnersExist: boolean; rankedPartners: number }> {
    const r = await this.ranking(1, 1);
    return { top: r.rows[0] ?? null, partnersExist: r.partnersExist, rankedPartners: r.total };
  }
}
