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
  /** test (default: only the exact allowlist) | live (real customers, once WHATSAPP_LIVE_SENDS=enabled). D181 §4. */
  get whatsappMode(): 'test' | 'live' {
    return (this.config.get<string>('WHATSAPP_MODE') ?? 'test').trim().toLowerCase() === 'live' ? 'live' : 'test';
  }
  /** The raw allowlist (comma-separated E.164); parsed and validated by `messaging/whatsapp-policy.ts`. */
  get whatsappTestRecipients(): string {
    return (this.config.get<string>('WHATSAPP_TEST_RECIPIENTS') ?? '').trim();
  }
  get whatsappLiveSends(): boolean {
    return (this.config.get<string>('WHATSAPP_LIVE_SENDS') ?? 'disabled').trim().toLowerCase() === 'enabled';
  }
  /** The Meta app's id — an identifier, not a secret. Used by the live-mode credential check only. */
  get whatsappAppId(): string {
    return (this.config.get<string>('WHATSAPP_APP_ID') ?? '').trim();
  }
  get whatsappMaxSendsPerSecond(): number {
    return this.get('WHATSAPP_MAX_SENDS_PER_SECOND');
  }
  get whatsappRecipientMinIntervalMs(): number {
    return this.get('WHATSAPP_RECIPIENT_MIN_INTERVAL_MS');
  }
  get whatsappWebhookRetentionDays(): number {
    return this.get('WHATSAPP_WEBHOOK_RETENTION_DAYS');
  }
  /** How long email and WhatsApp message metadata is kept (D181 §7). */
  get messageLogRetentionDays(): number {
    return this.get('MESSAGE_LOG_RETENTION_DAYS');
  }
  /** Secret. Keys the recipient hashes of the message records; null when unset. Never logged. */
  get messagingHashKey(): string | null {
    const value = (this.config.get<string>('MESSAGING_HASH_KEY') ?? '').trim();
    return value ? value : null;
  }

  // ── Email (messaging/email-channel.ts) ──
  get emailChannel(): string {
    return this.get('EMAIL_CHANNEL');
  }
  get emailFrom(): string {
    return (this.config.get<string>('EMAIL_FROM') ?? '').trim();
  }
  get emailReplyTo(): string {
    return (this.config.get<string>('EMAIL_REPLY_TO') ?? '').trim();
  }
  get resendApiKey(): string {
    return (this.config.get<string>('RESEND_API_KEY') ?? '').trim();
  }
  get resendApiBaseUrl(): string {
    return this.get('RESEND_API_BASE_URL');
  }
  get emailSendTimeoutMs(): number {
    return this.get('EMAIL_SEND_TIMEOUT_MS');
  }
  /** The From address per sender class; each falls back to EMAIL_FROM when empty (email-channel.ts). */
  get emailSenders(): { verification: string; notifications: string; reports: string; receipts: string; fallback: string } {
    const read = (key: string) => (this.config.get<string>(key) ?? '').trim();
    return {
      verification: read('EMAIL_FROM_VERIFICATION'),
      notifications: read('EMAIL_FROM_NOTIFICATIONS'),
      reports: read('EMAIL_FROM_REPORTS'),
      receipts: read('EMAIL_FROM_RECEIPTS'),
      fallback: read('EMAIL_FROM'),
    };
  }
  get smtpHost(): string {
    return this.get('SMTP_HOST');
  }
  get smtpPort(): number {
    return this.get('SMTP_PORT');
  }
  get smtpUsername(): string {
    return (this.config.get<string>('SMTP_USERNAME') ?? '').trim();
  }
  /** Secret. Handed to the SMTP transport and nothing else; never returned, logged or put in an error. */
  get smtpPassword(): string {
    return this.config.get<string>('SMTP_PASSWORD') ?? '';
  }
  get smtpTimeouts(): { connectionMs: number; greetingMs: number; socketMs: number } {
    return {
      connectionMs: this.get('SMTP_CONNECTION_TIMEOUT_MS'),
      greetingMs: this.get('SMTP_GREETING_TIMEOUT_MS'),
      socketMs: this.get('SMTP_SOCKET_TIMEOUT_MS'),
    };
  }
  /** The application's own daily safety limit and its reserve for essential email — not Brevo's account count. */
  get emailDailySafetyLimit(): number {
    return this.get('EMAIL_DAILY_SAFETY_LIMIT');
  }
  get emailDailyReserve(): number {
    return this.get('EMAIL_DAILY_RESERVE');
  }
  get emailRecipientDailyLimit(): number {
    return this.get('EMAIL_RECIPIENT_DAILY_LIMIT');
  }

  /** Provider template id for the auth OTP; empty until approved at the provider. */
  get whatsappAuthOtpTemplate(): string {
    return this.get('WHATSAPP_TEMPLATE_AUTH_OTP');
  }

  /** The provider's name for a registered template, by its configuration variable; empty when unapproved. */
  whatsappTemplateName(configKey: string): string {
    return (this.config.get<string>(configKey) ?? '').trim();
  }

  /**
   * The Dukan ERP portal's origin (0099), for the one address the portal instructions and the subscription messages
   * carry — and for nothing else: no request is ever compared with it. Empty when unset, and then no such message can
   * be sent. Production refuses anything but an https:// origin with no path, and APP_ENV=production anything but
   * https://dukan.tsxmr.com (`production-guard.ts`); elsewhere a trailing slash is forgiven.
   */
  get portalOrigin(): string {
    return (this.config.get<string>('PORTAL_ORIGIN') ?? '').trim().replace(/\/+$/, '');
  }

  /** `<portal>/subscription` — generic: no token, no identifier, nothing about who it is for. Empty with no portal. */
  get portalSubscriptionUrl(): string {
    return this.portalOrigin ? `${this.portalOrigin}/subscription` : '';
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
  /** The raw administrator-MFA key (0094); parsed and checked by `mfa/secret-box.ts`. */
  get platformMfaKey(): string {
    return (this.config.get<string>('PLATFORM_MFA_KEY') ?? '').trim();
  }

  /**
   * Secret. Keys the hashes of employee invitation references (0101, D214): a key of their own, never another
   * secret's, so the hashes are comparable with nothing else. Null when unset or shorter than 32 characters — then no
   * invitation can be issued or opened, rather than one whose hash a leaked database could reverse. Never logged.
   */
  get staffInvitationKey(): string | null {
    const value = (this.config.get<string>('STAFF_INVITATION_KEY') ?? '').trim();
    return value.length >= 32 ? value : null;
  }

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
