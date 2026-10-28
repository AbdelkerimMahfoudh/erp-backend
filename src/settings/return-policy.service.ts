import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { assertAssignedToBranch } from '../rbac/active-branch';
import { binToUuid } from '../common/utils/uuid.util';
import { RETURN_WINDOW_NONE } from './settings.constants';
import { isPolicyLanguage, normalisePolicyText, policyTextProblem, type PolicyLanguage } from './return-policy-rules';
import { UpdateReturnPolicyDto } from './dto/update-return-policy.dto';

/** What a sale sells under, and what Settings shows: the branch's policy, or the company's window. */
export interface EffectivePolicy {
  windowHours: number;
  textEn: string | null;
  textFr: string | null;
  textAr: string | null;
  defaultLanguage: PolicyLanguage;
  /** The branch policy's version; null when the branch has none and the company window applies. */
  version: number | null;
}

interface PolicyReader {
  branchReturnPolicy: { findFirst(args: unknown): Promise<{ windowHours: number; textEn: string | null; textFr: string | null; textAr: string | null; defaultLanguage: string; version: number } | null> };
  companySettings: { findUnique(args: unknown): Promise<{ returnWindowHours: number } | null> };
}

/**
 * The policy a sale at this branch is sold under, read inside the sale's transaction.
 *
 * The branch's own row when it has one; otherwise the company's window with no
 * written conditions — exactly what every sale before 0108 carried. The client
 * never decides it.
 */
export async function effectivePolicy(db: PolicyReader, companyId: Buffer, branchId: Buffer): Promise<EffectivePolicy> {
  const own = await db.branchReturnPolicy.findFirst({ where: { companyId, branchId } });
  if (own) {
    return {
      windowHours: own.windowHours,
      textEn: own.textEn,
      textFr: own.textFr,
      textAr: own.textAr,
      defaultLanguage: isPolicyLanguage(own.defaultLanguage) ? own.defaultLanguage : 'en',
      version: own.version,
    };
  }
  const company = await db.companySettings.findUnique({ where: { companyId }, select: { returnWindowHours: true } });
  return { windowHours: company?.returnWindowHours ?? RETURN_WINDOW_NONE, textEn: null, textFr: null, textAr: null, defaultLanguage: 'en', version: null };
}

/**
 * A branch's return policy (0108, the owner's brief of 2026-10-28).
 *
 * Any Owner, Store Manager or Store Employee assigned to the branch may change
 * it (`return.policy.edit`, checked at the route; the assignment here). Every
 * change is audited with who, which company and branch, the values before and
 * after, the languages changed and whether the window changed. It applies to
 * future sales only: each sale snapshotted its own at confirmation.
 */
@Injectable()
export class ReturnPolicyService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
  ) {}

  async read() {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    // Only a branch this person works in — the same refusal an edit meets.
    await assertAssignedToBranch(this.db, this.tenant.requireUserId(), branchId);
    const policy = await effectivePolicy(this.db as unknown as PolicyReader, companyId, branchId);
    return { branchId: binToUuid(branchId), ...policy, ownPolicy: policy.version !== null };
  }

  async update(dto: UpdateReturnPolicyDto) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.requireUserId();
    // Only a branch this person is assigned to — another branch's or company's policy is refused.
    await assertAssignedToBranch(this.db, userId, branchId);

    const texts = { textEn: normalisePolicyText(dto.textEn), textFr: normalisePolicyText(dto.textFr), textAr: normalisePolicyText(dto.textAr) };
    for (const [field, value] of Object.entries(texts)) {
      const problem = policyTextProblem(value);
      if (problem) {
        throw new BadRequestException({
          code: problem === 'html' ? 'policy_text_markup' : 'policy_text_too_long',
          message: problem === 'html' ? 'Write the conditions as plain text, without markup.' : 'The conditions are too long (1000 characters at most).',
          policyField: field,
        });
      }
    }
    if (!isPolicyLanguage(dto.defaultLanguage)) throw new BadRequestException({ code: 'policy_language', message: 'Choose English, French or Arabic.' });
    const next = { windowHours: dto.windowHours, ...texts, defaultLanguage: dto.defaultLanguage };

    return this.db.$transaction(async (tx) => {
      const before = await effectivePolicy(tx as unknown as PolicyReader, companyId, branchId);
      if (dto.expectedVersion !== undefined && before.version !== null && dto.expectedVersion !== before.version) {
        throw new ConflictException({ code: 'policy_changed', message: 'Someone changed this policy meanwhile. It was reloaded — check it and save again.' });
      }
      const unchanged =
        before.windowHours === next.windowHours &&
        before.textEn === next.textEn &&
        before.textFr === next.textFr &&
        before.textAr === next.textAr &&
        before.defaultLanguage === next.defaultLanguage &&
        before.version !== null;
      if (unchanged) return { branchId: binToUuid(branchId), ...before, ownPolicy: true, changed: false };

      const version = (before.version ?? 0) + 1;
      if (before.version === null) {
        await tx.branchReturnPolicy.create({ data: { branchId, companyId, ...next, version, updatedById: userId } });
      } else {
        const moved = await tx.branchReturnPolicy.updateMany({ where: { branchId, version: before.version }, data: { ...next, version, updatedById: userId } });
        if (moved.count !== 1) throw new ConflictException({ code: 'policy_changed', message: 'Someone changed this policy meanwhile. It was reloaded — check it and save again.' });
      }
      const field = { en: 'textEn', fr: 'textFr', ar: 'textAr' } as const;
      const languagesChanged = (['en', 'fr', 'ar'] as const).filter((l) => before[field[l]] !== next[field[l]]);
      await this.audit.recordTx(tx, {
        entityType: 'BranchReturnPolicy',
        entityId: branchId,
        action: 'update',
        before: before as unknown as Prisma.InputJsonValue,
        after: { ...next, version } as unknown as Prisma.InputJsonValue,
        reason: `Return policy changed: ${[
          before.windowHours !== next.windowHours ? `window ${before.windowHours}h → ${next.windowHours}h` : null,
          languagesChanged.length ? `conditions (${languagesChanged.join(', ')})` : null,
          before.defaultLanguage !== next.defaultLanguage ? `default language ${before.defaultLanguage} → ${next.defaultLanguage}` : null,
        ]
          .filter(Boolean)
          .join('; ') || 'first branch policy'}`,
        branchId,
      });
      return { branchId: binToUuid(branchId), ...next, version, ownPolicy: true, changed: true, languagesChanged, windowChanged: before.windowHours !== next.windowHours };
    });
  }
}
