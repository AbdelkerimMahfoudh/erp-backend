import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { AppClsStore } from '../common/context/request-context';
import { uuidToBin } from '../common/utils/uuid.util';
import { AccessService } from './access.service';
import { REQUIRE_PERMISSIONS_KEY } from './require-permissions.decorator';

/**
 * Enforces `@RequirePermissions(...)`. Resolves the caller's effective
 * permissions (branch-scoped when an active branch is present, else the union
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

    // The active branch was resolved by the CLS middleware, which runs for
    // EVERY request — including routes that require no permission and so never
    // reach this guard. Parsing it here as well would give those routes no
    // branch at all.
    const branchId = this.cls.get('branchId');

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
