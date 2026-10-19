import { isIngressMode, isLoopbackAddress } from './ingress';
import { parseMfaKey } from '../../platform/mfa/secret-box';

/**
 * What production may not start with.
 *
 * Every setting here already has a documented correct value, and every one of
 * them is a **fail-open default**: get it wrong and the application starts
 * happily and is quietly less safe than the documentation says it is. That is
 * the failure mode worth spending a startup crash on — a refusal to boot is
 * seen within seconds, and a session cookie travelling in clear text is not
 * seen at all.
 *
 * Nothing here is a new policy. Each rule is the one already written down:
 *
 * - `cookieSecure()` in `common/http/cookies.ts` says production must leave
 *   `COOKIE_SECURE` unset or `true`, "or session cookies travel in clear text".
 * - `main.ts` says a deployed environment must set `API_BIND=127.0.0.1` and sit
 *   behind the edge, or the administration ENDPOINTS stay reachable beside the
 *   proxy that enforces the `/admin` boundary — "the guard would then be a
 *   password alone, which is exactly the single layer the deployment is
 *   supposed to avoid while administrator MFA does not exist". That is a
 *   statement about REACHABILITY, not about a bind address — see below.
 * - `ingress.ts` says how the API port is kept private, and why that is
 *   DECLARED rather than detected. Both deployment shapes are supported.
 * - `MessagingModule` already refuses `development-log` in production. This
 *   adds nothing there; it is listed so the whole set is in one place.
 *
 * The check is deliberately NOT part of the Joi schema. Joi validates the shape
 * of one variable at a time; these are relationships between variables and the
 * environment, and expressing them as `when(...)` chains would scatter one
 * argument across six declarations.
 */

export interface ProductionGuardEnv {
  NODE_ENV?: string;
  API_INGRESS?: string;
  COOKIE_SECURE?: string;
  SWAGGER_ENABLED?: string;
  API_BIND?: string;
  CORS_ORIGINS?: string;
  JWT_ACCESS_SECRET?: string;
  APP_DATABASE_URL?: string;
  WHATSAPP_CHANNEL?: string;
  WHATSAPP_API_BASE_URL?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_TEMPLATE_AUTH_OTP?: string;
  WHATSAPP_TEMPLATE_ACCOUNT_DELETION?: string;
  WHATSAPP_TEMPLATE_ACCOUNT_DELETED?: string;
  WHATSAPP_TEMPLATE_DELIVERY_CHECK?: string;
  WHATSAPP_TEMPLATE_PORTAL_INSTRUCTIONS?: string;
  WHATSAPP_TEMPLATE_TRIAL_REMINDER?: string;
  WHATSAPP_TEMPLATE_TRIAL_EXPIRED?: string;
  WHATSAPP_TEMPLATE_PAID_REMINDER?: string;
  WHATSAPP_TEMPLATE_GRACE_STARTED?: string;
  WHATSAPP_TEMPLATE_NO_GRACE?: string;
  WHATSAPP_TEMPLATE_GRACE_REMINDER?: string;
  WHATSAPP_TEMPLATE_GRACE_ENDED?: string;
  EMAIL_CHANNEL?: string;
  EMAIL_FROM?: string;
  RESEND_API_KEY?: string;
  RESEND_API_BASE_URL?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_WEBHOOK_VERIFY_TOKEN?: string;
  WHATSAPP_MODE?: string;
  WHATSAPP_TEST_RECIPIENTS?: string;
  WHATSAPP_LIVE_SENDS?: string;
  WHATSAPP_APP_ID?: string;
  MESSAGING_HASH_KEY?: string;
  EMAIL_FROM_VERIFICATION?: string;
  EMAIL_FROM_NOTIFICATIONS?: string;
  EMAIL_FROM_REPORTS?: string;
  EMAIL_FROM_RECEIPTS?: string;
  EMAIL_REPLY_TO?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USERNAME?: string;
  SMTP_PASSWORD?: string;
  OTP_PEPPER?: string;
  APP_ENV?: string;
  PLATFORM_ADMIN_KEY?: string;
  PLATFORM_MFA_KEY?: string;
  STAFF_INVITATION_KEY?: string;
  SEED_DEMO?: string;
  PORTAL_ORIGIN?: string;
  SMTP_PASSWORD_FILE?: string;
  STAGING_CONTACT_OUTBOX?: string;
  NODE_DEBUG?: string;
}

/** A sender address that is real: an address (optionally "Name <address>") on no example or test domain. */
function realSender(value: string): boolean {
  const address = value.replace(/^.*<([^>]+)>\s*$/, '$1').trim();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address) && !/example\.|\.test\b|\.invalid\b|localhost/i.test(address);
}

/** A `.env` value that means "yes", matching `cookieSecure()`. */
const truthy = (v: string | undefined): boolean => {
  const s = v?.trim().toLowerCase();
  return s === 'true' || s === '1';
};
const falsy = (v: string | undefined): boolean => {
  const s = v?.trim().toLowerCase();
  return s === 'false' || s === '0';
};

/** `https://host[:port]` and nothing more: exactly what the URL parser gives back as the value's own origin. */
function isHttpsOrigin(value: string | undefined): boolean {
  const v = value?.trim() ?? '';
  try {
    const url = new URL(v);
    return url.protocol === 'https:' && url.origin === v;
  } catch {
    return false;
  }
}

/**
 * Every reason this environment must not run as production.
 *
 * Returns the empty array outside production: these are deployment rules, and
 * applying them to a developer's machine would break the LAN testing the
 * project depends on — a phone on the same Wi-Fi has to reach `0.0.0.0`, and
 * `docs/39` keeps a plain-HTTP LAN path open on purpose.
 */
export function productionConfigProblems(env: ProductionGuardEnv): string[] {
  if (env.NODE_ENV !== 'production') return [];

  const problems: string[] = [];

  // A Secure cookie is discarded by a browser on plain HTTP, so turning this
  // off is how a session cookie ends up travelling in clear text.
  if (falsy(env.COOKIE_SECURE)) {
    problems.push(
      'COOKIE_SECURE is false. In production this puts session cookies in clear text. ' +
        'Leave it unset, or set it to true.',
    );
  }

  // The API surface, published. Not a vulnerability by itself, and a map of
  // every route and payload shape handed to anyone who asks. The schema
  // default is `true`, so production requires an explicit `false`: a variable
  // nobody set published `/docs` while this check looked only for `true`.
  if (!falsy(env.SWAGGER_ENABLED)) {
    problems.push(
      `SWAGGER_ENABLED is ${env.SWAGGER_ENABLED?.trim() ? 'not false' : 'unset, and defaults to true'}. ` +
        'Production must not publish the API documentation. Set SWAGGER_ENABLED=false.',
    );
  }

  /*
   * How the API port is kept private — declared, not guessed.
   *
   * An earlier version of this guard rejected 0.0.0.0 outright. That was
   * wrong: it encoded ONE of the two correct implementations as if it were the
   * invariant, and it would have refused to start this project's own staging
   * stack, whose compose file says in as many words not to bind loopback
   * inside a container. See `ingress.ts` for the invariant that actually
   * holds. Both modes are equally supported and neither is recommended here.
   */
  if (!isIngressMode(env.API_INGRESS)) {
    problems.push(
      'API_INGRESS is not set. Production must declare how the API port is kept ' +
        'private: "loopback" (the API binds 127.0.0.1 on a host it shares with the ' +
        'edge) or "network" (the API is on a private network or container and the ' +
        'edge is the only thing that can reach it). Both are supported.',
    );
  } else if (env.API_INGRESS === 'loopback' && !isLoopbackAddress(env.API_BIND)) {
    problems.push(
      `API_INGRESS=loopback but API_BIND is ${env.API_BIND ?? 'unset (defaults to 0.0.0.0)'}. ` +
        'On a shared host the bind address IS the isolation, so /api/* would be ' +
        'reachable without the proxy that enforces the /admin boundary. ' +
        'Set API_BIND=127.0.0.1, or declare API_INGRESS=network if the network ' +
        'already isolates the port.',
    );
  }

  /*
   * An empty CORS list is FAIL-CLOSED — `main.ts` turns it into `origin: false`
   * — so it is allowed here. What is not allowed is a production origin list
   * that still names a development host: that is a copied `.env`, and it grants
   * a real browser on a developer's machine a credentialed cross-origin path
   * into production data.
   */
  const devOrigins = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => /localhost|127\.0\.0\.1|\b10\.|\b192\.168\.|\b172\.(1[6-9]|2\d|3[01])\./.test(o));
  if (devOrigins.length > 0) {
    problems.push(
      `CORS_ORIGINS names development hosts in production: ${devOrigins.join(', ')}. ` +
        'This is a copied .env — remove them.',
    );
  }

  // Joi already enforces a 32-character minimum. What it cannot see is that the
  // value is the one committed in `.env.example` for everyone to read.
  if (env.JWT_ACCESS_SECRET && /change|example|secret|placeholder|test/i.test(env.JWT_ACCESS_SECRET)) {
    problems.push(
      'JWT_ACCESS_SECRET looks like a placeholder from an example file. ' +
        'Generate a real one.',
    );
  }

  /*
   * Transport (docs/48 §7.1, control 19).
   *
   * The edge terminates TLS, so the process cannot see its own scheme — but it
   * can refuse the configuration that only makes sense on plain HTTP. A browser
   * origin on `http://` in production is a portal serving session cookies in
   * clear text, and a provider address on `http://` is a token in clear text.
   */
  // A development host is already reported above; reporting it twice would
  // bury the more specific message.
  const plainOrigins = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0 && !/^https:\/\//i.test(o) && !devOrigins.includes(o));
  if (plainOrigins.length > 0) {
    problems.push(
      `CORS_ORIGINS names non-HTTPS origins in production: ${plainOrigins.join(', ')}. ` +
        'Every browser origin must be https://.',
    );
  }
  // A wildcard is never an origin: every browser origin is named exactly, or none is (D200).
  if ((env.CORS_ORIGINS ?? '').includes('*')) {
    problems.push('CORS_ORIGINS contains a wildcard. Name each https:// origin exactly, or leave it empty.');
  }
  // Node's own debug tracing (net, tls, http…) writes connection internals to the log, outside every redaction.
  if (env.NODE_DEBUG?.trim()) {
    problems.push('NODE_DEBUG is set. Production never traces Node internals: they bypass the log redaction.');
  }
  const channel = (env.WHATSAPP_CHANNEL ?? 'disabled').trim().toLowerCase();
  if (channel === 'development-log') {
    problems.push('WHATSAPP_CHANNEL=development-log writes one-time codes to a log sink. Use cloud or disabled.');
  }
  if (channel === 'cloud' || channel === 'cloud-api') {
    if (env.WHATSAPP_API_BASE_URL && !/^https:\/\//i.test(env.WHATSAPP_API_BASE_URL.trim())) {
      problems.push('WHATSAPP_API_BASE_URL must be an https:// address in production.');
    }
    if (!env.WHATSAPP_PHONE_NUMBER_ID?.trim() || !env.WHATSAPP_ACCESS_TOKEN?.trim()) {
      problems.push(
        'WHATSAPP_CHANNEL=cloud-api without WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN. ' +
          'Set both, or set WHATSAPP_CHANNEL=disabled — nothing is faked.',
      );
    }
    if (!env.WHATSAPP_TEMPLATE_AUTH_OTP?.trim() || !env.WHATSAPP_TEMPLATE_ACCOUNT_DELETION?.trim()) {
      problems.push(
        'WHATSAPP_CHANNEL=cloud-api needs the approved template names WHATSAPP_TEMPLATE_AUTH_OTP and ' +
          'WHATSAPP_TEMPLATE_ACCOUNT_DELETION; without them sign-in codes and account deletion cannot be delivered.',
      );
    }
    if (!env.OTP_PEPPER || env.OTP_PEPPER.length < 32) {
      problems.push('WHATSAPP_CHANNEL=cloud-api needs OTP_PEPPER (32+ characters), or no code can be issued.');
    }
    /*
     * Delivery is proven on the deployment before anything is claimed (docs/64; messaging/delivery-readiness.ts):
     * the proof is completed only by the signed webhook, so production needs the webhook, the delivery-check
     * template that carries the proof, and the completion template a deletion sends.
     */
    if (!env.WHATSAPP_APP_SECRET?.trim() || !env.WHATSAPP_WEBHOOK_VERIFY_TOKEN?.trim()) {
      problems.push(
        'WHATSAPP_CHANNEL=cloud-api needs WHATSAPP_APP_SECRET and WHATSAPP_WEBHOOK_VERIFY_TOKEN in production: only a signed ' +
          'delivery report can prove delivery, and without the proof the channel stays closed.',
      );
    }
    if (!env.WHATSAPP_TEMPLATE_DELIVERY_CHECK?.trim() || !env.WHATSAPP_TEMPLATE_ACCOUNT_DELETED?.trim()) {
      problems.push(
        'WHATSAPP_CHANNEL=cloud-api needs the approved template names WHATSAPP_TEMPLATE_DELIVERY_CHECK (the operator\'s ' +
          'delivery proof) and WHATSAPP_TEMPLATE_ACCOUNT_DELETED (the deletion completion notice).',
      );
    }
    // The portal and subscription templates (WHATSAPP_TEMPLATE_PORTAL_INSTRUCTIONS and the seven lifecycle ones) are
    // deliberately NOT required: without one, WhatsApp cannot carry that message, the recorded email fallback is tried
    // (a verified email only), the status says so honestly, and the Owner can still start the trial on the portal.

    /*
     * Test and live sending are separate (D181 §4). Test mode reaches only an exact allowlist, so it needs one, and
     * an "enabled" live switch in test mode is a contradiction worth a refusal rather than a guess. Live mode needs
     * the explicit switch and the app id the start-up credential check uses (messaging/whatsapp-live-check.ts).
     */
    const mode = (env.WHATSAPP_MODE ?? 'test').trim().toLowerCase();
    const liveSends = (env.WHATSAPP_LIVE_SENDS ?? 'disabled').trim().toLowerCase();
    if (mode === 'live') {
      if (liveSends !== 'enabled') {
        problems.push('WHATSAPP_MODE=live needs WHATSAPP_LIVE_SENDS=enabled, stated explicitly. Otherwise use WHATSAPP_MODE=test.');
      }
      if (!/^\d+$/.test(env.WHATSAPP_APP_ID?.trim() ?? '')) {
        problems.push('WHATSAPP_MODE=live needs WHATSAPP_APP_ID: the access token is checked with the provider at start-up.');
      }
    } else {
      const recipients = (env.WHATSAPP_TEST_RECIPIENTS ?? '').split(/[\s,;]+/).filter(Boolean);
      if (recipients.length === 0 || recipients.some((n) => !/^\+[1-9]\d{7,14}$/.test(n))) {
        problems.push('WHATSAPP_MODE=test needs WHATSAPP_TEST_RECIPIENTS: the exact E.164 numbers test sends may reach, and nothing else.');
      }
      if (liveSends === 'enabled') {
        problems.push('WHATSAPP_LIVE_SENDS=enabled has no meaning in test mode. Set WHATSAPP_MODE=live, or WHATSAPP_LIVE_SENDS=disabled.');
      }
    }
    if (!env.MESSAGING_HASH_KEY || env.MESSAGING_HASH_KEY.trim().length < 32) {
      problems.push('WHATSAPP_CHANNEL=cloud needs MESSAGING_HASH_KEY (32+ characters): message records key every number with it.');
    }
  }

  // Email (messaging/email-channel.ts): the same rules as WhatsApp — nothing faked, nothing in clear text.
  const email = (env.EMAIL_CHANNEL ?? 'disabled').trim().toLowerCase();
  if (email === 'development-log') {
    problems.push('EMAIL_CHANNEL=development-log only logs that an email would go out. Use smtp or disabled.');
  }
  if (email === 'smtp') {
    // Brevo's relay (D181): credentials, port 587 (STARTTLS, enforced by the transport), real senders and Reply-To.
    if (!env.SMTP_USERNAME?.trim() || !env.SMTP_PASSWORD) {
      problems.push('EMAIL_CHANNEL=smtp without SMTP_USERNAME and SMTP_PASSWORD. Set both from the secret manager, or set EMAIL_CHANNEL=disabled.');
    }
    if (env.SMTP_PORT !== undefined && env.SMTP_PORT.trim() !== '' && env.SMTP_PORT.trim() !== '587') {
      problems.push('SMTP_PORT must be 587 in production: STARTTLS is required.');
    }
    const fallback = env.EMAIL_FROM?.trim() ?? '';
    const classes = { EMAIL_FROM_VERIFICATION: env.EMAIL_FROM_VERIFICATION, EMAIL_FROM_NOTIFICATIONS: env.EMAIL_FROM_NOTIFICATIONS };
    for (const [name, value] of Object.entries(classes)) {
      const sender = value?.trim() || fallback;
      if (!realSender(sender)) {
        problems.push(`${name} (or EMAIL_FROM) must be a real sender on a domain with SPF, DKIM and DMARC, not an example address.`);
      }
    }
    for (const [name, value] of Object.entries({ EMAIL_FROM: env.EMAIL_FROM, EMAIL_FROM_REPORTS: env.EMAIL_FROM_REPORTS, EMAIL_FROM_RECEIPTS: env.EMAIL_FROM_RECEIPTS })) {
      if (value?.trim() && !realSender(value.trim())) problems.push(`${name} must be a real sender address, not an example address.`);
    }
    if (!realSender(env.EMAIL_REPLY_TO?.trim() ?? '')) {
      problems.push('EMAIL_REPLY_TO must be the real support address every email answers to.');
    }
    if (!env.OTP_PEPPER || env.OTP_PEPPER.length < 32) {
      problems.push('EMAIL_CHANNEL=smtp needs OTP_PEPPER (32+ characters): verification codes are stored as keyed hashes.');
    }
  }
  if ((email === 'smtp' || email === 'resend') && (!env.MESSAGING_HASH_KEY || env.MESSAGING_HASH_KEY.trim().length < 32)) {
    problems.push(`EMAIL_CHANNEL=${email} needs MESSAGING_HASH_KEY (32+ characters): email records key every address with it.`);
  }
  if (email === 'resend') {
    if (!env.RESEND_API_KEY?.trim()) problems.push('EMAIL_CHANNEL=resend without RESEND_API_KEY. Set it, or set EMAIL_CHANNEL=disabled.');
    const from = env.EMAIL_FROM?.trim() ?? '';
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(from.replace(/^.*<([^>]+)>$/, '$1')) || /example\.|\.test\b|\.invalid\b|localhost/i.test(from)) {
      problems.push('EMAIL_FROM must be a real sender on a domain with SPF, DKIM and DMARC (docs/64), not an example address.');
    }
    if (env.RESEND_API_BASE_URL && !/^https:\/\//i.test(env.RESEND_API_BASE_URL.trim())) {
      problems.push('RESEND_API_BASE_URL must be an https:// address in production.');
    }
    if (!env.OTP_PEPPER || env.OTP_PEPPER.length < 32) {
      problems.push('EMAIL_CHANNEL=resend needs OTP_PEPPER (32+ characters): verification codes are stored as keyed hashes.');
    }
  }
  const hasSecret = Boolean(env.WHATSAPP_APP_SECRET?.trim());
  const hasVerify = Boolean(env.WHATSAPP_WEBHOOK_VERIFY_TOKEN?.trim());
  if (hasSecret !== hasVerify) {
    problems.push(
      'WHATSAPP_APP_SECRET and WHATSAPP_WEBHOOK_VERIFY_TOKEN must be set together (the delivery webhook), or neither.',
    );
  }

  /*
   * The legacy static-key provisioning route (docs/48 risk R5). The route
   * itself refuses in production; a key configured there is a copied
   * staging `.env`, and a static secret that grants subscription changes
   * with no person behind it must not exist on a production host at all.
   */
  if ((env.APP_ENV ?? '').toLowerCase() !== 'staging' && env.PLATFORM_ADMIN_KEY?.trim()) {
    problems.push(
      'PLATFORM_ADMIN_KEY is set. The static-key provisioning route is closed in production; ' +
        'use the platform administrator API and remove the key.',
    );
  }

  /*
   * Administrator MFA is mandatory (0094): without its key no administrator session can complete, and the
   * administration portal would be a password alone — the single layer the deployment must not rest on.
   */
  if (!parseMfaKey(env.PLATFORM_MFA_KEY)) {
    problems.push('PLATFORM_MFA_KEY is missing or malformed. Production needs a 32-byte key (base64, or 64 hex characters) to seal administrator TOTP secrets.');
  }

  /*
   * Employee invitations (0101, D214): every employee activates from one, and its reference is stored only as a hash
   * under this key. Without it no employee could ever be activated.
   */
  if ((env.STAFF_INVITATION_KEY ?? '').trim().length < 32) {
    problems.push('STAFF_INVITATION_KEY is missing or shorter than 32 characters. Employee invitation references are stored only as hashes under it: without it no employee can be activated.');
  }

  /*
   * The production environment proper (APP_ENV=production, docs/100): stricter than staging, which runs the same code
   * paths with NODE_ENV=production on purpose. Two copied-from-staging mistakes are refused by name (D200):
   *  - the SMTP key must arrive as a file (SMTP_PASSWORD_FILE, `secret-files.ts`), so it is in no environment
   *    `docker inspect` can show;
   *  - the staging code outbox flag must not exist at all. The code already ignores it in production
   *    (`contact-delivery.ts`); a flag that is set is a staging file deployed as production.
   */
  if ((env.APP_ENV ?? '').trim().toLowerCase() === 'production') {
    if (email === 'smtp' && !env.SMTP_PASSWORD_FILE?.trim()) {
      problems.push('APP_ENV=production reads the SMTP key from a file: set SMTP_PASSWORD_FILE (a read-only secret), not SMTP_PASSWORD.');
    }
    if (env.STAGING_CONTACT_OUTBOX?.trim()) {
      problems.push('STAGING_CONTACT_OUTBOX is set in production. It is a staging setting: remove it (production never holds codes).');
    }
  }

  // Demo data is opt-in everywhere and refused here regardless (docs/48 risk R7).
  if (truthy(env.SEED_DEMO)) {
    problems.push('SEED_DEMO is true. No demo company, demo owner or fixture password may exist in production.');
  }

  /*
   * The portal instructions and every subscription message carry one address: <PORTAL_ORIGIN>/subscription (0099).
   * A plain-http origin would send the Owner to a page that can be read or changed on the way, and a path or a
   * trailing slash writes an address that does not exist — so production takes an https:// origin and nothing after
   * it, and the production environment proper only the owner's portal. It writes an address and nothing else: no
   * request is ever compared with it.
   */
  if (!isHttpsOrigin(env.PORTAL_ORIGIN)) {
    problems.push(
      "PORTAL_ORIGIN must be the Dukan ERP portal's https:// origin with no path, e.g. https://dukan.tsxmr.com: " +
        'the portal instructions and the subscription messages carry <PORTAL_ORIGIN>/subscription.',
    );
  } else if ((env.APP_ENV ?? '').trim().toLowerCase() === 'production' && env.PORTAL_ORIGIN !== 'https://dukan.tsxmr.com') {
    problems.push('APP_ENV=production writes https://dukan.tsxmr.com/subscription into its messages: set PORTAL_ORIGIN=https://dukan.tsxmr.com exactly.');
  }

  /*
   * A localhost database URL is NOT checked, deliberately.
   *
   * It was, briefly, on the theory that it looked like a copied development
   * `.env`. That is an assumption about architecture, not an invariant: an
   * application and its MySQL on one VPS connect over loopback, and that is a
   * perfectly ordinary single-host deployment. Refusing it would have been the
   * same mistake as the blanket bind rejection above — encoding one deployment
   * shape as if it were a security property.
   *
   * What actually catches a copied `.env` is the placeholder check above, which
   * tests the VALUE rather than the topology.
   */

  return problems;
}

/**
 * Refuse to start rather than start wrong.
 *
 * Throwing is the point. Every one of these has a silent failure mode, and a
 * process that exits with the reason on stdout is the only version anybody
 * notices.
 */
export function assertProductionConfig(env: ProductionGuardEnv = process.env): void {
  const problems = productionConfigProblems(env);
  if (problems.length === 0) return;

  throw new Error(
    `Refusing to start in production with unsafe configuration:\n` +
      problems.map((p) => `  - ${p}`).join('\n'),
  );
}
