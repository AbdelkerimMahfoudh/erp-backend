import { readFileSync } from 'node:fs';
import { assertProductionConfig, productionConfigProblems } from './production-guard';

/**
 * The settings production may not start with.
 *
 * Each of these already had a documented correct value and no enforcement, so
 * the failure mode was identical every time: the application starts, and is
 * quietly less safe than the documentation says. These tests pin the refusal.
 */

/** A production environment with nothing wrong with it. */
const SAFE = {
  NODE_ENV: 'production',
  API_INGRESS: 'loopback',
  COOKIE_SECURE: 'true',
  SWAGGER_ENABLED: 'false',
  API_BIND: '127.0.0.1',
  CORS_ORIGINS: 'https://app.example.com',
  JWT_ACCESS_SECRET: 'PLQ7wq2mZk4tR9vXbN1sYdF6hJ3gC8aE',
  APP_DATABASE_URL: 'mysql://app:pw@db.internal:3306/erp',
  // 32 bytes, base64 (0094) — a test value, not a key anyone uses.
  PLATFORM_MFA_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
  // The website the free trial's setup links point to (0095).
  PORTAL_ORIGIN: 'https://dukan.example.com',
};

describe('outside production', () => {
  it.each(['development', 'test', undefined])('says nothing when NODE_ENV is %p', (env) => {
    /*
     * Deliberately silent. These are deployment rules, and applying them to a
     * developer's machine would break the LAN testing the project depends on —
     * a phone on the same Wi-Fi has to reach 0.0.0.0, and `docs/39` keeps a
     * plain-HTTP LAN path open on purpose.
     */
    expect(
      productionConfigProblems({ ...SAFE, NODE_ENV: env, COOKIE_SECURE: 'false', API_BIND: '0.0.0.0' }),
    ).toEqual([]);
  });
});

describe('a correct production environment', () => {
  it('starts', () => {
    expect(productionConfigProblems(SAFE)).toEqual([]);
    expect(() => assertProductionConfig(SAFE)).not.toThrow();
  });

  it('accepts an unset COOKIE_SECURE, because unset already means secure', () => {
    const { COOKIE_SECURE, ...withoutIt } = SAFE;
    expect(COOKIE_SECURE).toBe('true'); // the fixture really did have one
    expect(productionConfigProblems(withoutIt)).toEqual([]);
  });

  it('accepts an empty CORS list, because empty is fail-closed', () => {
    // `main.ts` turns an empty list into `origin: false`. Denying everything is
    // a deployment that has not been finished, not a deployment that is unsafe.
    expect(productionConfigProblems({ ...SAFE, CORS_ORIGINS: '' })).toEqual([]);
  });
});

describe('the settings that fail open', () => {
  it('refuses COOKIE_SECURE=false', () => {
    // A Secure cookie is discarded by a browser on plain HTTP, so turning this
    // off is exactly how a session cookie travels in clear text.
    const problems = productionConfigProblems({ ...SAFE, COOKIE_SECURE: 'false' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('clear text');
  });

  it.each(['false', '0'])('treats %p as off', (value) => {
    expect(productionConfigProblems({ ...SAFE, COOKIE_SECURE: value })).toHaveLength(1);
  });

  it.each([undefined, '', 'yes'])('refuses SWAGGER_ENABLED=%p: only an explicit false keeps /docs closed', (value) => {
    // Left unset, the schema's default `true` published the API documentation while this guard looked only for
    // `true` (production-readiness review BE2-01, 2026-10-16).
    const problems = productionConfigProblems({ ...SAFE, SWAGGER_ENABLED: value });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('SWAGGER_ENABLED');
  });

  it('refuses SWAGGER_ENABLED=true', () => {
    // The schema default is `true`, so this is what happens when nobody says
    // otherwise — the whole API surface published to anyone who asks.
    const problems = productionConfigProblems({ ...SAFE, SWAGGER_ENABLED: 'true' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('SWAGGER_ENABLED');
  });

  it.each([
    'http://localhost:8081',
    'http://127.0.0.1:3000',
    'http://192.168.100.3:8081',
    'http://10.0.0.5',
    'http://172.16.4.2',
  ])('refuses the development origin %p in production', (origin) => {
    // A production origin list still naming a dev host is a copied .env, and it
    // grants a browser on somebody's laptop a credentialed path into real data.
    const problems = productionConfigProblems({ ...SAFE, CORS_ORIGINS: `https://app.example.com,${origin}` });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(origin);
  });

  it('does not mistake a real hostname for a private address', () => {
    // `1721.example.com` and `notlocalhost.io` must not trip the pattern.
    expect(
      productionConfigProblems({ ...SAFE, CORS_ORIGINS: 'https://1721.example.com,https://app.notlocal.io' }),
    ).toEqual([]);
  });

  it.each(['change-me-please-this-is-32-chars-x', 'example-secret-value-padded-to-32ch'])(
    'refuses the placeholder secret %p',
    (secret) => {
      // Joi enforces the LENGTH. What it cannot see is that the value is the one
      // committed in `.env.example` for everyone to read.
      const problems = productionConfigProblems({ ...SAFE, JWT_ACCESS_SECRET: secret });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('JWT_ACCESS_SECRET');
    },
  );

  it('does NOT flag a localhost database URL', () => {
    /*
     * Deliberately allowed. An application and its MySQL on one VPS connect
     * over loopback, and that is an ordinary single-host deployment — refusing
     * it would repeat the blanket-bind mistake, encoding one architecture as a
     * security property. A copied .env is caught by the placeholder secret
     * check, which tests the value rather than the topology.
     */
    expect(
      productionConfigProblems({ ...SAFE, APP_DATABASE_URL: 'mysql://app:pw@localhost:3306/erp' }),
    ).toEqual([]);
  });

  it('reports every problem at once, not the first', () => {
    // An operator fixing one and restarting into the next is three restarts.
    const problems = productionConfigProblems({
      NODE_ENV: 'production',
      COOKIE_SECURE: 'false',
      SWAGGER_ENABLED: 'true',
      API_BIND: '0.0.0.0',
    });
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe('the refusal itself', () => {
  it('throws, and says why', () => {
    expect(() => assertProductionConfig({ ...SAFE, COOKIE_SECURE: 'false' })).toThrow(
      /Refusing to start[\s\S]*clear text/,
    );
  });

  it('runs before anything is built or bound', () => {
    /*
     * Order matters: a guard that runs after `app.listen` has already opened
     * the port it was meant to keep shut. Read from source because the
     * alternative is booting the application to prove it did not boot.
     */
    const main = readFileSync('src/main.ts', 'utf8');
    const guard = main.indexOf('assertProductionConfig()');
    const create = main.indexOf('NestFactory.create');
    const listen = main.indexOf('app.listen');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(create);
    expect(guard).toBeLessThan(listen);
  });
});

describe('the auth rate limit is a real control', () => {
  it('reads AUTH_THROTTLE_LIMIT instead of hardcoding it', () => {
    /*
     * It was validated by Joi, exposed on AppConfigService, and consumed by
     * nothing: an operator tightening it after a credential-stuffing attempt
     * would have changed nothing, and nothing would have said so. Dead
     * configuration is worse than none, because it looks like a control.
     */
    const controller = readFileSync('src/auth/auth.controller.ts', 'utf8');
    expect(controller).toMatch(/process\.env\.AUTH_THROTTLE_LIMIT/);
    expect(controller).toMatch(/limit: AUTH_THROTTLE_LIMIT/);
  });

  it('falls back to the schema default when unset', () => {
    const controller = readFileSync('src/auth/auth.controller.ts', 'utf8');
    const schema = readFileSync('src/common/config/env.validation.ts', 'utf8');
    // The fallback and the Joi default must be the same number, or a missing
    // variable behaves differently from a present one.
    expect(controller).toMatch(/\|\| 10;/);
    expect(schema).toMatch(/AUTH_THROTTLE_LIMIT:.*default\(10\)/);
  });
});

describe('how the API port is kept private', () => {
  /*
   * The rule this replaced was wrong, and wrong in a way that would have been
   * discovered by a failed deployment rather than by a test.
   *
   * `docs/39` §3 states the invariant: "the API binds loopback only
   * (API_BIND=127.0.0.1) and is reachable solely through the edge; under Docker
   * the same is achieved with `expose` rather than `ports`." The invariant is
   * REACHABILITY. Two implementations satisfy it, and they need opposite bind
   * addresses — so a blanket rejection of 0.0.0.0 encodes one of them as if it
   * were the rule, and refuses the other.
   */

  describe('a container or private network — the staging stack', () => {
    const CONTAINER = { ...SAFE, API_INGRESS: 'network', API_BIND: undefined };

    it('starts with the default bind, which is what a container needs', () => {
      // `deploy/docker-compose.staging.yml`: "Do NOT set API_BIND=127.0.0.1
      // here... Inside a container it would bind the container's own loopback
      // and the edge could never reach it."
      expect(productionConfigProblems(CONTAINER)).toEqual([]);
    });

    it.each(['0.0.0.0', '::', undefined])('accepts API_BIND=%p', (bind) => {
      expect(productionConfigProblems({ ...CONTAINER, API_BIND: bind })).toEqual([]);
    });

    it('would have been refused by the previous rule', () => {
      // The regression this test exists for: the project's own staging stack
      // could not have started.
      expect(productionConfigProblems({ ...CONTAINER, API_BIND: '0.0.0.0' })).toEqual([]);
    });
  });

  describe('directly on a host shared with the edge', () => {
    it('accepts a loopback bind', () => {
      expect(productionConfigProblems({ ...SAFE, API_INGRESS: 'loopback' })).toEqual([]);
    });

    it.each(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1'])(
      'recognises %p as loopback',
      (bind) => {
        expect(productionConfigProblems({ ...SAFE, API_INGRESS: 'loopback', API_BIND: bind })).toEqual([]);
      },
    );

    it.each(['0.0.0.0', '192.168.1.10', undefined])('refuses a reachable bind of %p', (bind) => {
      // Here the bind address IS the isolation. Nothing else is protecting it.
      const problems = productionConfigProblems({ ...SAFE, API_INGRESS: 'loopback', API_BIND: bind });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('/admin boundary');
    });
  });

  describe('the declaration itself', () => {
    it('is required in production, because it cannot be detected', () => {
      /*
       * `/.dockerenv` is a convention, not a guarantee; a container can run
       * with --network host; a bare-metal process can sit behind a firewall
       * that isolates it just as well. Guessing is silent in both directions.
       */
      const problems = productionConfigProblems({ ...SAFE, API_INGRESS: undefined });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('API_INGRESS');
    });

    it.each(['docker', 'proxy', 'TRUE', ''])('refuses the unknown value %p', (mode) => {
      expect(productionConfigProblems({ ...SAFE, API_INGRESS: mode })).toHaveLength(1);
    });

    it('recommends neither mode', () => {
      // The owner chooses the architecture. This file must not choose it for
      // them by making one option sound like the safe one.
      const source = readFileSync('src/common/config/ingress.ts', 'utf8');
      expect(source).toMatch(/does not choose an architecture|equally supported/i);
    });

    it('is not required outside production', () => {
      expect(productionConfigProblems({ NODE_ENV: 'development' })).toEqual([]);
    });
  });
});

describe('who the client is behind a proxy', () => {
  /*
   * `req.ip` is what the rate limiter keys on and what the login audit row
   * records. Express defaults it to the socket peer, which behind the edge is
   * the EDGE — so without trust configured, AUTH_THROTTLE_LIMIT is a budget
   * shared by every user on the platform rather than a per-client one.
   */
  const { trustProxySetting } = require('./ingress');

  it('trusts exactly one hop on a private network', () => {
    // One: the edge appended the client address and rewrote anything claimed
    // beyond it. Trusting more would let a client choose its own bucket.
    expect(trustProxySetting('network')).toBe(1);
  });

  it('trusts only loopback peers on a shared host', () => {
    expect(trustProxySetting('loopback')).toBe('loopback');
  });

  it('trusts nothing when no ingress is declared', () => {
    // Development. `req.ip` is the peer, which on a laptop is the truth — and
    // trusting headers on a directly reachable API lets anyone forge them.
    expect(trustProxySetting(undefined)).toBe(false);
  });

  it('is wired from the declared ingress, not switched on generally', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    expect(main).toMatch(/trust proxy'?\s*,\s*trustProxySetting\(/);
    expect(main).not.toMatch(/'trust proxy',\s*true/);
  });
});

describe('the legacy provisioning key and the demo seed (docs/48 R5, R7)', () => {
  it('refuses a static provisioning key in production', () => {
    const problems = productionConfigProblems({ ...SAFE, PLATFORM_ADMIN_KEY: 'a-sixteen-char-key-or-longer' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('PLATFORM_ADMIN_KEY');
  });

  it('still lets staging keep the key for its tooling', () => {
    expect(
      productionConfigProblems({ ...SAFE, APP_ENV: 'staging', PLATFORM_ADMIN_KEY: 'a-sixteen-char-key-or-longer' }),
    ).toEqual([]);
  });

  it('refuses SEED_DEMO=true in production', () => {
    const problems = productionConfigProblems({ ...SAFE, SEED_DEMO: 'true' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('SEED_DEMO');
  });

  it('accepts an unset or false SEED_DEMO', () => {
    expect(productionConfigProblems({ ...SAFE, SEED_DEMO: 'false' })).toEqual([]);
    expect(productionConfigProblems({ ...SAFE, SEED_DEMO: undefined })).toEqual([]);
  });
});

describe('the WhatsApp channel in production (docs/48 control 19, docs/64)', () => {
  it('refuses the development channel', () => {
    expect(productionConfigProblems({ ...SAFE, WHATSAPP_CHANNEL: 'development-log' })[0]).toContain('development-log');
  });

  it('refuses cloud-api without credentials, template names and a pepper', () => {
    const problems = productionConfigProblems({ ...SAFE, WHATSAPP_CHANNEL: 'cloud-api' });
    expect(problems.join('\n')).toMatch(/WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN/);
    expect(problems.join('\n')).toMatch(/WHATSAPP_TEMPLATE_AUTH_OTP and\s+WHATSAPP_TEMPLATE_ACCOUNT_DELETION/);
    expect(problems.join('\n')).toMatch(/OTP_PEPPER/);
  });

  it('accepts a complete cloud-api configuration', () => {
    expect(
      productionConfigProblems({
        ...SAFE,
        WHATSAPP_CHANNEL: 'cloud-api',
        WHATSAPP_API_BASE_URL: 'https://graph.facebook.com',
        WHATSAPP_PHONE_NUMBER_ID: '1234567890',
        WHATSAPP_ACCESS_TOKEN: 'EAAB-real-token',
        WHATSAPP_TEMPLATE_AUTH_OTP: 'erp_auth_code',
        WHATSAPP_TEMPLATE_ACCOUNT_DELETION: 'erp_delete_code',
        WHATSAPP_TEMPLATE_ACCOUNT_DELETED: 'erp_deleted',
        WHATSAPP_TEMPLATE_DELIVERY_CHECK: 'erp_delivery_check',
        WHATSAPP_APP_SECRET: 'app-secret',
        WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'verify-token',
        OTP_PEPPER: 'a-pepper-that-is-at-least-32-characters-long',
        // D181: test mode (the default) reaches only its allowlist, and the records need their key.
        WHATSAPP_TEST_RECIPIENTS: '+22236000000',
        MESSAGING_HASH_KEY: 'a-messaging-hash-key-of-at-least-32-characters',
      }),
    ).toEqual([]);
  });

  it('refuses cloud-api without the signed webhook or the proof and completion templates: delivery could never be proven (correction phase)', () => {
    const problems = productionConfigProblems({
      ...SAFE,
      WHATSAPP_CHANNEL: 'cloud-api',
      WHATSAPP_PHONE_NUMBER_ID: '1234567890',
      WHATSAPP_ACCESS_TOKEN: 'EAAB-real-token',
      WHATSAPP_TEMPLATE_AUTH_OTP: 'erp_auth_code',
      WHATSAPP_TEMPLATE_ACCOUNT_DELETION: 'erp_delete_code',
      OTP_PEPPER: 'a-pepper-that-is-at-least-32-characters-long',
    }).join('\n');
    expect(problems).toMatch(/WHATSAPP_APP_SECRET and WHATSAPP_WEBHOOK_VERIFY_TOKEN in production/);
    expect(problems).toMatch(/WHATSAPP_TEMPLATE_DELIVERY_CHECK/);
    expect(problems).toMatch(/WHATSAPP_TEMPLATE_ACCOUNT_DELETED/);
  });

  it('email: development-log is refused; resend needs a key, a real sender, https and the pepper (correction phase)', () => {
    expect(productionConfigProblems({ ...SAFE, EMAIL_CHANNEL: 'development-log' })[0]).toMatch(/EMAIL_CHANNEL=development-log/);
    const bare = productionConfigProblems({ ...SAFE, EMAIL_CHANNEL: 'resend', EMAIL_FROM: 'Dukan ERP <no-reply@example.com>', RESEND_API_BASE_URL: 'http://api.resend.com' }).join('\n');
    expect(bare).toMatch(/RESEND_API_KEY/);
    expect(bare).toMatch(/EMAIL_FROM must be a real sender/);
    expect(bare).toMatch(/RESEND_API_BASE_URL must be an https/);
    expect(bare).toMatch(/OTP_PEPPER/);
    expect(
      productionConfigProblems({
        ...SAFE,
        EMAIL_CHANNEL: 'resend',
        RESEND_API_KEY: 're_live_key',
        EMAIL_FROM: 'Dukan ERP <no-reply@mail.dukan-erp.mr>',
        OTP_PEPPER: 'a-pepper-that-is-at-least-32-characters-long',
        MESSAGING_HASH_KEY: 'a-messaging-hash-key-of-at-least-32-characters',
      }),
    ).toEqual([]);
  });

  it('refuses a plain-http provider address', () => {
    const problems = productionConfigProblems({
      ...SAFE,
      WHATSAPP_CHANNEL: 'cloud-api',
      WHATSAPP_API_BASE_URL: 'http://graph.example.test',
      WHATSAPP_PHONE_NUMBER_ID: '1',
      WHATSAPP_ACCESS_TOKEN: 't',
      WHATSAPP_TEMPLATE_AUTH_OTP: 'a',
      WHATSAPP_TEMPLATE_ACCOUNT_DELETION: 'b',
      WHATSAPP_TEMPLATE_ACCOUNT_DELETED: 'c',
      WHATSAPP_TEMPLATE_DELIVERY_CHECK: 'd',
      WHATSAPP_APP_SECRET: 's',
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'v',
      OTP_PEPPER: 'a-pepper-that-is-at-least-32-characters-long',
      WHATSAPP_TEST_RECIPIENTS: '+22236000000',
      MESSAGING_HASH_KEY: 'a-messaging-hash-key-of-at-least-32-characters',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('https://');
  });

  it('requires the webhook secret and verify token together', () => {
    expect(productionConfigProblems({ ...SAFE, WHATSAPP_APP_SECRET: 's' })).toHaveLength(1);
    expect(productionConfigProblems({ ...SAFE, WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'v' })).toHaveLength(1);
    expect(productionConfigProblems({ ...SAFE, WHATSAPP_APP_SECRET: 's', WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'v' })).toEqual([]);
  });
});

describe('administrator MFA in production (0094)', () => {
  it('refuses to start without a well-formed PLATFORM_MFA_KEY: the portal would be a password alone', () => {
    for (const key of [undefined, '', 'short', 'z'.repeat(64)]) {
      const problems = productionConfigProblems({ ...SAFE, PLATFORM_MFA_KEY: key });
      expect(problems.join('\n')).toMatch(/PLATFORM_MFA_KEY is missing or malformed/);
    }
    expect(productionConfigProblems({ ...SAFE, PLATFORM_MFA_KEY: '00'.repeat(32) })).toEqual([]);
  });
});

describe("the portal's origin, for the one address the portal and subscription messages carry (0099; docs/101)", () => {
  /*
   * Every portal instruction and subscription message carries <PORTAL_ORIGIN>/subscription — generic, no token. Over
   * plain http the Owner is sent to a page that can be read or changed on the way; with a path or a trailing slash the
   * address does not exist. It writes an address and nothing else — no request is compared with it, so nothing here is
   * an Origin check.
   */
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['plain http', 'http://dukan.example.com'],
    ['a path', 'https://dukan.example.com/subscription'],
    ['a trailing slash', 'https://dukan.example.com/'],
    ['a query', 'https://dukan.example.com?x=1'],
    ['credentials', 'https://user:pass@dukan.example.com'],
    ['no scheme', 'dukan.example.com'],
  ])('refuses %s', (_name, origin) => {
    const problems = productionConfigProblems({ ...SAFE, PORTAL_ORIGIN: origin });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/PORTAL_ORIGIN must be the Dukan ERP portal's https:\/\/ origin with no path/);
  });

  it.each(['https://dukan.tsxmr.com', 'https://staging.dukan.example:8443'])('accepts the bare https origin %p', (origin) => {
    expect(productionConfigProblems({ ...SAFE, PORTAL_ORIGIN: origin })).toEqual([]);
  });

  it('APP_ENV=production takes the owner\'s portal and nothing else — never the public site, which has no account area', () => {
    for (const origin of ['https://tsxmr.com', 'https://dukan.example.com']) {
      const problems = productionConfigProblems({ ...SAFE, APP_ENV: 'production', PORTAL_ORIGIN: origin });
      expect(problems.some((p) => /set PORTAL_ORIGIN=https:\/\/dukan\.tsxmr\.com exactly/.test(p))).toBe(true);
    }
    const ok = productionConfigProblems({ ...SAFE, APP_ENV: 'production', PORTAL_ORIGIN: 'https://dukan.tsxmr.com' });
    expect(ok.some((p) => /PORTAL_ORIGIN/.test(p))).toBe(false);
  });

  it('is not required outside production, where an empty value only means no portal message can be sent', () => {
    expect(productionConfigProblems({ NODE_ENV: 'development', PORTAL_ORIGIN: '' })).toEqual([]);
    expect(productionConfigProblems({ NODE_ENV: 'development', PORTAL_ORIGIN: 'http://localhost:5173' })).toEqual([]);
  });

  it('never requires a subscription template: without one WhatsApp cannot carry that message, the fallback is tried, and the status says so', () => {
    const complete = {
      ...SAFE,
      WHATSAPP_CHANNEL: 'cloud-api',
      WHATSAPP_PHONE_NUMBER_ID: '1234567890',
      WHATSAPP_ACCESS_TOKEN: 'EAAB-real-token',
      WHATSAPP_TEMPLATE_AUTH_OTP: 'erp_auth_code',
      WHATSAPP_TEMPLATE_ACCOUNT_DELETION: 'erp_delete_code',
      WHATSAPP_TEMPLATE_ACCOUNT_DELETED: 'erp_deleted',
      WHATSAPP_TEMPLATE_DELIVERY_CHECK: 'erp_delivery_check',
      WHATSAPP_APP_SECRET: 'app-secret',
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'verify-token',
      OTP_PEPPER: 'a-pepper-that-is-at-least-32-characters-long',
      WHATSAPP_TEST_RECIPIENTS: '+22236000000',
      MESSAGING_HASH_KEY: 'a-messaging-hash-key-of-at-least-32-characters',
    };
    expect(productionConfigProblems({ ...complete, WHATSAPP_TEMPLATE_PORTAL_INSTRUCTIONS: '' })).toEqual([]);
    expect(productionConfigProblems({ ...complete, WHATSAPP_TEMPLATE_PORTAL_INSTRUCTIONS: 'erp_portal_instructions' })).toEqual([]);
  });

  it('is declared, optional, in the schema and the example files — with no value committed outside the production template', () => {
    const schema = readFileSync('src/common/config/env.validation.ts', 'utf8');
    expect(schema).toMatch(/PORTAL_ORIGIN: Joi\.string\(\)\.allow\(''\)\.default\(''\)/);
    expect(schema).not.toMatch(/PUBLIC_SITE_ORIGIN|WHATSAPP_TEMPLATE_TRIAL_SETUP/);
    for (const key of ['PORTAL_INSTRUCTIONS', 'TRIAL_REMINDER', 'TRIAL_EXPIRED', 'PAID_REMINDER', 'GRACE_STARTED', 'NO_GRACE', 'GRACE_REMINDER', 'GRACE_ENDED']) {
      expect(schema).toMatch(new RegExp(`WHATSAPP_TEMPLATE_${key}: Joi\\.string\\(\\)\\.allow\\(''\\)\\.default\\(''\\)`));
      expect(readFileSync('.env.example', 'utf8')).toMatch(new RegExp(`^WHATSAPP_TEMPLATE_${key}=$`, 'm'));
    }
    for (const file of ['.env.example', '.env.staging.example']) {
      expect({ file, line: readFileSync(file, 'utf8').match(/^PORTAL_ORIGIN=(.*)$/m)?.[1] }).toEqual({ file, line: '' });
    }
    expect(readFileSync('.env.production.example', 'utf8')).toMatch(/^PORTAL_ORIGIN=https:\/\/dukan\.tsxmr\.com$/m);
  });
});

describe('test and live WhatsApp sending in production (D181 §4)', () => {
  const CLOUD = {
    ...SAFE,
    WHATSAPP_CHANNEL: 'cloud',
    WHATSAPP_PHONE_NUMBER_ID: '1297799316760335',
    WHATSAPP_ACCESS_TOKEN: 'EAAG-real-token',
    WHATSAPP_TEMPLATE_AUTH_OTP: 'erp_auth_code',
    WHATSAPP_TEMPLATE_ACCOUNT_DELETION: 'erp_delete_code',
    WHATSAPP_TEMPLATE_ACCOUNT_DELETED: 'erp_deleted',
    WHATSAPP_TEMPLATE_DELIVERY_CHECK: 'erp_delivery_check',
    WHATSAPP_APP_SECRET: 'app-secret',
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'verify-token',
    OTP_PEPPER: 'a-pepper-that-is-at-least-32-characters-long',
    MESSAGING_HASH_KEY: 'a-messaging-hash-key-of-at-least-32-characters',
  };

  it('test mode (the default) needs an exact allowlist, and refuses an "enabled" live switch as a contradiction', () => {
    expect(productionConfigProblems(CLOUD).join('\n')).toMatch(/WHATSAPP_MODE=test needs WHATSAPP_TEST_RECIPIENTS/);
    expect(productionConfigProblems({ ...CLOUD, WHATSAPP_TEST_RECIPIENTS: '222 36963839' }).join('\n')).toMatch(/WHATSAPP_TEST_RECIPIENTS/);
    expect(productionConfigProblems({ ...CLOUD, WHATSAPP_TEST_RECIPIENTS: '+22236963839' })).toEqual([]);
    expect(productionConfigProblems({ ...CLOUD, WHATSAPP_TEST_RECIPIENTS: '+22236963839', WHATSAPP_LIVE_SENDS: 'enabled' }).join('\n')).toMatch(/no meaning in test mode/);
  });

  it('live mode refuses to boot without the explicit live-send switch and the app id of the token check', () => {
    const live = { ...CLOUD, WHATSAPP_MODE: 'live' };
    const problems = productionConfigProblems(live).join('\n');
    expect(problems).toMatch(/WHATSAPP_MODE=live needs WHATSAPP_LIVE_SENDS=enabled/);
    expect(problems).toMatch(/WHATSAPP_MODE=live needs WHATSAPP_APP_ID/);
    expect(productionConfigProblems({ ...live, WHATSAPP_LIVE_SENDS: 'enabled', WHATSAPP_APP_ID: '1103715978699774' })).toEqual([]);
  });

  it('live mode still needs everything cloud needs: credentials, templates, the webhook', () => {
    const problems = productionConfigProblems({ ...SAFE, WHATSAPP_CHANNEL: 'cloud', WHATSAPP_MODE: 'live', WHATSAPP_LIVE_SENDS: 'enabled', WHATSAPP_APP_ID: '1' }).join('\n');
    for (const missing of [/WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN/, /WHATSAPP_TEMPLATE_AUTH_OTP/, /WHATSAPP_APP_SECRET and WHATSAPP_WEBHOOK_VERIFY_TOKEN/, /MESSAGING_HASH_KEY/]) {
      expect(problems).toMatch(missing);
    }
  });

  it('the records key is required whenever a real channel is configured', () => {
    expect(productionConfigProblems({ ...CLOUD, WHATSAPP_TEST_RECIPIENTS: '+22236963839', MESSAGING_HASH_KEY: 'short' }).join('\n')).toMatch(/MESSAGING_HASH_KEY/);
  });
});

describe('SMTP email in production (D181 §1)', () => {
  const SMTP = {
    ...SAFE,
    EMAIL_CHANNEL: 'smtp',
    SMTP_USERNAME: 'login@smtp-brevo.com',
    SMTP_PASSWORD: 'from-the-secret-manager',
    EMAIL_FROM: 'Dukan ERP <no-reply@tsxmr.com>',
    EMAIL_FROM_VERIFICATION: 'Dukan ERP <verification@tsxmr.com>',
    EMAIL_FROM_NOTIFICATIONS: 'Dukan ERP <notifications@tsxmr.com>',
    EMAIL_REPLY_TO: 'support@tsxmr.com',
    OTP_PEPPER: 'a-pepper-that-is-at-least-32-characters-long',
    MESSAGING_HASH_KEY: 'a-messaging-hash-key-of-at-least-32-characters',
  };

  it('accepts a complete configuration on port 587', () => {
    expect(productionConfigProblems(SMTP)).toEqual([]);
    expect(productionConfigProblems({ ...SMTP, SMTP_PORT: '587' })).toEqual([]);
  });

  it('refuses missing credentials, another port, example senders, no Reply-To, no pepper and no records key', () => {
    const problems = productionConfigProblems({
      ...SAFE,
      EMAIL_CHANNEL: 'smtp',
      SMTP_PORT: '465',
      EMAIL_FROM_VERIFICATION: 'codes@example.com',
    }).join('\n');
    for (const p of [/SMTP_USERNAME and SMTP_PASSWORD/, /SMTP_PORT must be 587/, /EMAIL_FROM_VERIFICATION \(or EMAIL_FROM\) must be a real sender/, /EMAIL_FROM_NOTIFICATIONS \(or EMAIL_FROM\)/, /EMAIL_REPLY_TO/, /OTP_PEPPER/, /MESSAGING_HASH_KEY/]) {
      expect(problems).toMatch(p);
    }
  });

  it('a class sender may fall back to EMAIL_FROM; the report and receipt senders are checked only when given', () => {
    expect(productionConfigProblems({ ...SMTP, EMAIL_FROM_VERIFICATION: '', EMAIL_FROM_NOTIFICATIONS: '' })).toEqual([]);
    expect(productionConfigProblems({ ...SMTP, EMAIL_FROM_REPORTS: 'reports@localhost' }).join('\n')).toMatch(/EMAIL_FROM_REPORTS/);
  });

  it('never lets .env.example carry a secret value', () => {
    const example = readFileSync('.env.example', 'utf8');
    for (const key of ['SMTP_PASSWORD', 'SMTP_USERNAME', 'MESSAGING_HASH_KEY', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN', 'WHATSAPP_TEST_RECIPIENTS']) {
      expect({ key, line: example.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] }).toEqual({ key, line: '' });
    }
    expect(example).toMatch(/^WHATSAPP_MODE=test$/m);
    expect(example).toMatch(/^WHATSAPP_LIVE_SENDS=disabled$/m);
    expect(example).toMatch(/^WHATSAPP_API_VERSION=v26\.0$/m);
  });
});

describe('the production environment proper (APP_ENV=production, D200)', () => {
  const PRODUCTION_SMTP = {
    ...SAFE,
    APP_ENV: 'production',
    // The owner's portal (0099): APP_ENV=production writes https://dukan.tsxmr.com/subscription into its messages.
    PORTAL_ORIGIN: 'https://dukan.tsxmr.com',
    API_INGRESS: 'network',
    API_BIND: undefined,
    CORS_ORIGINS: '',
    EMAIL_CHANNEL: 'smtp',
    SMTP_HOST: 'smtp-relay.brevo.com',
    SMTP_PORT: '587',
    SMTP_USERNAME: 'login@smtp-brevo.com',
    SMTP_PASSWORD: 'loaded-from-the-file-by-secret-files',
    SMTP_PASSWORD_FILE: '/run/secrets/smtp_password',
    EMAIL_FROM: 'Dukan ERP <no-reply@tsxmr.com>',
    EMAIL_FROM_VERIFICATION: 'Dukan ERP <verification@tsxmr.com>',
    EMAIL_FROM_NOTIFICATIONS: 'Dukan ERP <notifications@tsxmr.com>',
    EMAIL_REPLY_TO: 'support@tsxmr.com',
    OTP_PEPPER: 'a-pepper-that-is-at-least-32-characters-long',
    MESSAGING_HASH_KEY: 'a-messaging-hash-key-of-at-least-32-characters',
  };

  it('accepts SMTP whose key arrived as a file', () => {
    expect(productionConfigProblems(PRODUCTION_SMTP)).toEqual([]);
  });

  it('refuses an SMTP key given as a plain variable: it would show in docker inspect', () => {
    const { SMTP_PASSWORD_FILE: _file, ...plain } = PRODUCTION_SMTP;
    expect(productionConfigProblems(plain).join('\n')).toMatch(/APP_ENV=production reads the SMTP key from a file: set SMTP_PASSWORD_FILE/);
  });

  it('keeps staging and the other production-like environments as they were (the file rule is production only)', () => {
    const { SMTP_PASSWORD_FILE: _file, ...plain } = PRODUCTION_SMTP;
    expect(productionConfigProblems({ ...plain, APP_ENV: 'staging' })).toEqual([]);
    expect(productionConfigProblems({ ...plain, APP_ENV: undefined })).toEqual([]);
  });

  it.each(['enabled', 'disabled'])('refuses the staging outbox flag in production, whatever its value (%s)', (value) => {
    expect(productionConfigProblems({ ...PRODUCTION_SMTP, STAGING_CONTACT_OUTBOX: value }).join('\n')).toMatch(/STAGING_CONTACT_OUTBOX is set in production/);
    expect(productionConfigProblems({ ...PRODUCTION_SMTP, APP_ENV: 'staging', STAGING_CONTACT_OUTBOX: value })).toEqual([]);
  });

  it.each(['*', 'https://*.tsxmr.com', 'https://tsxmr.com,*'])('refuses a CORS wildcard (%s)', (origins) => {
    expect(productionConfigProblems({ ...SAFE, CORS_ORIGINS: origins }).join('\n')).toMatch(/CORS_ORIGINS contains a wildcard/);
  });

  it.each(['net', 'tls,net', 'http'])('refuses Node debug tracing (NODE_DEBUG=%s): it bypasses the log redaction', (value) => {
    expect(productionConfigProblems({ ...SAFE, NODE_DEBUG: value }).join('\n')).toMatch(/NODE_DEBUG is set/);
  });
});
