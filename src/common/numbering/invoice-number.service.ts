import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantContext } from '../tenant/tenant-context.service';

/**
 * Gap-free, concurrency-safe per-branch sequences via `branch_counters`. Called
 * INSIDE a transaction so the row lock serializes concurrent generation for a
 * branch. Uses raw SQL for an atomic upsert-and-increment (the tenant extension
 * does not touch raw queries, so company/branch are bound explicitly).
 */
@Injectable()
export class InvoiceNumberService {
  constructor(private readonly tenant: TenantContext) {}

  /**
   * Reserve and return the next sequence for (branch, kind) within `tx`.
   * `format` receives the numeric sequence and returns the display string.
   */
  async next(
    tx: Prisma.TransactionClient,
    branchId: Buffer,
    kind = 'invoice',
    format: (seq: number) => string = (seq) => String(seq).padStart(5, '0'),
  ): Promise<string> {
    const companyId = this.tenant.companyId();

    await tx.$executeRaw`
      INSERT INTO branch_counters (company_id, branch_id, kind, seq, updated_at)
      VALUES (${companyId}, ${branchId}, ${kind}, 1, NOW(6))
      ON DUPLICATE KEY UPDATE seq = seq + 1, updated_at = NOW(6)`;

    const rows = await tx.$queryRaw<Array<{ seq: bigint }>>`
      SELECT seq FROM branch_counters WHERE branch_id = ${branchId} AND kind = ${kind}`;

    return format(Number(rows[0].seq));
  }
}
