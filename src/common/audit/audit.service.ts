import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { TENANT_PRISMA } from '../../prisma/prisma.module';
import { TenantPrisma } from '../../prisma/tenant.extension';
import { TenantContext } from '../tenant/tenant-context.service';

export interface AuditParams {
  entityType: string;
  entityId?: Buffer;
  action: AuditAction;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  reason?: string;
  branchId?: Buffer;
  ip?: string;
}

/** Minimal client shape usable by both the base tenant client and a tx client. */
type AuditClient = Pick<TenantPrisma, 'auditLog'>;

/**
 * Writes append-only `audit_logs`. `record` uses the request-scoped tenant
 * client; `recordTx` accepts a transaction client so the audit row commits in
 * the SAME transaction as the audited change. `company_id`/`user_id` come from
 * context (passed explicitly — defense in depth).
 */
@Injectable()
export class AuditService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
  ) {}

  record(params: AuditParams): Promise<void> {
    return this.write(this.db, params);
  }

  recordTx(tx: AuditClient, params: AuditParams): Promise<void> {
    return this.write(tx, params);
  }

  private async write(client: AuditClient, p: AuditParams): Promise<void> {
    await client.auditLog.create({
      data: {
        companyId: this.tenant.companyId(),
        branchId: p.branchId ?? this.tenant.branchId() ?? null,
        userId: this.tenant.userId() ?? null,
        entityType: p.entityType,
        entityId: p.entityId ?? null,
        action: p.action,
        before: p.before,
        after: p.after,
        reason: p.reason ?? null,
        ip: p.ip ?? null,
      },
    });
  }
}
