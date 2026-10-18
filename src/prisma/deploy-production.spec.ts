import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The production deployment package (D200, docs/100): its preflight, its stack contract and its scripts. The end-to-end
 * proof is the disposable rehearsal recorded in docs/100 §9; these pin every refusal so a later change cannot quietly
 * drop one.
 */
const ROOT = join(__dirname, '..', '..');
const PRODUCTION = join(ROOT, 'deploy', 'production');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

// ── The preflight ──────────────────────────────────────────────────────────────────────────────────────────────────
const KEY = (c: string) => c.repeat(48);
const SECRET_FILES: Record<string, string> = {
  app_database_url: 'mysql://phonestore_app:example-app-password-0123@db:3306/phonestore?connection_limit=10\n',
  jwt_access_secret: `${KEY('a')}\n`,
  otp_pepper: `${KEY('b')}\n`,
  messaging_hash_key: `${KEY('c')}\n`,
  platform_mfa_key: `${'d'.repeat(64)}\n`,
  smtp_username: 'login@smtp-brevo.com\n',
  smtp_password: 'xsmtpsib-0123456789abcdef\n',
};
const GOOD_ENV: Record<string, string> = {
  DEPLOY_PROFILE: 'production',
  EXPECTED_API_HOST: 'api.tsxmr.com',
  APP_ENV: 'production',
  NODE_ENV: 'production',
  API_INGRESS: 'network',
  PUBLIC_API_ORIGIN: 'https://api.tsxmr.com',
  PUBLIC_SITE_ORIGIN: 'https://tsxmr.com',
  APP_DATABASE_URL_FILE: '/run/secrets/app_database_url',
  JWT_ACCESS_SECRET_FILE: '/run/secrets/jwt_access_secret',
  OTP_PEPPER_FILE: '/run/secrets/otp_pepper',
  MESSAGING_HASH_KEY_FILE: '/run/secrets/messaging_hash_key',
  PLATFORM_MFA_KEY_FILE: '/run/secrets/platform_mfa_key',
  DATABASE_URL: 'mysql://phonestore_app:example-app-password-0123@db:3306/phonestore',
  COOKIE_SECURE: 'true',
  SWAGGER_ENABLED: 'false',
  SEED_DEMO: 'false',
  LOG_LEVEL: 'info',
  PLATFORM_ADMIN_KEY: '',
  CORS_ORIGINS: '',
  THROTTLE_TTL_SECONDS: '60',
  THROTTLE_LIMIT: '120',
  AUTH_THROTTLE_LIMIT: '10',
  ACCOUNT_THROTTLE_LIMIT: '5',
  UPLOAD_DIR: '/app/uploads',
  EMAIL_CHANNEL: 'disabled',
  WHATSAPP_CHANNEL: 'disabled',
};

function preflight(env: Record<string, string | undefined>, opts: { files?: Record<string, string>; proof?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'preflight-'));
  const secrets = join(root, 'run', 'secrets');
  const backups = join(root, 'backups');
  mkdirSync(secrets, { recursive: true });
  mkdirSync(backups, { recursive: true });
  for (const [name, content] of Object.entries(opts.files ?? SECRET_FILES)) writeFileSync(join(secrets, name), content);
  if (opts.proof) writeFileSync(join(backups, 'offsite-restore-proof'), opts.proof);
  const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>;
  const run = spawnSync(process.execPath, [join(PRODUCTION, 'preflight.mjs')], {
    env: { PATH: process.env.PATH ?? '', ...clean, PREFLIGHT_SECRETS_ROOT: root, PREFLIGHT_BACKUPS_DIR: backups },
    encoding: 'utf8',
  });
  return { code: run.status, out: `${run.stdout}${run.stderr}` };
}

describe('deploy/production/preflight.mjs', () => {
  it('passes a complete production environment whose secrets are all files', () => {
    const r = preflight(GOOD_ENV);
    expect(r.out).toContain('production preflight (production): PASS');
    expect(r.code).toBe(0);
  });

  it('passes the rehearsal profile on a *.localhost host', () => {
    const r = preflight({ ...GOOD_ENV, DEPLOY_PROFILE: 'rehearsal', EXPECTED_API_HOST: 'api.rehearsal.localhost', PUBLIC_API_ORIGIN: 'https://api.rehearsal.localhost' });
    expect(r.out).toContain('PASS');
    expect(r.code).toBe(0);
  });

  it('never prints a secret, even when it refuses one', () => {
    const r = preflight({ ...GOOD_ENV, EMAIL_CHANNEL: 'smtp', SMTP_HOST: 'smtp-relay.brevo.com', SMTP_PORT: '587', SMTP_PASSWORD_FILE: '/run/secrets/smtp_password', SMTP_USERNAME_FILE: '/run/secrets/smtp_username' });
    for (const content of Object.values(SECRET_FILES)) expect(r.out).not.toContain(content.trim());
    expect(r.out).not.toContain('example-app-password');
  });

  it.each<[string, Record<string, string | undefined>, RegExp]>([
    ['a production host that is not api.tsxmr.com', { EXPECTED_API_HOST: 'api.example.com', PUBLIC_API_ORIGIN: 'https://api.example.com' }, /production API host is api\.tsxmr\.com/],
    ['a rehearsal on a public name', { DEPLOY_PROFILE: 'rehearsal' }, /rehearsal runs on a \*\.localhost name only/],
    ['an API origin that is not the host', { PUBLIC_API_ORIGIN: 'https://api.tsxmr.com/' }, /PUBLIC_API_ORIGIN must be exactly https:\/\/api\.tsxmr\.com/],
    ['the staging identity', { APP_ENV: 'staging' }, /APP_ENV must be "production"/],
    ['development mode', { NODE_ENV: 'development' }, /NODE_ENV must be "production"/],
    ['the staging code outbox', { STAGING_CONTACT_OUTBOX: 'disabled' }, /STAGING_CONTACT_OUTBOX must not exist/],
    ['a secret given as a value', { JWT_ACCESS_SECRET: KEY('z') }, /JWT_ACCESS_SECRET is also set as a value/],
    ['a secret with no file', { OTP_PEPPER_FILE: undefined }, /OTP_PEPPER_FILE is not set/],
    ['a CORS wildcard', { CORS_ORIGINS: '*' }, /must be an exact https:\/\/ origin: no wildcard/],
    ['CORS left unstated', { CORS_ORIGINS: undefined }, /CORS_ORIGINS must be stated/],
    ['another website origin', { PUBLIC_SITE_ORIGIN: 'https://dukan.example.com' }, /PUBLIC_SITE_ORIGIN must be https:\/\/tsxmr\.com/],
    ['Swagger on', { SWAGGER_ENABLED: 'true' }, /SWAGGER_ENABLED must be "false"/],
    ['debug logs', { LOG_LEVEL: 'debug' }, /LOG_LEVEL must be info, warn or error/],
    ['Node debug tracing', { NODE_DEBUG: 'tls' }, /NODE_DEBUG must be unset/],
    ['a static admin key', { PLATFORM_ADMIN_KEY: 'example-static-key-16' }, /PLATFORM_ADMIN_KEY must be empty/],
    ['demo data', { SEED_DEMO: 'true' }, /SEED_DEMO must not be on/],
    ['a shadow database', { SHADOW_DATABASE_URL: 'mysql://x@db/shadow' }, /SHADOW_DATABASE_URL must be absent/],
    ['the tools on the migrator', { DATABASE_URL: 'mysql://phonestore_migrator:pw@db:3306/phonestore' }, /DATABASE_URL \(the tools\) must connect as phonestore_app/],
    ['the staging schema', { DATABASE_URL: 'mysql://phonestore_app:pw@db:3306/phonestore_staging' }, /to the phonestore schema/],
    ['WhatsApp enabled', { WHATSAPP_CHANNEL: 'cloud' }, /WHATSAPP_CHANNEL must be "disabled"/],
    ['an unknown email channel', { EMAIL_CHANNEL: 'development-log' }, /EMAIL_CHANNEL must be "disabled" or "smtp"/],
    ['rate limits left unstated', { AUTH_THROTTLE_LIMIT: undefined }, /AUTH_THROTTLE_LIMIT must be stated/],
  ])('refuses %s', (_label, change, message) => {
    const r = preflight({ ...GOOD_ENV, ...change });
    expect(r.out).toMatch(message);
    expect(r.code).toBe(1);
  });

  it.each<[string, Record<string, string>, RegExp]>([
    ['a placeholder', { jwt_access_secret: `${'change-me-'.repeat(5)}\n` }, /JWT_ACCESS_SECRET looks like a placeholder/],
    ['a short key', { otp_pepper: 'short\n' }, /OTP_PEPPER must be at least 32 characters \(it is 5\)/],
    ['two equal keys', { messaging_hash_key: `${KEY('a')}\n` }, /must all be different/],
    ['an MFA key of the wrong size', { platform_mfa_key: `${'d'.repeat(62)}\n` }, /PLATFORM_MFA_KEY must be exactly 32 bytes/],
    ['an empty file', { otp_pepper: '' }, /OTP_PEPPER_FILE is empty/],
    ['a two-line file', { otp_pepper: `${KEY('b')}\nmore\n` }, /OTP_PEPPER_FILE holds more than one line/],
    ['the API on the migrator', { app_database_url: 'mysql://phonestore_migrator:example-migrator-pw-0123@db:3306/phonestore\n' }, /APP_DATABASE_URL must connect as phonestore_app/],
  ])('refuses %s among the secret files', (_label, change, message) => {
    const r = preflight(GOOD_ENV, { files: { ...SECRET_FILES, ...change } });
    expect(r.out).toMatch(message);
    expect(r.code).toBe(1);
  });

  describe('email and the customer-data gate', () => {
    const SMTP = { EMAIL_CHANNEL: 'smtp', SMTP_HOST: 'smtp-relay.brevo.com', SMTP_PORT: '587', SMTP_USERNAME_FILE: '/run/secrets/smtp_username', SMTP_PASSWORD_FILE: '/run/secrets/smtp_password' };

    it('keeps email closed until a backup has been restored from the Storage Box', () => {
      expect(preflight({ ...GOOD_ENV, ...SMTP }).out).toMatch(/needs an off-site restore proof from the Storage Box first .* today: none/);
      expect(preflight({ ...GOOD_ENV, ...SMTP }, { proof: 'kind=laptop\nfile=x\n' }).out).toMatch(/today: laptop/);
      const open = preflight({ ...GOOD_ENV, ...SMTP }, { proof: 'kind=storage-box\nfile=phonestore-x.sql.gz.age\n' });
      expect(open.out).toContain('PASS');
      expect(open.code).toBe(0);
    });

    it('takes the SMTP login and key as files only, on port 587', () => {
      const proof = { proof: 'kind=storage-box\n' };
      expect(preflight({ ...GOOD_ENV, ...SMTP, SMTP_PASSWORD: 'xsmtpsib-value' }, proof).out).toMatch(/SMTP_PASSWORD is also set as a value/);
      expect(preflight({ ...GOOD_ENV, ...SMTP, SMTP_PASSWORD_FILE: '' }, proof).out).toMatch(/SMTP_PASSWORD_FILE is not set/);
      expect(preflight({ ...GOOD_ENV, ...SMTP, SMTP_PORT: '465' }, proof).out).toMatch(/SMTP_PORT must be 587/);
    });

    it('never lets the rehearsal open the API\'s email channel (the proof is a separate command)', () => {
      const r = preflight({ ...GOOD_ENV, ...SMTP, DEPLOY_PROFILE: 'rehearsal', EXPECTED_API_HOST: 'api.rehearsal.localhost', PUBLIC_API_ORIGIN: 'https://api.rehearsal.localhost' }, { proof: 'kind=storage-box\n' });
      expect(r.out).toMatch(/A rehearsal keeps EMAIL_CHANNEL=disabled/);
    });
  });

  it('refuses the committed template: it holds no secret, so it is no configuration', () => {
    const template = Object.fromEntries(
      read('.env.production.example')
        .split(/\r?\n/)
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    const r = preflight({ ...template, DEPLOY_PROFILE: 'production', EXPECTED_API_HOST: 'api.tsxmr.com' }, { files: {} });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/_FILE is not set/);
  });
});

// ── The stack contract ────────────────────────────────────────────────────────────────────────────────────────────
const LOG = { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '5' } };
const GOOD_STACK = {
  networks: { internal: { internal: true }, edge: {} },
  services: {
    db: {
      image: `mysql:8.4.11@sha256:${'a'.repeat(64)}`,
      restart: 'unless-stopped',
      mem_limit: '1610612736',
      environment: { MYSQL_ROOT_PASSWORD_FILE: '/secrets/mysql_root.pw', MYSQL_ROOT_HOST: 'localhost' },
      volumes: [{ type: 'bind', source: '/srv/erp-production/secrets/db', target: '/secrets', read_only: true }],
      networks: { internal: null },
      logging: LOG,
    },
    api: {
      image: 'erp-api:abc',
      restart: 'unless-stopped',
      mem_limit: '1073741824',
      expose: ['3010'],
      environment: { APP_ENV: 'production', NODE_ENV: 'production', API_INGRESS: 'network', PORT: '3010', UPLOAD_DIR: '/app/uploads', JWT_ACCESS_SECRET_FILE: '/run/secrets/jwt_access_secret' },
      volumes: [{ type: 'bind', source: '/srv/erp-production/secrets/api', target: '/run/secrets', read_only: true }],
      networks: { internal: null, edge: null },
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
      logging: LOG,
    },
    edge: {
      image: `caddy:2.11.7@sha256:${'b'.repeat(64)}`,
      restart: 'unless-stopped',
      mem_limit: '268435456',
      ports: [
        { mode: 'ingress', target: 80, published: '80', protocol: 'tcp' },
        { mode: 'ingress', target: 443, published: '443', protocol: 'tcp' },
      ],
      environment: { API_HOST: 'api.tsxmr.com', ACME_EMAIL: 'developer@tsxmr.com' },
      networks: { edge: null },
      cap_drop: ['ALL'],
      cap_add: ['NET_BIND_SERVICE'],
      logging: LOG,
    },
    'email-proof': { image: 'erp-api-tools:abc', networks: { edge: null }, logging: LOG },
  },
};
type Stack = typeof GOOD_STACK;
const clone = (): Stack => JSON.parse(JSON.stringify(GOOD_STACK));

function checkStack(config: unknown, profile = 'production') {
  const run = spawnSync(process.execPath, [join(PRODUCTION, 'check-stack.mjs'), '--profile', profile], { input: JSON.stringify(config), encoding: 'utf8' });
  return { code: run.status, out: `${run.stdout}${run.stderr}` };
}

describe('deploy/production/check-stack.mjs', () => {
  it('passes the production shape', () => {
    const r = checkStack(GOOD_STACK);
    expect(r.out).toContain('stack contract (production): PASS');
    expect(r.code).toBe(0);
  });

  it('passes the rehearsal shape only with the edge on 127.0.0.1', () => {
    const rehearsal = clone();
    rehearsal.services.edge.ports = rehearsal.services.edge.ports.map((p, i) => ({ ...p, host_ip: '127.0.0.1', published: i ? '8443' : '8080' }));
    expect(checkStack(rehearsal, 'rehearsal').code).toBe(0);
    expect(checkStack(GOOD_STACK, 'rehearsal').out).toMatch(/a rehearsal publishes the edge on 127\.0\.0\.1 only/);
  });

  const mutations: [string, (s: Stack) => void, RegExp][] = [
    ['a published database port', (s) => Object.assign(s.services.db, { ports: [{ target: 3306, published: '3306' }] }), /db publishes no port/],
    ['a published API port', (s) => Object.assign(s.services.api, { ports: [{ target: 3010, published: '3010' }] }), /api publishes no port/],
    ['an unpinned MySQL', (s) => (s.services.db.image = 'mysql:8.4'), /db runs a pinned image/],
    ['a Caddy tag without digest', (s) => (s.services.edge.image = 'caddy:2.11.7'), /edge runs a pinned image/],
    ['the database on the edge network', (s) => (s.services.db.networks = { internal: null, edge: null } as never), /database is on the internal network only/],
    ['an internal network with a route out', (s) => (s.networks.internal.internal = false), /internal network is internal/],
    ['a UDP port on the edge', (s) => (s.services.edge.ports[1].protocol = 'udp'), /TCP only/],
    ['no memory limit on the API', (s) => delete (s.services.api as Partial<Stack['services']['api']>).mem_limit, /api has a memory limit/],
    ['no log rotation', (s) => (s.services.api.logging = { driver: 'json-file', options: {} } as never), /api rotates its log/],
    ['a secret value in the API environment', (s) => Object.assign(s.services.api.environment, { SMTP_PASSWORD: 'xsmtpsib-x' }), /api carries no SMTP_PASSWORD value/],
    ['a database URL in the API environment', (s) => Object.assign(s.services.api.environment, { APP_DATABASE_URL: 'mysql://u:p@db/phonestore' }), /api carries no APP_DATABASE_URL value/],
    ['the staging identity', (s) => (s.services.api.environment.APP_ENV = 'staging'), /the API runs with APP_ENV=production/],
    ['a staging setting', (s) => Object.assign(s.services.api.environment, { STAGING_CONTACT_OUTBOX: 'enabled' }), /holds no staging setting/],
    ['root reachable from the network', (s) => (s.services.db.environment.MYSQL_ROOT_HOST = '%'), /root is reachable from inside its container only/],
    ['writable secrets', (s) => (s.services.api.volumes[0].read_only = false), /one read-only mount/],
    ['capabilities kept by the API', (s) => (s.services.api.cap_drop = []), /holds no Linux capability/],
    ['the email proof on the database network', (s) => (s.services['email-proof'].networks = { internal: null, edge: null } as never), /never reaches the database/],
  ];
  it.each(mutations)('refuses %s', (_label, mutate, message) => {
    const s = clone();
    mutate(s);
    const r = checkStack(s);
    expect(r.out).toMatch(message);
    expect(r.code).toBe(1);
  });

  it('prints rule names only, never a value from the configuration', () => {
    const s = clone();
    Object.assign(s.services.api.environment, { SMTP_PASSWORD: 'xsmtpsib-must-not-print' });
    expect(checkStack(s).out).not.toContain('must-not-print');
  });
});

// ── The compose file and the scripts ─────────────────────────────────────────────────────────────────────────────
describe('the production package', () => {
  const compose = read('deploy', 'docker-compose.production.yml');
  const scripts = readdirSync(PRODUCTION).filter((f) => f.endsWith('.sh'));
  const script = (name: string) => readFileSync(join(PRODUCTION, name), 'utf8');

  it('pins MySQL 8.4 and Caddy to an exact version and digest', () => {
    expect(compose).toMatch(/image: mysql:8\.4\.\d+@sha256:[0-9a-f]{64}/);
    expect(compose).toMatch(/image: caddy:2\.\d+\.\d+@sha256:[0-9a-f]{64}/);
    expect(compose).not.toMatch(/image: (mysql|caddy):[\d.]+\s*$/m);
  });

  it('names the production project and forces the production identity', () => {
    expect(compose).toMatch(/^name: erp-production$/m);
    expect(compose).toMatch(/APP_ENV: production/);
    expect(compose).not.toMatch(/APP_ENV: staging/);
    expect(compose).not.toMatch(/phonestore_staging|erp-staging/);
  });

  it('runs every script under strict mode through the shared library, and never traces commands', () => {
    for (const name of scripts) {
      const body = script(name);
      if (name === 'lib.sh') {
        expect(body).toMatch(/^set -euo pipefail$/m);
        continue;
      }
      expect({ name, shebang: body.startsWith('#!/usr/bin/env bash\n') }).toEqual({ name, shebang: true });
      expect({ name, lib: /^source "\$\(dirname "\$0"\)\/lib\.sh"$/m.test(body) }).toEqual({ name, lib: true });
      expect({ name, trace: /set -[a-z]*x|bash -x/.test(body) }).toEqual({ name, trace: false });
    }
  });

  it('asks for --confirm <host> on every command that changes the stack', () => {
    for (const name of ['deploy.sh', 'migrate.sh', 'rollback.sh', 'teardown-rehearsal.sh']) {
      expect({ name, confirm: /^require_confirm "\$@"$/m.test(script(name)) }).toEqual({ name, confirm: true });
    }
  });

  it('refuses to run beside another stack, and keeps each profile to its own directory and host', () => {
    const lib = script('lib.sh');
    expect(lib).toContain('PROJECT=erp-production; BASE=/srv/erp-production; OTHERS="erp-staging erp-rehearsal"');
    expect(lib).toContain('PROJECT=erp-rehearsal; BASE=/srv/erp-rehearsal; OTHERS="erp-staging erp-production"');
    expect(lib).toContain('[ "$API_HOST" = api.tsxmr.com ]');
    expect(lib).toMatch(/is outside \$BASE: each profile keeps to its own directory/);
    expect(lib).toMatch(/never runs beside them/);
  });

  it('encrypts backups with age to public keys only, and checks the dump completed before encrypting', () => {
    const backup = script('backup.sh');
    expect(backup).toMatch(/age --encrypt -R "\$RECIPIENTS"/);
    expect(backup).not.toMatch(/openssl enc/);
    expect(backup).toContain('Dump completed on');
    expect(backup).toMatch(/must hold age public keys only/);
  });

  it('decrypts only with an identity held in memory for the drill, and records an off-site proof only on a pass', () => {
    const drill = script('restore-drill.sh');
    expect(drill).toMatch(/case "\$IDENTITY" in \/dev\/shm\/\*\)/);
    expect(drill).toMatch(/sha256sum -c --quiet/);
    const proof = drill.indexOf('offsite-restore-proof"');
    expect(proof).toBeGreaterThan(drill.indexOf('the restore drill FAILED'));
  });

  it('never prints a secret file: the scripts read secrets into files or pipes, never to the terminal', () => {
    for (const name of scripts) {
      // A secret read into a variable ($(cat …)) or written to a file (> "…") is not printed; anything else naming one is.
      const unprinted = script(name)
        .replace(/\$\(cat [^)]*\)/g, '')
        .replace(/>\s*"[^"]*"/g, '');
      const prints = /(echo|printf|cat)\s[^\n|>]*(smtp_password|\.pw\b|app_database_url|platform_mfa_key|jwt_access_secret|otp_pepper|messaging_hash_key)[^\n]*$/m.test(unprinted);
      expect({ name, prints }).toEqual({ name, prints: false });
    }
  });

  it('keeps the email proof to one recipient file and the owner decision: plain text only', () => {
    const proof = script('email-proof.sh');
    expect(proof).toContain('--plain-text-approved');
    expect(proof).toContain('--recipient-file /run/proof/recipient');
    expect(compose).toMatch(/email-proof:[\s\S]*?networks: \[edge\]/);
  });
});
