import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { IncomingMessage } from 'node:http';

import { AppConfigModule } from './common/config/app-config.module';
import { AppConfigService } from './common/config/app-config.service';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { BinaryUuidInterceptor } from './common/interceptors/binary-uuid.interceptor';
import { CostGatingInterceptor } from './common/interceptors/cost-gating.interceptor';
import { newUuidV7 } from './common/utils/uuid.util';
import { HashingModule } from './common/security/hashing.module';
import { TenantModule } from './common/tenant/tenant.module';
import { AuditModule } from './common/audit/audit.module';
import { NumberingModule } from './common/numbering/numbering.module';
import { EventsModule } from './common/events/events.module';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { RbacModule } from './rbac/rbac.module';
import { StorageModule } from './storage/storage.module';
import { NotificationsModule } from './notifications/notifications.module';
import { TrackingModule } from './tracking/tracking.module';
import { CatalogModule } from './catalog/catalog.module';
import { CategoriesModule } from './categories/categories.module';
import { SettingsModule } from './settings/settings.module';
import { ScannerModule } from './scanner/scanner.module';
import { InventoryModule } from './inventory/inventory.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { PurchasingModule } from './purchasing/purchasing.module';
import { SalesModule } from './sales/sales.module';
import { TransfersModule } from './transfers/transfers.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ExpensesModule } from './expenses/expenses.module';
import { ClosingModule } from './closing/closing.module';

@Module({
  imports: [
    AppConfigModule,

    // AsyncLocalStorage per request. Sets `requestId`; auth/isolation guards
    // (Phase 2/3) add userId/companyId/branchId/permissions to this store.
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: () => newUuidV7(),
        setup: (cls) => cls.set('requestId', cls.getId()),
      },
    }),

    // Structured JSON logging with per-request correlation and secret redaction.
    LoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (cfg: AppConfigService) => ({
        pinoHttp: {
          level: cfg.logLevel,
          genReqId: (req: IncomingMessage) =>
            (req.headers['x-request-id'] as string | undefined) ?? newUuidV7(),
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.body.password',
              'req.body.pin',
              'req.body.refreshToken',
              'res.headers["set-cookie"]',
            ],
            remove: true,
          },
          transport: cfg.isProduction
            ? undefined
            : { target: 'pino-pretty', options: { singleLine: true } },
          autoLogging: true,
        },
      }),
    }),

    // Global rate limiting (tighter limits on auth endpoints come in Phase 2).
    ThrottlerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (cfg: AppConfigService) => [
        { ttl: cfg.throttleTtlSeconds * 1000, limit: cfg.throttleLimit },
      ],
    }),

    HashingModule,
    TenantModule,
    AuditModule,
    NumberingModule,
    EventsModule,
    PrismaModule,
    RbacModule,
    StorageModule,
    HealthModule,
    AuthModule,
    NotificationsModule,
    TrackingModule,
    CatalogModule,
    CategoriesModule,
    ScannerModule,
    InventoryModule,
    SuppliersModule,
    PurchasingModule,
    SalesModule,
    TransfersModule,
    AnalyticsModule,
    ExpensesModule,
    ClosingModule,
    SettingsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Registered before BinaryUuid → runs OUTERMOST, stripping financial fields
    // after Decimals have been converted to numbers.
    { provide: APP_INTERCEPTOR, useClass: CostGatingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: BinaryUuidInterceptor },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
