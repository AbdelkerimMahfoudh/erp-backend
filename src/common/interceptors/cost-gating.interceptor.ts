import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { AppClsStore } from '../context/request-context';
import { uuidToBin } from '../utils/uuid.util';
import { AccessService } from '../../rbac/access.service';
import { stripFinancialFields } from './financial-fields';

/**
 * Global cost/profit authorization. Callers WITHOUT `cost.view` have every
 * financial field (cost, margin, profit, COGS, inventory valuation) stripped
 * from responses — regardless of which endpoint produced them.
 *
 * Permissions are read from CLS when the route already resolved them
 * (`@RequirePermissions`); otherwise they are resolved on demand here, so
 * un-permissioned financial reads (e.g. GET /sales/:id) are still gated. If that
 * resolution fails it gates as strictly as possible rather than failing the
 * request — see below.
 * Registered OUTERMOST so it runs after BinaryUuidInterceptor has converted
 * Decimals to numbers.
 */
@Injectable()
export class CostGatingInterceptor implements NestInterceptor {
  constructor(
    private readonly cls: ClsService<AppClsStore>,
    private readonly access: AccessService,
  ) {}

  async intercept(_context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const userId = this.cls.get('userId');
    if (!userId) return next.handle(); // unauthenticated → no financial data to gate

    let permissions = this.cls.get('permissions');
    if (!permissions) {
      // The active branch comes from the CLS middleware, which runs for every
      // request. This interceptor no longer parses the header itself: two places
      // reading the same header is exactly how they drift apart.
      const branchId = this.cls.get('branchId');
      try {
        permissions = await this.access.getEffectivePermissions(uuidToBin(userId), branchId);
        this.cls.set('permissions', permissions);
      } catch {
        /**
         * Resolution failed — almost always a branch the user is no longer
         * assigned to, still remembered by a restored session.
         *
         * Cost gating must NOT turn that into a 403 for the whole request. This
         * interceptor's job is to strip financial fields, not to decide
         * authorization; guards run before it and have already rejected anything
         * genuinely branch-scoped. Letting it throw here made unguarded routes
         * fail too — including `GET /auth/branches`, the one screen a user with a
         * stale branch needs in order to pick a different one. That was a
         * lock-out with no way back.
         *
         * So: degrade to the strictest possible gating (no `cost.view`, strip
         * everything financial) and do not cache it, since it is not the user's
         * real permission set.
         */
        permissions = new Set<string>();
      }
    }

    if (permissions.has('cost.view')) return next.handle();
    return next.handle().pipe(map((data) => stripFinancialFields(data)));
  }
}
