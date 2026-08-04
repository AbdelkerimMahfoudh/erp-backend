import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { Request } from 'express';
import { AppClsStore } from '../common/context/request-context';
import { isUuid, uuidToBin } from '../common/utils/uuid.util';
import { AccessService } from './access.service';
import { REQUIRE_PERMISSIONS_KEY } from './require-permissions.decorator';

/**
 * Enforces `@RequirePermissions(...)`. Resolves the caller's effective
 * permissions (branch-scoped when `X-Branch-Id` is present, else the union
 * across their branches), caches them in CLS, and checks the required set.
 * Runs after the global JwtAuthGuard, so `userId`/`companyId` are in context.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessService,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required =
      this.reflector.getAllAndOverride<string[]>(REQUIRE_PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (required.length === 0) {
      return true;
    }

    const userId = this.cls.get('userId');
    if (!userId) {
      throw new ForbiddenException();
    }

    // Resolve branch context from the X-Branch-Id header (optional).
    let branchId = this.cls.get('branchId');
    if (!branchId) {
      const header = context.switchToHttp().getRequest<Request>().headers['x-branch-id'];
      if (typeof header === 'string' && isUuid(header)) {
        branchId = uuidToBin(header);
        this.cls.set('branchId', branchId);
      }
    }

    let permissions = this.cls.get('permissions');
    if (!permissions) {
      permissions = await this.access.getEffectivePermissions(uuidToBin(userId), branchId);
      this.cls.set('permissions', permissions);
    }

    const missing = required.filter((p) => !permissions!.has(p));
    if (missing.length > 0) {
      throw new ForbiddenException(`Missing permission(s): ${missing.join(', ')}`);
    }
    return true;
  }
}
