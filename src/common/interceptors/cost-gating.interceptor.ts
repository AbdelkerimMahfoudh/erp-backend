import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { AppClsStore } from '../context/request-context';
import { isUuid, uuidToBin } from '../utils/uuid.util';
import { AccessService } from '../../rbac/access.service';
import { stripFinancialFields } from './financial-fields';

/**
 * Global cost/profit authorization. Callers WITHOUT `cost.view` have every
 * financial field (cost, margin, profit, COGS, inventory valuation) stripped
 * from responses — regardless of which endpoint produced them.
 *
 * Permissions are read from CLS when the route already resolved them
 * (`@RequirePermissions`); otherwise they are resolved on demand here, so
 * un-permissioned financial reads (e.g. GET /sales/:id) are still gated.
 * Registered OUTERMOST so it runs after BinaryUuidInterceptor has converted
 * Decimals to numbers.
 */
@Injectable()
export class CostGatingInterceptor implements NestInterceptor {
  constructor(
    private readonly cls: ClsService<AppClsStore>,
    private readonly access: AccessService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const userId = this.cls.get('userId');
    if (!userId) return next.handle(); // unauthenticated → no financial data to gate

    let permissions = this.cls.get('permissions');
    if (!permissions) {
      let branchId = this.cls.get('branchId');
      if (!branchId) {
        const header = context.switchToHttp().getRequest<Request>().headers['x-branch-id'];
        if (typeof header === 'string' && isUuid(header)) branchId = uuidToBin(header);
      }
      permissions = await this.access.getEffectivePermissions(uuidToBin(userId), branchId);
      this.cls.set('permissions', permissions);
    }

    if (permissions.has('cost.view')) return next.handle();
    return next.handle().pipe(map((data) => stripFinancialFields(data)));
  }
}
