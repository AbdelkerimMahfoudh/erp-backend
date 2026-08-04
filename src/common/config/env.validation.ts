import * as Joi from 'joi';

/**
 * Joi schema for environment variables. The app FAILS FAST at boot if any
 * required variable is missing or malformed (no silent misconfiguration).
 * Unknown variables are allowed (e.g. Prisma's DATABASE_URL used only by the CLI).
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

  // File upload foundation.
  UPLOAD_MAX_BYTES: Joi.number().integer().min(1).default(10 * 1024 * 1024),
  UPLOAD_DIR: Joi.string().default('./uploads'),
}).unknown(true);
