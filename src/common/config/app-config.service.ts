import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Typed accessor over validated environment configuration. Feature code depends
 * on this rather than reading `process.env` directly (single source of truth,
 * fully typed, testable).
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService) {}

  private get<T>(key: string): T {
    return this.config.getOrThrow<T>(key);
  }

  get nodeEnv(): 'development' | 'test' | 'production' {
    return this.get('NODE_ENV');
  }
  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }
  get isDevelopment(): boolean {
    return this.nodeEnv === 'development';
  }
  get port(): number {
    return this.get('PORT');
  }

  /** Runtime DB URL — the least-privilege `phonestore_app` user. */
  get appDatabaseUrl(): string {
    return this.get('APP_DATABASE_URL');
  }

  get jwtAccessSecret(): string {
    return this.get('JWT_ACCESS_SECRET');
  }
  get jwtAccessTtl(): string {
    return this.get('JWT_ACCESS_TTL');
  }
  get jwtRefreshTtlDays(): number {
    return this.get('JWT_REFRESH_TTL_DAYS');
  }

  get corsOrigins(): string[] {
    return this.get<string>('CORS_ORIGINS')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  }
  get swaggerEnabled(): boolean {
    return this.get('SWAGGER_ENABLED');
  }

  get throttleTtlSeconds(): number {
    return this.get('THROTTLE_TTL_SECONDS');
  }
  get throttleLimit(): number {
    return this.get('THROTTLE_LIMIT');
  }
  get authThrottleLimit(): number {
    return this.get('AUTH_THROTTLE_LIMIT');
  }

  get logLevel(): string {
    return this.get('LOG_LEVEL');
  }

  get uploadMaxBytes(): number {
    return this.get('UPLOAD_MAX_BYTES');
  }
  get uploadDir(): string {
    return this.get('UPLOAD_DIR');
  }
}
