import { Global, Module } from '@nestjs/common';
import { AccessService } from './access.service';
import { PermissionsGuard } from './permissions.guard';

/**
 * Global RBAC module. Provides the {@link AccessService} (permission resolution)
 * and {@link PermissionsGuard} so `@RequirePermissions(...)` works in any module
 * without re-importing.
 */
@Global()
@Module({
  providers: [AccessService, PermissionsGuard],
  exports: [AccessService, PermissionsGuard],
})
export class RbacModule {}
