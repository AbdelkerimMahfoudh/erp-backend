import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * deploy/production/setup-secrets.sh manages only the application secrets it names (2026-11-01).
 *
 * The production deployment of 5131909 stopped at its secrets step: a blanket `find SECRETS_DIR -type f -exec chmod`
 * met two root-owned files the off-site backup had placed there, and the deployment account may not chmod another
 * owner's file. The script now touches a fixed list. This runs the real script, beside a stub `lib.sh` that points it at
 * a temporary directory, with an unrelated file the script must neither read nor change: mode 000 (unreadable — a read
 * would fail the run; the old script would have turned it into 600), content and time recorded before.
 */
const SCRIPT = join(__dirname, '..', '..', 'deploy', 'production', 'setup-secrets.sh');
const bash = spawnSync('bash', ['-c', 'command -v openssl && command -v find'], { encoding: 'utf8' });
const canRun = bash.status === 0 && process.platform !== 'win32';

(canRun ? describe : describe.skip)('deploy/production/setup-secrets.sh', () => {
  let dir: string;
  let secrets: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'setup-secrets-'));
    secrets = join(dir, 'secrets');
    mkdirSync(join(dir, 'bin'));
    copyFileSync(SCRIPT, join(dir, 'bin', 'setup-secrets.sh'));
    writeFileSync(join(dir, 'bin', 'lib.sh'), `set -euo pipefail\nSECRETS_DIR='${secrets}'\n`);
    mkdirSync(secrets, { recursive: true });
  });

  afterEach(() => {
    try {
      chmodSync(join(secrets, 'borg_passphrase'), 0o600);
    } catch {
      /* absent */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const run = () => spawnSync('bash', [join(dir, 'bin', 'setup-secrets.sh')], { encoding: 'utf8' });

  it('leaves a file it does not own exactly as it was: not read, not chmod-ed, not counted', () => {
    const foreign = join(secrets, 'borg_passphrase');
    writeFileSync(foreign, 'not-a-real-value\n');
    chmodSync(foreign, 0o000);
    const before = statSync(foreign);

    const r = run();
    expect(r.status).toBe(0);

    const after = statSync(foreign);
    expect(after.mode & 0o777).toBe(0o000);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ctimeMs).toBe(before.ctimeMs);
    chmodSync(foreign, 0o600);
    expect(readFileSync(foreign, 'utf8')).toBe('not-a-real-value\n');
    expect(r.stdout).toMatch(/14 application secret files/);
  });

  it('still creates its own secrets mode 600, and never replaces one that exists', () => {
    const first = run();
    expect(first.status).toBe(0);
    for (const name of ['db/app.pw', 'api/jwt_access_secret', 'api/platform_mfa_key', 'database.env', 'migrator.env']) {
      expect(statSync(join(secrets, name)).mode & 0o777).toBe(0o600);
    }
    const kept = readFileSync(join(secrets, 'api', 'jwt_access_secret'), 'utf8');
    chmodSync(join(secrets, 'api', 'jwt_access_secret'), 0o644);
    expect(run().status).toBe(0);
    expect(readFileSync(join(secrets, 'api', 'jwt_access_secret'), 'utf8')).toBe(kept);
    expect(statSync(join(secrets, 'api', 'jwt_access_secret')).mode & 0o777).toBe(0o600);
  });

  it('names its files: no recursive find, chmod or chown over the directory', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source).not.toMatch(/find\s+"?\$SECRETS_DIR/);
    expect(source).not.toMatch(/chmod\s+-R|chown/);
  });
});
