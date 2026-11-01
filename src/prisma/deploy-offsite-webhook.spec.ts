import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The off-site backup (docs/112) and the webhook's own switch, as the production package ships them: the units and
 * script the server runs, the installer that compares them with this checkout, the preflight's webhook checks, and the
 * secret input that normalises only what Windows adds (a BOM, CR/LF) and judges everything else.
 */
const ROOT = join(__dirname, '..', '..');
const PRODUCTION = join(ROOT, 'deploy', 'production');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');

// ── secret-input.mjs ──────────────────────────────────────────────────────────────────────────────────────────────────
// Built, not written out: a 32-hex literal reads as a real key to the secret scanners.
const HEX32 = '0123456789abcdef'.repeat(2);
function secretInput(kind: string, input: string | Buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'secret-input-'));
  const file = join(dir, 'whatsapp_app_secret');
  const run = spawnSync(process.execPath, [join(PRODUCTION, 'secret-input.mjs'), kind, file], { input, encoding: 'utf8' });
  return { code: run.status, out: `${run.stdout}${run.stderr}`, file, dir };
}

describe('deploy/production/secret-input.mjs', () => {
  it.each<[string, string | Buffer]>([
    ['a bare value', HEX32],
    ['a trailing LF', `${HEX32}\n`],
    ['a trailing CRLF (Windows)', `${HEX32}\r\n`],
    ['a leading UTF-8 BOM from a PowerShell pipe', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${HEX32}\r\n`)])],
  ])('stores %s as exactly the 32 characters', (_label, input) => {
    const r = secretInput('whatsapp_app_secret', input);
    expect(r.code).toBe(0);
    expect(readFileSync(r.file, 'utf8')).toBe(HEX32);
    expect(r.out).toContain('32 characters');
    expect(r.out).not.toContain(HEX32);
  });

  it.each<[string, string]>([
    ['a wrong length', HEX32.slice(0, 31)],
    ['a real extra first character (never trimmed away)', `x${HEX32}`],
    ['a wrong first character at the right length', `g${HEX32.slice(1)}`],
    ['an inner space', `${HEX32.slice(0, 16)} ${HEX32.slice(16)}`],
    ['upper case', HEX32.toUpperCase()],
    ['nothing', ''],
  ])('refuses %s, writes nothing and never echoes the input', (_label, input) => {
    const r = secretInput('whatsapp_app_secret', input);
    expect(r.code).toBe(1);
    expect(existsSync(r.file)).toBe(false);
    expect(r.out).toMatch(/Refused: whatsapp_app_secret must be 32 lowercase hexadecimal characters \(received \d+ characters\)/);
    if (input) expect(r.out).not.toContain(input);
  });

  it('keeps the previous file as a .pre-* copy and replaces it whole', () => {
    const first = secretInput('whatsapp_app_secret', HEX32);
    const second = spawnSync(process.execPath, [join(PRODUCTION, 'secret-input.mjs'), 'whatsapp_app_secret', first.file], { input: 'fedcba9876543210'.repeat(2), encoding: 'utf8' });
    expect(second.status).toBe(0);
    expect(readFileSync(first.file, 'utf8')).toBe('fedcba9876543210'.repeat(2));
    const copies = readdirSync(first.dir).filter((f) => f.startsWith('whatsapp_app_secret.pre-'));
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(first.dir, copies[0]), 'utf8')).toBe(HEX32);
  });

  it('checks the other kinds by their own rule, and refuses an unknown kind', () => {
    expect(secretInput('whatsapp_webhook_verify_token', 'short').code).toBe(1);
    expect(secretInput('whatsapp_webhook_verify_token', `${'v'.repeat(48)}\n`).code).toBe(0);
    expect(secretInput('whatsapp_access_token', `EAA${'a1'.repeat(40)}`).code).toBe(0);
    expect(secretInput('whatsapp_access_token', `XAA${'a1'.repeat(40)}`).code).toBe(1);
    expect(secretInput('borg_passphrase', 'x').code).toBe(2);
  });
});

// ── The preflight's webhook checks ────────────────────────────────────────────────────────────────────────────────────
const KEY = (c: string) => c.repeat(48);
const FILES: Record<string, string> = {
  app_database_url: 'mysql://phonestore_app:example-app-password-0123@db:3306/phonestore?connection_limit=10\n',
  jwt_access_secret: `${KEY('a')}\n`,
  otp_pepper: `${KEY('b')}\n`,
  messaging_hash_key: `${KEY('c')}\n`,
  platform_mfa_key: `${'d'.repeat(64)}\n`,
  staff_invitation_key: `${KEY('e')}\n`,
  referral_key: `${KEY('f')}\n`,
  whatsapp_app_secret: `${HEX32}\n`,
  whatsapp_webhook_verify_token: `${'V7q'.repeat(16)}\n`,
};
const ENV: Record<string, string> = {
  DEPLOY_PROFILE: 'production', EXPECTED_API_HOST: 'api.tsxmr.com', APP_ENV: 'production', NODE_ENV: 'production', API_INGRESS: 'network',
  PUBLIC_API_ORIGIN: 'https://api.tsxmr.com', PORTAL_ORIGIN: 'https://dukan.tsxmr.com',
  APP_DATABASE_URL_FILE: '/run/secrets/app_database_url', JWT_ACCESS_SECRET_FILE: '/run/secrets/jwt_access_secret',
  OTP_PEPPER_FILE: '/run/secrets/otp_pepper', MESSAGING_HASH_KEY_FILE: '/run/secrets/messaging_hash_key',
  PLATFORM_MFA_KEY_FILE: '/run/secrets/platform_mfa_key', STAFF_INVITATION_KEY_FILE: '/run/secrets/staff_invitation_key',
  REFERRAL_KEY_FILE: '/run/secrets/referral_key',
  DATABASE_URL: 'mysql://phonestore_app:example-app-password-0123@db:3306/phonestore',
  COOKIE_SECURE: 'true', SWAGGER_ENABLED: 'false', SEED_DEMO: 'false', LOG_LEVEL: 'info', PLATFORM_ADMIN_KEY: '', CORS_ORIGINS: '',
  THROTTLE_TTL_SECONDS: '60', THROTTLE_LIMIT: '120', AUTH_THROTTLE_LIMIT: '10', ACCOUNT_THROTTLE_LIMIT: '5', UPLOAD_DIR: '/app/uploads',
  EMAIL_CHANNEL: 'disabled', WHATSAPP_CHANNEL: 'disabled',
};
const WEBHOOK = { WHATSAPP_WEBHOOK: 'enabled', WHATSAPP_APP_SECRET_FILE: '/run/secrets/whatsapp_app_secret', WHATSAPP_WEBHOOK_VERIFY_TOKEN_FILE: '/run/secrets/whatsapp_webhook_verify_token' };

function preflight(env: Record<string, string | undefined>, files = FILES) {
  const root = mkdtempSync(join(tmpdir(), 'preflight-webhook-'));
  const secrets = join(root, 'run', 'secrets');
  mkdirSync(secrets, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(secrets, name), content);
  const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>;
  const run = spawnSync(process.execPath, [join(PRODUCTION, 'preflight.mjs')], {
    env: { PATH: process.env.PATH ?? '', ...clean, PREFLIGHT_SECRETS_ROOT: root, PREFLIGHT_BACKUPS_DIR: join(root, 'backups') },
    encoding: 'utf8',
  });
  return { code: run.status, out: `${run.stdout}${run.stderr}` };
}

describe('the preflight and the webhook switch', () => {
  it('passes the webhook open while sending stays disabled, and says so', () => {
    const r = preflight({ ...ENV, ...WEBHOOK });
    expect(r.out).toContain('PASS');
    expect(r.out).toContain('WhatsApp disabled (webhook enabled)');
    expect(r.code).toBe(0);
  });

  it('still refuses sending: the webhook is no way around WHATSAPP_CHANNEL=disabled', () => {
    const r = preflight({ ...ENV, ...WEBHOOK, WHATSAPP_CHANNEL: 'cloud-api' });
    expect(r.out).toMatch(/WHATSAPP_CHANNEL must be "disabled"/);
    expect(r.code).toBe(1);
  });

  it.each<[string, Record<string, string | undefined>, Record<string, string>, RegExp]>([
    ['an unknown value', { WHATSAPP_WEBHOOK: 'on' }, FILES, /WHATSAPP_WEBHOOK must be "disabled" or "enabled"/],
    ['a secret with no file', { ...WEBHOOK, WHATSAPP_APP_SECRET_FILE: undefined }, FILES, /WHATSAPP_APP_SECRET_FILE is not set/],
    ['a secret also given as a value', { ...WEBHOOK, WHATSAPP_APP_SECRET: HEX32 }, FILES, /WHATSAPP_APP_SECRET is also set as a value/],
    ['an app secret of the wrong shape', WEBHOOK, { ...FILES, whatsapp_app_secret: `﻿${HEX32}\n` }, /32 lowercase hexadecimal characters \(it is 33 characters\)/],
    ['a short verify token', WEBHOOK, { ...FILES, whatsapp_webhook_verify_token: 'short\n' }, /at least 32 printable characters/],
  ])('refuses %s', (_label, change, files, message) => {
    const r = preflight({ ...ENV, ...change }, files);
    expect(r.out).toMatch(message);
    expect(r.code).toBe(1);
    expect(r.out).not.toContain(HEX32);
    expect(r.out).not.toContain('V7qV7q');
  });
});

// ── The off-site backup as installed ──────────────────────────────────────────────────────────────────────────────────
describe('the off-site backup (docs/112)', () => {
  const script = read('deploy', 'production', 'offsite-backup.sh');
  const timer = read('deploy', 'production', 'systemd', 'erp-offsite-backup.timer');
  const service = read('deploy', 'production', 'systemd', 'erp-offsite-backup.service');
  const installer = read('deploy', 'production', 'install-offsite.sh');

  it('runs nightly at 02:30 UTC, catches up a missed run, and runs the script from the production checkout', () => {
    expect(timer).toMatch(/^OnCalendar=\*-\*-\* 02:30:00 UTC$/m);
    expect(timer).toMatch(/^Persistent=true$/m);
    expect(timer).toMatch(/^RandomizedDelaySec=10min$/m);
    expect(service).toMatch(/^ExecStart=\/srv\/erp-production\/erp-backend\/deploy\/production\/offsite-backup\.sh$/m);
    expect(service).toMatch(/^Type=oneshot$/m);
  });

  it('takes the deployment lock, makes a fresh dump, checks the archive and keeps 7 daily / 4 weekly / 6 monthly', () => {
    expect(script).toMatch(/^take_lock$/m);
    expect(script).toContain('IN_DEPLOY=1 "$CHECKOUT/deploy/production/backup.sh"');
    expect(script).toContain('borg check --archives-only --last 1');
    expect(script).toContain('borg prune --keep-daily 7 --keep-weekly 4 --keep-monthly 6');
    expect(script).toContain('borg compact');
    expect(script).not.toContain('borg init');
  });

  it('archives the newest dump itself (an exclude once dropped it) and the deployment record by name', () => {
    expect(script).toMatch(/"\$DUMP" "\$DUMP\.sha256"/);
    expect(script).not.toMatch(/--exclude "\$BACKUP_DIR\/phonestore-\*"/);
    expect(script).toMatch(/for f in current-images\.env deployments\.log offsite-restore-proof offsite-latest/);
  });

  it('names its secrets by path only, and pings the dead-man switch with no data', () => {
    for (const text of [script, service, timer, installer]) {
      expect(text).not.toMatch(/hc-ping\.com\/[0-9a-f-]{36}/);
      expect(text).not.toMatch(/BORG_PASSPHRASE=/);
      expect(text).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    }
    expect(script).toContain('BORG_PASSCOMMAND="cat $SECRETS_DIR/borg_passphrase"');
    expect(script).toContain('PING_FILE=$SECRETS_DIR/healthchecks_ping_url');
    expect(script).toMatch(/curl -fsS -m 10 --retry 3 -o \/dev\/null "\$\(cat "\$PING_FILE"\)\$1"/);
    expect(script).toContain('StrictHostKeyChecking=yes');
  });

  it('the installer compares byte for byte before and after installing, and changes nothing with --check', () => {
    expect(installer).toContain('cmp -s "$src" "$dst"');
    expect(installer).toMatch(/--check\|--install/);
    expect(installer).toMatch(/if \[ "\$MODE" = --install \]; then/);
  });
});
