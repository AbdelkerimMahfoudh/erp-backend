// Production preflight (docs/100 §5): the environment the API is about to receive, checked against the PRODUCTION
// policy before anything starts. Run in the tools container, which gets exactly the API's env file and secret files:
//
//   deploy/production/preflight.sh       (= docker compose run --rm tools node deploy/production/preflight.mjs)
//
// The application's own production guard (src/common/config/production-guard.ts) refuses to start on most unsafe
// values; this adds what is specific to this host and this stack, and says it before a container is replaced: the
// profile and its hostname, the production identities and schema, every secret as a file (never a value in the
// environment), the messaging channels held closed, and the customer-data gate — no channel that lets a business sign
// up opens before a backup has been restored from its off-site copy. It prints names and lengths, never a value.
// Exit 1 on any failure.
import { existsSync, readFileSync } from 'node:fs';

const env = process.env;
const failures = [];
const check = (ok, message) => (ok ? null : failures.push(message));
const present = (name) => Object.prototype.hasOwnProperty.call(env, name);
const val = (name) => (env[name] ?? '').trim();
const SECRETS = process.env.PREFLIGHT_SECRETS_ROOT ?? '';
const BACKUPS = process.env.PREFLIGHT_BACKUPS_DIR ?? '/backups';

// ── Profile and identity ─────────────────────────────────────────────────────────────────────────────────────────────
const profile = val('DEPLOY_PROFILE');
const host = val('EXPECTED_API_HOST');
check(['production', 'rehearsal'].includes(profile), 'DEPLOY_PROFILE must be production or rehearsal.');
if (profile === 'production') check(host === 'api.tsxmr.com', 'The production API host is api.tsxmr.com.');
if (profile === 'rehearsal') check(/^[a-z0-9.-]+\.localhost$/.test(host), 'A rehearsal runs on a *.localhost name only.');
check(val('APP_ENV') === 'production', 'APP_ENV must be "production" (the rehearsal runs the production code paths too).');
check(val('NODE_ENV') === 'production', 'NODE_ENV must be "production".');
check(val('API_INGRESS') === 'network', 'API_INGRESS must be "network" in the container stack (one trusted hop: the edge).');
check(!val('API_BIND') || val('API_BIND') === '0.0.0.0', 'API_BIND must be unset in a container: a loopback bind is unreachable from the edge.');
check(val('PUBLIC_API_ORIGIN') === `https://${host}`, `PUBLIC_API_ORIGIN must be exactly https://${host || '<API_HOST>'} (no path, no trailing slash).`);
check(val('PORTAL_ORIGIN') === 'https://dukan.tsxmr.com', 'PORTAL_ORIGIN must be https://dukan.tsxmr.com (the owner\'s topology of 2026-10-18, docs/101 §2).');
check(!val('NODE_DEBUG'), 'NODE_DEBUG must be unset: Node\'s internal tracing bypasses the log redaction.');
check(!present('STAGING_CONTACT_OUTBOX'), 'STAGING_CONTACT_OUTBOX must not exist in production (a staging setting: production never holds codes).');

// ── Secrets: every one a readable one-line file, none a value in the environment ──────────────────────────────────────
function readSecret(name) {
  const file = val(`${name}_FILE`);
  if (!file) return { ok: false, why: `${name}_FILE is not set` };
  if (val(name)) return { ok: false, why: `${name} is also set as a value: give it as a file only` };
  try {
    const value = readFileSync(`${SECRETS}${file}`, 'utf8').replace(/\r?\n$/, '');
    if (!value.trim()) return { ok: false, why: `${name}_FILE is empty` };
    if (/[\r\n]/.test(value)) return { ok: false, why: `${name}_FILE holds more than one line` };
    return { ok: true, value };
  } catch {
    return { ok: false, why: `${name}_FILE cannot be read` };
  }
}
const PLACEHOLDER = /change|example|placeholder|secret|test|xxx|todo/i;
const keys = {};
for (const name of ['JWT_ACCESS_SECRET', 'OTP_PEPPER', 'MESSAGING_HASH_KEY', 'PLATFORM_MFA_KEY', 'STAFF_INVITATION_KEY', 'REFERRAL_KEY']) {
  const s = readSecret(name);
  check(s.ok, `${s.why ?? ''} (setup-secrets.sh writes it).`);
  if (!s.ok) continue;
  keys[name] = s.value;
  check(s.value.length >= 32, `${name} must be at least 32 characters (it is ${s.value.length}).`);
  check(!PLACEHOLDER.test(s.value), `${name} looks like a placeholder.`);
}
if (keys.PLATFORM_MFA_KEY !== undefined) {
  const mfa = keys.PLATFORM_MFA_KEY;
  const bytes = /^[0-9a-f]{64}$/i.test(mfa) ? 32 : Buffer.from(mfa, 'base64').length;
  check(bytes === 32, 'PLATFORM_MFA_KEY must be exactly 32 bytes (64 hex characters, or base64 of 32 bytes).');
}
const values = Object.values(keys);
check(new Set(values).size === values.length, 'JWT_ACCESS_SECRET, OTP_PEPPER, MESSAGING_HASH_KEY, PLATFORM_MFA_KEY, STAFF_INVITATION_KEY and REFERRAL_KEY must all be different.');

// ── Database: the application identity on the production schema, never the migrator ────────────────────────────────
function dbUrl(raw) {
  try {
    const u = new URL(raw);
    return { user: decodeURIComponent(u.username), db: u.pathname.slice(1), password: u.password.length };
  } catch {
    return null;
  }
}
const appUrl = readSecret('APP_DATABASE_URL');
check(appUrl.ok, `${appUrl.why ?? ''} (the API's database URL is a file: setup-secrets.sh writes it).`);
const app = appUrl.ok ? dbUrl(appUrl.value) : null;
check(app && app.user === 'phonestore_app' && app.db === 'phonestore' && app.password >= 16, 'APP_DATABASE_URL must connect as phonestore_app, with its generated password, to the phonestore schema.');
const tools = dbUrl(val('DATABASE_URL'));
check(tools && tools.user === 'phonestore_app' && tools.db === 'phonestore', 'DATABASE_URL (the tools) must connect as phonestore_app to the phonestore schema.');
check(!/phonestore_migrator|\/\/root[:@]/.test(`${val('DATABASE_URL')} ${appUrl.value ?? ''}`), 'Neither database URL may carry the migrator or root.');
check(!val('SHADOW_DATABASE_URL'), 'SHADOW_DATABASE_URL must be absent: production never runs `migrate dev`.');

// ── Surface ──────────────────────────────────────────────────────────────────────────────────────────────────────────
check(val('COOKIE_SECURE') === 'true', 'COOKIE_SECURE must be "true".');
check(val('SWAGGER_ENABLED') === 'false', 'SWAGGER_ENABLED must be "false".');
check(!/^(1|true|yes)$/i.test(val('SEED_DEMO')), 'SEED_DEMO must not be on.');
check(['info', 'warn', 'error'].includes(val('LOG_LEVEL') || 'info'), 'LOG_LEVEL must be info, warn or error (debug logs carry request detail).');
check(!val('PLATFORM_ADMIN_KEY'), 'PLATFORM_ADMIN_KEY must be empty: the first administrator is created from the shell, with MFA.');
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
for (const name of ['THROTTLE_TTL_SECONDS', 'THROTTLE_LIMIT', 'AUTH_THROTTLE_LIMIT', 'ACCOUNT_THROTTLE_LIMIT']) {
  check(/^\d+$/.test(val(name)), `${name} must be stated as a whole number (rate limits are part of the production contract).`);
}
check(val('UPLOAD_DIR') === '/app/uploads', 'UPLOAD_DIR must be /app/uploads, the persistent volume.');

// ── Messaging and the customer-data gate ────────────────────────────────────────────────────────────────────────────
const email = val('EMAIL_CHANNEL') || 'disabled';
const whatsapp = val('WHATSAPP_CHANNEL') || 'disabled';
check(['disabled', 'smtp'].includes(email), 'EMAIL_CHANNEL must be "disabled" or "smtp" in production.');
check(whatsapp === 'disabled', 'WHATSAPP_CHANNEL must be "disabled": WhatsApp opens only by a reviewed change, after its Meta configuration and delivery proofs (docs/100 §10).');
if (email === 'smtp') {
  const pw = readSecret('SMTP_PASSWORD');
  const user = readSecret('SMTP_USERNAME');
  check(pw.ok && user.ok, `The SMTP login and key are files (SMTP_USERNAME_FILE, SMTP_PASSWORD_FILE): ${[pw, user].filter((s) => !s.ok).map((s) => s.why).join('; ')}.`);
  check(val('SMTP_PORT') === '587', 'SMTP_PORT must be 587 (STARTTLS).');
  check(val('SMTP_HOST') !== '', 'SMTP_HOST must be set.');
}
if (profile === 'rehearsal') {
  // The rehearsal never lets the API send: the SMTP proof is a separate one-message command (email-proof.sh).
  check(email === 'disabled', 'A rehearsal keeps EMAIL_CHANNEL=disabled: the delivery proof is email-proof.sh, never the API.');
}
// Customer activation (D217, then D224): the console activated test businesses only until the owner opened it for the
// first real-store customer (2026-10-29, the reviewed change to this line). Any other value is refused.
check(['closed', 'open'].includes(val('CUSTOMER_ACTIVATION') || 'closed'), 'CUSTOMER_ACTIVATION must be "closed" or "open" (D224: opened by a reviewed decision of 2026-10-29).');
// A channel that verifies contacts is what lets a business sign up, so it is what lets customer data in: it opens
// only after an encrypted backup has been copied off the host AND restored from that copy (restore-drill.sh --offsite).
if (email !== 'disabled' || whatsapp !== 'disabled') {
  const proofFile = `${BACKUPS}/offsite-restore-proof`;
  let kind = '';
  if (existsSync(proofFile)) kind = (readFileSync(proofFile, 'utf8').match(/^kind=(\S+)$/m) ?? [])[1] ?? '';
  check(
    kind === 'storage-box',
    'A messaging channel opens sign-ups, so customer data: it needs an off-site restore proof from the Storage Box first ' +
      `(${proofFile}, kind=storage-box; today: ${kind || 'none'}). docs/100 §5.`,
  );
}

console.log(`production preflight (${profile || 'no profile'}): ${failures.length === 0 ? 'PASS' : 'FAIL'}`);
console.log(`  API https://${host || '?'} · email ${email} · WhatsApp ${whatsapp} · CORS origins ${val('CORS_ORIGINS').split(',').filter((o) => o.trim()).length} · secrets as files ${Object.keys(keys).length + (appUrl.ok ? 1 : 0)}`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
