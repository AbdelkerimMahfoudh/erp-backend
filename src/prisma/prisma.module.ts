import { Global, Module } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AppClsStore } from '../common/context/request-context';
import { PrismaService } from './prisma.service';
import { createTenantPrisma } from './tenant.extension';

/**
 * Injection token for the tenant-scoped Prisma client. Feature services inject it
 * with `@Inject(TENANT_PRISMA) private readonly db: TenantPrisma` and never touch
 * the raw {@link PrismaService} for tenant data.
 */
export const TENANT_PRISMA = 'TENANT_PRISMA';

/**
 * Global Prisma module. Provides:
 *  - {@link PrismaService}  — unscoped system client (auth/global/system jobs).
 *  - {@link TENANT_PRISMA}  — company-scoped client (all tenant data access).
 *
 * The tenant client is a single instance that reads the request CLS at query
 * time, so it stays a singleton while remaining correct per request.
 */
@Global()
@Module({
  providers: [
    PrismaService,
    {
      provide: TENANT_PRISMA,
      inject: [PrismaService, ClsService],
      useFactory: (prisma: PrismaService, cls: ClsService<AppClsStore>) =>
        createTenantPrisma(prisma, cls),
    },
  ],
  exports: [PrismaService, TENANT_PRISMA],
})
export class PrismaModule {}
