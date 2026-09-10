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
  COOKIE_SECURE: 'true',
  SWAGGER_ENABLED: 'false',
  API_BIND: '127.0.0.1',
  CORS_ORIGINS: 'https://app.example.com',
  JWT_ACCESS_SECRET: 'PLQ7wq2mZk4tR9vXbN1sYdF6hJ3gC8aE',
  APP_DATABASE_URL: 'mysql://app:pw@db.internal:3306/erp',
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

  it('refuses SWAGGER_ENABLED=true', () => {
    // The schema default is `true`, so this is what happens when nobody says
    // otherwise — the whole API surface published to anyone who asks.
    const problems = productionConfigProblems({ ...SAFE, SWAGGER_ENABLED: 'true' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('SWAGGER_ENABLED');
  });

  it('refuses an API bound to every interface', () => {
    /*
     * `main.ts` already says why: bound to 0.0.0.0 the administration
     * ENDPOINTS answer beside the proxy that enforces the /admin boundary, and
     * administrator MFA does not exist — so the guard would be a password alone.
     */
    for (const bind of ['0.0.0.0', undefined]) {
      const problems = productionConfigProblems({ ...SAFE, API_BIND: bind });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('127.0.0.1');
    }
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

  it('flags a localhost database URL', () => {
    const problems = productionConfigProblems({
      ...SAFE,
      APP_DATABASE_URL: 'mysql://app:pw@localhost:3306/erp',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('localhost');
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
