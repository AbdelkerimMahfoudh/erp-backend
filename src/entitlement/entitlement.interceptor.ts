import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { Observable } from 'rxjs';
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
 * ## Why an interceptor and not a guard
 *
 * This was written as a global guard first, and the live run refused **every**
 * write through its fail-closed branch. Global guards run in registration
 * order, and this one ran before `JwtAuthGuard`, so no company had been
 * resolved by the time it asked.
 *
 * Interceptors are guaranteed by the request lifecycle to run *after* every
 * guard, so authentication and tenant resolution have both happened. That is a
 * property of the framework rather than of module import order, which is what
 * makes it safe to depend on.
 *
 * It still fails closed: a mutation arriving with no company is refused rather
 * than waved through, so a future change that breaks the ordering again
 * produces the same loud failure instead of a silent bypass.
 */
@Injectable()
export class EntitlementInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlement: EntitlementService,
    private readonly cls: ClsService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return next.handle();

    const req = context.switchToHttp().getRequest<{ method: string; route?: { path?: string } }>();
    const method = (req.method ?? 'GET').toUpperCase();

    /*
     * Reads.
     *
     * **Expiry still blocks nothing**, and that rule has not moved: a shop
     * locked out of yesterday's sales reaches for the notebook immediately, and
     * would be right to.
     *
     * Two states are different, and both are decisions rather than drift:
     * a business that has never been activated has no operational history to
     * withhold — opening the till to it would be a free trial by accident — and
     * a suspended one was stopped deliberately, with a recorded reason. The
     * Owner keeps the customer portal in both, so nobody is ever locked out of
     * finding out why.
     */
    if (!isMutation(method)) {
      const companyId = this.cls.get<Buffer | undefined>('companyId');
      if (!companyId) return next.handle();

      const blocked = await this.entitlement.operationalAccessBlocked(companyId);
      if (!blocked) return next.handle();

      throw new ForbiddenException({
        code: blocked.code,
        message: blocked.message,
        state: blocked.state,
      });
    }

    const path = normalise(req.route?.path ?? '');
    if (isAllowedWhenExpired(method, path)) return next.handle();

    const companyId = this.cls.get<Buffer | undefined>('companyId');
    if (!companyId) {
      throw new ForbiddenException({
        code: ENTITLEMENT_WRITE_BLOCKED,
        message: 'This change could not be checked against your subscription.',
      });
    }

    if (await this.entitlement.mayWrite(companyId)) return next.handle();

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
