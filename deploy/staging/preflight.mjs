// Staging preflight (docs/99 §5): the environment the API is about to receive, checked against the staging policy
// before anything starts. Run in the tools container, which gets exactly the API's env files:
//
//   deploy/staging/preflight.sh            (= docker compose run --rm tools node deploy/staging/preflight.mjs)
//
// The application's own production guard (src/common/config/production-guard.ts) refuses to start on most unsafe
// values; this adds what is specific to STAGING and to this stack — the right identities and schema, the messaging
// channels held in their safe modes, the exposed Brevo key never reused, secrets that are distinct from each other —
// and says it before a container is replaced. It prints names and lengths, never a value. Exit 1 on any failure.
const env = process.env;
const failures = [];
const notes = [];
const check = (ok, message) => (ok ? null : failures.push(message));
const present = (name) => Object.prototype.hasOwnProperty.call(env, name);
const val = (name) => (env[name] ?? '').trim();

// ── Identity ──────────────────────────────────────────────────────────────────────────────────────────────────────
check(val('APP_ENV') === 'staging', 'APP_ENV must be "staging".');
check(val('NODE_ENV') === 'production', 'NODE_ENV must be "production" (staging runs the production code paths).');
check(val('API_INGRESS') === 'network', 'API_INGRESS must be "network" in the container stack (one trusted hop: the edge).');
check(!val('API_BIND') || val('API_BIND') === '0.0.0.0', 'API_BIND must be unset in a container: a loopback bind is unreachable from the edge.');
let apiOrigin = null;
try {
  const u = new URL(val('PUBLIC_API_ORIGIN'));
  apiOrigin = u.protocol === 'https:' && u.pathname === '/' && !u.search && !val('PUBLIC_API_ORIGIN').endsWith('/') ? u.origin : null;
} catch {
  apiOrigin = null;
}
check(apiOrigin, 'PUBLIC_API_ORIGIN must be the staging API https:// origin, no path or trailing slash (e.g. https://staging-api.tsxmr.com).');

// ── Database: the app identity on the staging schema, never the migrator ───────────────────────────────────────────
function dbUrl(name) {
  try {
    const u = new URL(val(name));
    return { user: decodeURIComponent(u.username), host: u.hostname, db: u.pathname.slice(1) };
  } catch {
    return null;
  }
}
const app = dbUrl('APP_DATABASE_URL');
check(app && app.user === 'phonestore_app', 'APP_DATABASE_URL must connect as phonestore_app (the audit triggers check that name).');
check(app && app.db === 'phonestore_staging', 'APP_DATABASE_URL must name the phonestore_staging schema.');
check(!/phonestore_migrator|root@/.test(val('APP_DATABASE_URL')), 'APP_DATABASE_URL must never carry the migrator or root.');
check(!val('SHADOW_DATABASE_URL'), 'SHADOW_DATABASE_URL must be absent: staging never runs `migrate dev`.');

// ── Secrets: present, long enough, not placeholders, and all different ─────────────────────────────────────────────
const PLACEHOLDER = /change|example|placeholder|secret|test|xxx|todo/i;
const secrets = {
  JWT_ACCESS_SECRET: 32,
  OTP_PEPPER: 32,
  MESSAGING_HASH_KEY: 32,
  PLATFORM_MFA_KEY: 32,
};
for (const [name, min] of Object.entries(secrets)) {
  check(val(name).length >= min, `${name} must be at least ${min} characters (generate it; docs/99 §3).`);
  check(!PLACEHOLDER.test(val(name)), `${name} looks like a placeholder.`);
}
const mfa = val('PLATFORM_MFA_KEY');
const mfaBytes = /^[0-9a-f]{64}$/i.test(mfa) ? 32 : (() => {
  try {
    return Buffer.from(mfa, 'base64').length;
  } catch {
    return 0;
  }
})();
check(mfaBytes === 32, 'PLATFORM_MFA_KEY must decode to exactly 32 bytes (64 hex characters, or base64 of 32 bytes).');
const values = Object.keys(secrets).map(val).filter(Boolean);
check(new Set(values).size === values.length, 'JWT_ACCESS_SECRET, OTP_PEPPER, MESSAGING_HASH_KEY and PLATFORM_MFA_KEY must all be different.');

// ── Surface ─────────────────────────────────────────────────────────────────────────────────────────────────────────
check(val('COOKIE_SECURE') === 'true', 'COOKIE_SECURE must be "true".');
check(val('SWAGGER_ENABLED') === 'false', 'SWAGGER_ENABLED must be "false".');
check(!/^(1|true|yes)$/i.test(val('SEED_DEMO')), 'SEED_DEMO must not be on.');
check(['info', 'warn', 'error'].includes(val('LOG_LEVEL') || 'info'), 'LOG_LEVEL must be info, warn or error (debug logs carry request detail).');
check(!val('PLATFORM_ADMIN_KEY'), 'PLATFORM_ADMIN_KEY must be empty: the first administrator is created from the shell, with MFA (docs/99 §6).');

// CORS: the variable must be stated, even empty (no browser client yet); every entry an exact https origin.
check(present('CORS_ORIGINS'), 'CORS_ORIGINS must be stated (empty = no browser origin may call the API; the mobile app needs none).');
for (const origin of val('CORS_ORIGINS').split(',').map((o) => o.trim()).filter(Boolean)) {
  let ok = false;
  try {
    const u = new URL(origin);
    ok = u.protocol === 'https:' && u.origin === origin;
  } catch {
    ok = false;
  }
  check(ok && !origin.includes('*'), `CORS origin "${origin}" must be an exact https:// origin: no wildcard, path or trailing slash.`);
}
try {
  const u = new URL(val('PUBLIC_SITE_ORIGIN'));
  check(u.protocol === 'https:' && u.origin === val('PUBLIC_SITE_ORIGIN'), 'PUBLIC_SITE_ORIGIN must be an exact https:// origin.');
} catch {
  check(false, 'PUBLIC_SITE_ORIGIN must be set to an https:// origin (the free trial builds its setup links from it).');
}
for (const name of ['THROTTLE_TTL_SECONDS', 'THROTTLE_LIMIT', 'AUTH_THROTTLE_LIMIT', 'ACCOUNT_THROTTLE_LIMIT']) {
  check(/^\d+$/.test(val(name)), `${name} must be stated as a whole number (rate limits are part of the staging contract).`);
}
check(val('UPLOAD_DIR') === '/app/uploads', 'UPLOAD_DIR must be /app/uploads, the persistent volume.');

// ── Codes in staging: the outbox, deliberately chosen either way ───────────────────────────────────────────────────
check(['enabled', 'disabled'].includes(val('STAGING_CONTACT_OUTBOX')), 'STAGING_CONTACT_OUTBOX must be stated: "enabled" (codes held for the retrieval command) or "disabled".');

// ── Email: disabled, or SMTP with a key rotated after the one exposed on 2026-10-17 ────────────────────────────────
const email = val('EMAIL_CHANNEL') || 'disabled';
check(['disabled', 'smtp'].includes(email), 'EMAIL_CHANNEL must be "disabled" or "smtp" in staging.');
if (email === 'smtp') {
  const rotated = val('SMTP_KEY_ROTATED_ON');
  check(/^\d{4}-\d{2}-\d{2}$/.test(rotated) && rotated > '2026-10-17', 'SMTP_KEY_ROTATED_ON must be the date (after 2026-10-17) the Brevo SMTP key was rotated: the key shared in chat that day is never reused.');
  check(val('SMTP_PASSWORD').length >= 16, 'SMTP_PASSWORD must be the rotated Brevo SMTP key.');
}

// ── WhatsApp: disabled, or the Cloud API in test mode, to the allowlist only ───────────────────────────────────────
const wa = val('WHATSAPP_CHANNEL') || 'disabled';
check(['disabled', 'cloud'].includes(wa), 'WHATSAPP_CHANNEL must be "disabled" or "cloud" in staging.');
if (wa === 'cloud') {
  check(val('WHATSAPP_MODE') === 'test', 'WHATSAPP_MODE must be "test" in staging.');
  check(val('WHATSAPP_LIVE_SENDS') === 'disabled', 'WHATSAPP_LIVE_SENDS must be "disabled" in staging.');
  const recipients = val('WHATSAPP_TEST_RECIPIENTS').split(',').map((r) => r.trim()).filter(Boolean);
  check(recipients.length > 0 && recipients.every((r) => /^\+\d{8,15}$/.test(r)), 'WHATSAPP_TEST_RECIPIENTS must list the approved test numbers in E.164.');
  notes.push(`webhook URL for Meta: ${apiOrigin ?? 'https://<PUBLIC_API_ORIGIN>'}/api/v1/messaging/whatsapp/webhook (${recipients.length} test recipient(s))`);
}

console.log(`staging preflight: ${failures.length === 0 ? 'PASS' : 'FAIL'}`);
console.log(`  API origin ${apiOrigin ?? '(invalid)'} · email ${email} · WhatsApp ${wa} · outbox ${val('STAGING_CONTACT_OUTBOX') || '(unset)'} · CORS origins ${val('CORS_ORIGINS').split(',').filter((o) => o.trim()).length}`);
for (const n of notes) console.log(`  ${n}`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
