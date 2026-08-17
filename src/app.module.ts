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
import { isUuid, newUuidV7, uuidToBin } from './common/utils/uuid.util';
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
import { MessagingModule } from './messaging/messaging.module';
import { ScannerModule } from './scanner/scanner.module';
import { InventoryModule } from './inventory/inventory.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { CorrectionsModule } from './corrections/corrections.module';
import { PurchasingModule } from './purchasing/purchasing.module';
import { PricingModule } from './pricing/pricing.module';
import { SalesModule } from './sales/sales.module';
import { TransfersModule } from './transfers/transfers.module';
import { ReturnsModule } from './returns/returns.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ExpensesModule } from './expenses/expenses.module';
import { ClosingModule } from './closing/closing.module';
import { GoalsModule } from './goals/goals.module';

@Module({
  imports: [
    AppConfigModule,

    // AsyncLocalStorage per request. Sets `requestId` and the active branch;
    // auth guards add userId/companyId/permissions to this store.
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: () => newUuidV7(),
        setup: (cls, req: IncomingMessage) => {
          cls.set('requestId', cls.getId());
          /**
           * The active branch is REQUEST context, not an authorization result,
           * so it is resolved here rather than inside `PermissionsGuard`. The
           * guard exits early on routes that require no permission, which used
           * to leave those routes with no branch at all — a signed-in employee
           * reading a selling price got a 400 about a header they had sent.
           *
           * Setting it here grants nothing. Authority is still decided by
           * `AccessService`, which 403s when the user is not assigned to the
           * branch, and services verify branch access for open reads too.
           */
          const header = req.headers['x-branch-id'];
          if (typeof header === 'string' && isUuid(header)) {
            cls.set('branchId', uuidToBin(header));
          }
        },
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
              // Device identity (F1 Stage 3): the enrollment secret the client
              // presents at login. Redacted for parity with the password, so a
              // future body log cannot leak it while the password stays safe.
              'req.body.deviceCredential.deviceSecret',
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
    CorrectionsModule,
    PurchasingModule,
    PricingModule,
    SalesModule,
    TransfersModule,
    ReturnsModule,
    AnalyticsModule,
    ExpensesModule,
    ClosingModule,
    GoalsModule,
    SettingsModule,
    MessagingModule,
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
