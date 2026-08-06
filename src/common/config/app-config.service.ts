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

  // ── Messaging + OTP (F1 Stage 4A) ──────────────────────────────────────

  get whatsappChannel(): string {
    return this.get('WHATSAPP_CHANNEL');
  }

  /** Provider template id for the auth OTP; empty until Stage 4B. */
  get whatsappAuthOtpTemplate(): string {
    return this.get('WHATSAPP_TEMPLATE_AUTH_OTP');
  }

  /**
   * The OTP pepper, or null when unset.
   *
   * Null is a supported state: the application starts, and OTP challenge
   * creation refuses. That is deliberate — a missing pepper must degrade to
   * "no OTP" rather than to "OTP with a guessable hash".
   */
  get otpPepper(): string | null {
    const value = this.config.get<string>('OTP_PEPPER');
    return value && value.length >= 32 ? value : null;
  }

  get otpTtlSeconds(): number {
    return this.get('OTP_TTL_SECONDS');
  }
  get otpMaxAttempts(): number {
    return this.get('OTP_MAX_ATTEMPTS');
  }
  get otpResendCooldownSeconds(): number {
    return this.get('OTP_RESEND_COOLDOWN_SECONDS');
  }
  get otpMaxSendsPerWindow(): number {
    return this.get('OTP_MAX_SENDS_PER_WINDOW');
  }
  get otpSendWindowSeconds(): number {
    return this.get('OTP_SEND_WINDOW_SECONDS');
  }
  get otpMaxSendsPerDay(): number {
    return this.get('OTP_MAX_SENDS_PER_DAY');
  }

  get uploadMaxBytes(): number {
    return this.get('UPLOAD_MAX_BYTES');
  }
  get uploadDir(): string {
    return this.get('UPLOAD_DIR');
  }
}
