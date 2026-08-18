import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { EntitlementService } from './entitlement.service';
import { ENTITLEMENT_WRITE_BLOCKED } from './entitlement-rules';
import { isAllowedWhenExpired, isMutation } from './route-classification';

/**
 * One place where a lapsed subscription stops a write (Milestone K).
 *
 * Central rather than scattered across twenty-eight controllers: scattered
 * checks cannot be audited and are trivially forgotten on the next endpoint —
 * and the endpoint somebody forgets will be the one that moves money.
 *
 * ## Ordering, and why this cannot fail open
 *
 * Entitlement needs a resolved company, so this must run after the JWT guard.
 * It does today, because `AuthModule` is imported before `app.module`'s own
 * providers. Relying on that silently would be a mistake: if the order ever
 * changed, a guard that saw no company would wave everything through.
 *
 * So a mutation that reaches here with no company is **refused**, not skipped.
 * Wrong ordering produces a loud failure rather than a quiet bypass.
 */
@Injectable()
export class EntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlement: EntitlementService,
    private readonly cls: ClsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<{ method: string; route?: { path?: string } }>();
    const method = (req.method ?? 'GET').toUpperCase();

    // Reads are never blocked. A shop locked out of yesterday's sales reaches
    // for the notebook immediately, and would be right to.
    if (!isMutation(method)) return true;

    const path = normalise(req.route?.path ?? '');
    if (isAllowedWhenExpired(method, path)) return true;

    const companyId = this.cls.get<Buffer | undefined>('companyId');
    if (!companyId) {
      // Fail closed. See the ordering note above.
      throw new ForbiddenException({
        code: ENTITLEMENT_WRITE_BLOCKED,
        message: 'This change could not be checked against your subscription.',
      });
    }

    if (await this.entitlement.mayWrite(companyId)) return true;

    throw new ForbiddenException({
      code: ENTITLEMENT_WRITE_BLOCKED,
      message: 'Your subscription has ended. You can still read and export everything.',
    });
  }
}

/**
 * Nest reports `/api/v1/loans/:id/payment`; the classification is written as
 * `loans/:id/payment`. Strip the prefix and version so the two line up.
 */
export function normalise(routePath: string): string {
  return routePath
    .replace(/^\/+/, '')
    .replace(/^api\//, '')
    .replace(/^v\d+\//, '')
    .replace(/\/+$/, '');
}
