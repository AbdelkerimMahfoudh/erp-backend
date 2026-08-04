import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppConfigService } from '../common/config/app-config.service';

/**
 * The base ("system") Prisma client. Connects as the least-privilege application
 * user (`APP_DATABASE_URL` = `phonestore_app`), so append-only audit triggers and
 * DML-only grants apply.
 *
 * This client is UNSCOPED — it does not enforce tenant isolation. Use it only for
 * genuinely tenant-agnostic work (auth/login before a tenant is known, global
 * reference tables, system jobs). All tenant data access must go through the
 * tenant-scoped client (see tenant.extension.ts / TENANT_PRISMA).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: AppConfigService) {
    super({
      datasourceUrl: config.appDatabaseUrl,
      log: config.isDevelopment ? ['warn', 'error'] : ['error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
