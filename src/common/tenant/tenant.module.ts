import { Global, Module } from '@nestjs/common';
import { TenantContext } from './tenant-context.service';

@Global()
@Module({
  providers: [TenantContext],
  exports: [TenantContext],
})
export class TenantModule {}
