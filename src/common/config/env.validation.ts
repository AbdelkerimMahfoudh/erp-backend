import * as Joi from 'joi';

/**
 * Joi schema for environment variables. The app FAILS FAST at boot if any
 * required variable is missing or malformed (no silent misconfiguration).
 * Unknown variables are allowed (e.g. Prisma's DATABASE_URL used only by the CLI).
 *
 * Relationships between variables (what production may not run with) are the
 * production guard's job — `production-guard.ts` — not Joi's.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),

  // Runtime DB connection = the least-privilege application user.
  APP_DATABASE_URL: Joi.string().uri({ scheme: ['mysql'] }).required(),

  // JWT / auth (consumed in Phase 2 but validated now so config is complete).
  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_TTL: Joi.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: Joi.number().integer().min(1).default(30),

  // HTTP hardening.
  CORS_ORIGINS: Joi.string().allow('').default(''),
  SWAGGER_ENABLED: Joi.boolean().default(true),
  THROTTLE_TTL_SECONDS: Joi.number().integer().min(1).default(60),
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(120),
  AUTH_THROTTLE_LIMIT: Joi.number().integer().min(1).default(10),

  // Logging.
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .default('info'),

  // ── Messaging + OTP (F1 Stage 4A; the Cloud API since 2026-09-30) ─────────
  // "disabled" is the default. "development-log" is refused in production by
  // MessagingModule. "cloud-api" is the WhatsApp Business Cloud API and needs
  // the credentials below; the production guard refuses it without them.
  WHATSAPP_CHANNEL: Joi.string().valid('disabled', 'development-log', 'cloud-api').default('disabled'),
  WHATSAPP_API_BASE_URL: Joi.string().uri({ scheme: ['https', 'http'] }).default('https://graph.facebook.com'),
  WHATSAPP_API_VERSION: Joi.string().pattern(/^v\d+\.\d+$/).default('v21.0'),
  // The sending number's id at the provider — an identifier, not a secret.
  WHATSAPP_PHONE_NUMBER_ID: Joi.string().allow('').default(''),
  // A system-user access token. Secret: server-side configuration only.
  WHATSAPP_ACCESS_TOKEN: Joi.string().allow('').default(''),
  // Delivery-status webhook: the app secret signs every delivery, the verify
  // token answers the provider's subscription check. Both or neither.
  WHATSAPP_APP_SECRET: Joi.string().allow('').default(''),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: Joi.string().allow('').default(''),
  WHATSAPP_SEND_TIMEOUT_MS: Joi.number().integer().min(1000).max(60_000).default(10_000),
  // The provider's language codes for the approved templates.
  WHATSAPP_TEMPLATE_LANGUAGE_EN: Joi.string().default('en'),
  WHATSAPP_TEMPLATE_LANGUAGE_FR: Joi.string().default('fr'),
  WHATSAPP_TEMPLATE_LANGUAGE_AR: Joi.string().default('ar'),

  // Server-side pepper for OTP code hashes. Deliberately NO default: a shared
  // fallback would let anyone who reads this repository brute-force a 6-digit
  // code offline from a stolen database. Absent = OTP challenges refuse to
  // activate; the rest of the application still starts.
  OTP_PEPPER: Joi.string().min(32).optional(),

  // Security limits, not Owner-editable settings.
  OTP_TTL_SECONDS: Joi.number().integer().min(60).max(900).default(300),
  OTP_MAX_ATTEMPTS: Joi.number().integer().min(3).max(10).default(5),
  OTP_RESEND_COOLDOWN_SECONDS: Joi.number().integer().min(30).max(600).default(60),
  OTP_MAX_SENDS_PER_WINDOW: Joi.number().integer().min(1).max(10).default(3),
  OTP_SEND_WINDOW_SECONDS: Joi.number().integer().min(60).default(900),
  OTP_MAX_SENDS_PER_DAY: Joi.number().integer().min(1).max(50).default(10),

  // Provider template names, one per registered template (messaging/templates.ts).
  // Empty means "not approved yet": the adapter refuses to send that template.
  WHATSAPP_TEMPLATE_AUTH_OTP: Joi.string().allow('').default(''),
  WHATSAPP_TEMPLATE_ACCOUNT_DELETION: Joi.string().allow('').default(''),
  WHATSAPP_TEMPLATE_ACCOUNT_DELETED: Joi.string().allow('').default(''),
  WHATSAPP_TEMPLATE_CLOSING_REOPENED: Joi.string().allow('').default(''),
  WHATSAPP_TEMPLATE_CLOSING_SALE: Joi.string().allow('').default(''),
  WHATSAPP_TEMPLATE_CLOSING_RECLOSED: Joi.string().allow('').default(''),

  // File upload foundation.
  UPLOAD_MAX_BYTES: Joi.number().integer().min(1).default(10 * 1024 * 1024),
  UPLOAD_DIR: Joi.string().default('./uploads'),
}).unknown(true);
