import 'reflect-metadata';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { AppConfigService } from './common/config/app-config.service';
import { assertProductionConfig } from './common/config/production-guard';
import { isIngressMode, trustProxySetting } from './common/config/ingress';

async function bootstrap(): Promise<void> {
  /*
   * Before anything is built or bound.
   *
   * Every rule this enforces was already written down and none of them was
   * enforced: a fail-open default starts happily and is quietly less safe than
   * the documentation says. A refusal to boot is seen in seconds; a session
   * cookie in clear text is not seen at all.
   */
  assertProductionConfig();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const config = app.get(AppConfigService);

  /**
   * Who the client is, when there is a proxy in front.
   *
   * Express defaults `req.ip` to the socket peer. Behind the edge that peer is
   * the EDGE, so without this every request looks like it came from the same
   * address — and `req.ip` is what the rate limiter keys on and what the login
   * audit row records. `AUTH_THROTTLE_LIMIT` would be a budget shared by every
   * user on the platform rather than a per-client one: one noisy client locks
   * everybody out, and a distributed brute force is invisible.
   *
   * Trusting forwarded headers is not free, which is why it follows the
   * declared ingress rather than being switched on generally. If the API were
   * directly reachable, anyone could send `X-Forwarded-For` and choose their
   * own rate-limit bucket and their own audit trail.
   */
  const ingress = process.env.API_INGRESS;
  app.set('trust proxy', trustProxySetting(isIngressMode(ingress) ? ingress : undefined));

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
    /**
     * A browser hides every response header except a short safelist unless the
     * server says otherwise — and `Content-Disposition` is not on it.
     *
     * Found by a real browser download, not by a test: the report endpoint
     * answered 200 with the right bytes, and the web client read `null` for the
     * filename and fell back to `report.csv`. Every export would have saved
     * under the same name, losing the report, period and branch that the
     * filename is the only place to carry.
     *
     * Native fetch is unaffected — this is a browser rule, so only the web
     * build ever saw it.
     */
    exposedHeaders: ['Content-Disposition', 'X-Report-Rows'],
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
