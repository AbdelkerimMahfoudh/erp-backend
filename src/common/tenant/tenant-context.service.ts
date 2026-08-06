import { BadRequestException, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AppClsStore } from '../context/request-context';
import { MissingTenantContextError } from '../../prisma/tenant.extension';
import { uuidToBin } from '../utils/uuid.util';

/**
 * Typed accessor for the request's tenant context (company/branch/user) from CLS.
 * Fail-closed: reading the company id without a context throws (same posture as
 * the tenant Prisma extension). Used to pass `company_id` explicitly on
 * transactional operations (defense in depth).
 */
@Injectable()
export class TenantContext {
  constructor(private readonly cls: ClsService<AppClsStore>) {}

  companyId(): Buffer {
    const companyId = this.cls.get('companyId');
    if (!companyId) {
      throw new MissingTenantContextError('(request)', 'companyId');
    }
    return companyId;
  }

  branchId(): Buffer | undefined {
    return this.cls.get('branchId');
  }

  /** Branch id or a 400 — for branch-scoped operations that require `X-Branch-Id`. */
  requireBranchId(): Buffer {
    const branchId = this.branchId();
    if (!branchId) {
      throw new BadRequestException('X-Branch-Id header is required for this operation');
    }
    return branchId;
  }

  userId(): Buffer | undefined {
    const userId = this.cls.get('userId');
    return userId ? uuidToBin(userId) : undefined;
  }

  /**
   * The acting user, for columns that must record WHO did something and are
   * NOT NULL — `user_branch_permissions.granted_by_id`, for one.
   *
   * Fail-closed like {@link companyId}: an authenticated route always has a
   * user, so its absence is a programming error (a query issued outside a
   * request), not a client mistake.
   */
  requireUserId(): Buffer {
    const userId = this.userId();
    if (!userId) {
      throw new MissingTenantContextError('(request)', 'userId');
    }
    return userId;
  }
}
