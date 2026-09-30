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

  /** Provider template id for the auth OTP; empty until approved at the provider. */
  get whatsappAuthOtpTemplate(): string {
    return this.get('WHATSAPP_TEMPLATE_AUTH_OTP');
  }

  /** The provider's name for a registered template, by its configuration variable; empty when unapproved. */
  whatsappTemplateName(configKey: string): string {
    return (this.config.get<string>(configKey) ?? '').trim();
  }

  get whatsappApiBaseUrl(): string {
    return this.get('WHATSAPP_API_BASE_URL');
  }
  get whatsappApiVersion(): string {
    return this.get('WHATSAPP_API_VERSION');
  }
  get whatsappPhoneNumberId(): string {
    return this.get('WHATSAPP_PHONE_NUMBER_ID');
  }
  /** Secret. Read here and handed to the adapter; never returned, logged or audited. */
  get whatsappAccessToken(): string {
    return this.get('WHATSAPP_ACCESS_TOKEN');
  }
  get whatsappAppSecret(): string {
    return this.get('WHATSAPP_APP_SECRET');
  }
  get whatsappWebhookVerifyToken(): string {
    return this.get('WHATSAPP_WEBHOOK_VERIFY_TOKEN');
  }
  get whatsappSendTimeoutMs(): number {
    return this.get('WHATSAPP_SEND_TIMEOUT_MS');
  }
  get whatsappLanguageCodes(): { en: string; fr: string; ar: string } {
    return {
      en: this.get('WHATSAPP_TEMPLATE_LANGUAGE_EN'),
      fr: this.get('WHATSAPP_TEMPLATE_LANGUAGE_FR'),
      ar: this.get('WHATSAPP_TEMPLATE_LANGUAGE_AR'),
    };
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
