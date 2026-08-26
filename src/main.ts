import 'reflect-metadata';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { AppConfigService } from './common/config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(AppConfigService);

  // Route Nest logs through pino.
  app.useLogger(app.get(Logger));

  // Security headers + CORS allowlist.
  /*
   * Helmet's defaults, minus HSTS in staging.
   *
   * `helmet()` sends `Strict-Transport-Security: max-age=15552000;
   * includeSubDomains`. On a production domain that is right. On a STAGING
   * host it is a trap: `includeSubDomains` pins the whole parent domain to
   * HTTPS in every browser that saw the header, for six months, and it keeps
   * doing so long after the staging environment is gone. A test environment
   * must not be able to break a sibling that has nothing to do with it.
   *
   * Only HSTS is dropped. Every other header helmet sets still applies.
   */
  const isStaging = (process.env.APP_ENV ?? '').toLowerCase() === 'staging';
  app.use(helmet(isStaging ? { hsts: false } : undefined));
  app.enableCors({
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    credentials: true,
  });

  // Versioned API: /api/v1/...  (health is version-neutral: /api/health)
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // Strict global validation: unknown fields rejected, DTOs transformed.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.enableShutdownHooks();

  if (config.swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Phone Store ERP API')
      .setDescription('Backend API — Sprint 1 foundation')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));
  }

  /*
   * Which interface the API answers on.
   *
   * `API_BIND` defaults to every interface, because in development a phone on
   * the same Wi-Fi has to reach this machine directly.
   *
   * A DEPLOYED environment should set `API_BIND=127.0.0.1` and put the API
   * behind the edge, so `/api/*` is reachable only through the proxy that also
   * enforces the `/admin` boundary and the security headers. Otherwise the
   * administration ENDPOINTS stay reachable on the API port even while the
   * administration PAGES are refused — the guard would then be a password
   * alone, which is exactly the single layer the deployment is supposed to
   * avoid while administrator MFA does not exist.
   */
  const bind = process.env.API_BIND ?? '0.0.0.0';
  await app.listen(config.port, bind);
  app.get(Logger).log(`API listening on ${bind}:${config.port}/api`);
}

void bootstrap();
