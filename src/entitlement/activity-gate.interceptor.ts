import {
  BadRequestException,
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
import type { AppClsStore } from '../common/context/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { ACTIVITY_NOT_SUBSCRIBED, activityAllows, activityLabel, type ActivityNeed } from './activity';
import { requiredActivityFor } from './activity-gate';
import { normalise } from './entitlement.interceptor';
import { ENTITLEMENT_WRITE_BLOCKED } from './entitlement-rules';

/**
 * A branch's activity stops a write it is not subscribed to (D156).
 *
 * Registered right after {@link EntitlementInterceptor} and for the same
 * reasons an interceptor: it runs after every guard, so the company, the
 * branch header and the caller's assignment to that branch have all been
 * resolved, and the company-level rules — pending, suspended, expired — have
 * already answered. This one asks a narrower question: is THIS branch
 * subscribed to what THIS route does?
 *
 * One indexed query per gated write, on the branch in context. A gated write
 * with no branch in context is refused with the missing-header answer every
 * branch route gives — never passed through, because a handler that does not
 * read the header itself would then run unchecked (reviewed 2026-10-09). The
 * refusal carries the branch's activity and what the route needed, so the app
 * can say "this branch does not sell" in words.
 */
@Injectable()
export class ActivityGateInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService<AppClsStore>,
    private readonly prisma: PrismaService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return next.handle();

    const req = context.switchToHttp().getRequest<{ method: string; route?: { path?: string } }>();
    const need = requiredActivityFor((req.method ?? 'GET').toUpperCase(), normalise(req.route?.path ?? ''));
    if (!need) return next.handle();

    const companyId = this.cls.get('companyId');
    if (!companyId) {
      // Fail closed, as the entitlement interceptor does: a gated write that
      // reaches here without a company cannot be checked and is not run.
      throw new ForbiddenException({
        code: ENTITLEMENT_WRITE_BLOCKED,
        message: 'This change could not be checked against your subscription.',
      });
    }
    const branchId = this.cls.get('branchId');
    if (!branchId) throw new BadRequestException('X-Branch-Id header is required for this operation');

    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, companyId },
      select: { activity: true },
    });
    // Same wording as the guard, so a caller cannot tell from the message
    // whether the branch exists, only that it is not theirs.
    if (!branch) throw new ForbiddenException('No access to the requested branch');

    if (activityAllows(branch.activity, need)) return next.handle();

    throw new ForbiddenException({
      code: ACTIVITY_NOT_SUBSCRIBED,
      activity: branch.activity,
      required: need,
      message: refusal(need, branch.activity),
    });
  }
}

function refusal(need: ActivityNeed, activity: Parameters<typeof activityLabel>[0]): string {
  const subscribed = activityLabel(activity);
  return need === 'money_agent'
    ? `This branch is not subscribed to money services; it is subscribed to ${subscribed}.`
    : `This branch is not subscribed to the electronics store; it is subscribed to ${subscribed}.`;
}
