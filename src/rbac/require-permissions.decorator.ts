import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { PermissionsGuard } from './permissions.guard';

export const REQUIRE_PERMISSIONS_KEY = 'requirePermissions';

/**
 * Require one or more permission keys (see the 17-key catalog) for a route.
 * Attaches the {@link PermissionsGuard}, which runs after the global JWT guard.
 *
 * @example
 *   @RequirePermissions('sale.create')
 *   @Post()
 *   create() { ... }
 */
export function RequirePermissions(...permissions: string[]) {
  return applyDecorators(
    SetMetadata(REQUIRE_PERMISSIONS_KEY, permissions),
    UseGuards(PermissionsGuard),
    ApiBearerAuth(),
  );
}
