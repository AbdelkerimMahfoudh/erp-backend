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
import { BranchEntitlementService } from './branch-entitlement.service';
import { isUuid, uuidToBin } from '../common/utils/uuid.util';
import { ENTITLEMENT_WRITE_BLOCKED } from './entitlement-rules';
import { isAllowedWhenExpired, isAlwaysReadable, isMutation } from './route-classification';

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
    private readonly branches: BranchEntitlementService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return next.handle();

    const req = context.switchToHttp().getRequest<{ method: string; route?: { path?: string }; params?: Record<string, unknown>; body?: unknown }>();
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
      /*
       * The limited account surface stays open in every state.
       *
       * Blocking these would be self-defeating: `/entitlement` is precisely how
       * the app learns it is pending or suspended, so refusing it would leave
       * the client unable to show the screen explaining the refusal. A shop
       * locked out with no way to find out why would reach for the phone, and
       * be right to.
       */
      if (isAlwaysReadable(normalise(req.route?.path ?? ''))) return next.handle();

      const companyId = this.cls.get<Buffer | undefined>('companyId');
      if (!companyId) return next.handle();

      // 0132 (docs/122): each store is its own subscription — a read of a branch asks that branch.
      if (this.branches.mode === 'enforce') {
        const refused = await this.branchRead(companyId);
        if (!refused) return next.handle();
        throw new ForbiddenException(refused);
      }
      // Shadow keeps every legacy store's access, but never opens a store that was never opened (owner, 2026-11-07).
      if (this.branches.mode === 'shadow') {
        const neverOpened = await this.lockedBranchNamed(companyId, [this.cls.get<Buffer | undefined>('branchId')]);
        if (neverOpened) throw new ForbiddenException(neverOpened);
      }

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

    // 0132 (docs/122): the branch the request works in, and every other branch it names, must each be able to write.
    if (this.branches.mode !== 'off') {
      const branchRefused = await this.branchWrite(companyId, req);
      if (this.branches.mode === 'enforce') {
        if (!branchRefused) return next.handle();
        throw new ForbiddenException(branchRefused);
      }
      // Shadow logs every other difference, but a store never opened (no trial, payment or grant) stays locked.
      if (branchRefused?.state === 'locked') throw new ForbiddenException(branchRefused);
      const business = await this.entitlement.writeRefusal(companyId);
      this.branches.shadow(companyId, this.cls.get<Buffer | undefined>('branchId') ?? null, !business, !branchRefused, `${method} ${path}`);
    }

    const refused = await this.entitlement.writeRefusal(companyId);
    if (!refused) return next.handle();

    // The state travels with the code, so a suspended business is never told its subscription ended.
    throw new ForbiddenException({ code: refused.code, message: refused.message, state: refused.state });
  }

  /** Shadow mode's one hard rule: the first of these branches whose own state is `locked` (never opened), refused. */
  private async lockedBranchNamed(companyId: Buffer, ids: Array<Buffer | undefined>) {
    for (const id of ids) {
      if (!id) continue;
      const refused = await this.branches.readRefusal(companyId, id);
      if (refused?.state === 'locked') return refused;
    }
    return null;
  }

  /** A read: of a branch, that branch's; without one, any store that is not locked will do. */
  private async branchRead(companyId: Buffer) {
    const branchId = this.cls.get<Buffer | undefined>('branchId');
    if (branchId) return this.branches.readRefusal(companyId, branchId);
    const list = await this.branches.listForCompany(companyId);
    if (list.some((b) => b.state !== 'locked' && b.state !== 'suspended')) return null;
    const stopped = list.some((b) => b.state === 'suspended');
    return stopped
      ? { code: 'BRANCH_ENTITLEMENT_WRITE_BLOCKED', message: 'This business is suspended.', state: 'suspended' }
      : { code: 'BRANCH_LOCKED', message: 'No branch is active yet. A branch opens when its payment is approved.', state: 'locked' };
  }

  /** A write: the active branch, then every branch named in the path or the body — so editing an id reaches nothing locked. */
  private async branchWrite(companyId: Buffer, req: { params?: Record<string, unknown>; body?: unknown }) {
    const named = namedBranches(req);
    const active = this.cls.get<Buffer | undefined>('branchId');
    if (!active && named.length === 0) {
      if (await this.branches.anyWritable(companyId)) return null;
      return { code: 'BRANCH_ENTITLEMENT_WRITE_BLOCKED', message: 'No branch of this business can record changes now.', state: 'expired' };
    }
    for (const id of [...(active ? [active] : []), ...named]) {
      const refused = await this.branches.writeRefusal(companyId, id);
      if (refused) return refused;
    }
    return null;
  }
}

/** The fields that name a branch, in the URL or the JSON body. */
const BRANCH_FIELDS = ['branchId', 'toBranchId', 'fromBranchId', 'destinationBranchId', 'sourceBranchId', 'targetBranchId'] as const;

export function namedBranches(req: { params?: Record<string, unknown>; body?: unknown }): Buffer[] {
  const out = new Map<string, Buffer>();
  const take = (v: unknown) => {
    if (typeof v === 'string' && isUuid(v)) out.set(v.toLowerCase(), uuidToBin(v));
  };
  for (const f of BRANCH_FIELDS) take(req.params?.[f]);
  const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : null;
  if (body) for (const f of BRANCH_FIELDS) take(body[f]);
  return [...out.values()];
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
