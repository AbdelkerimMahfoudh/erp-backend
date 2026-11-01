import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The off-host receipt deploy.sh requires (D227). On 2026-11-01 a comparison of two EMPTY checksums printed "OK" and a
 * deployment began with no off-host copy. These pin that exact failure and its neighbours.
 */
const PRODUCTION = join(__dirname, '..', '..', 'deploy', 'production');
const script = readFileSync(join(PRODUCTION, 'backup-receipt.sh'), 'utf8').replace(/\r/g, '');
const NAME = 'phonestore-20261101T205601Z.sql.gz.age';
const CONTENT = 'encrypted bytes';
const SUM = createHash('sha256').update(CONTENT).digest('hex');

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', ['-s', '--', ...args], { input: script, encoding: 'utf8', env: { ...process.env, ...env } });
}

describe('comparing checksums', () => {
  it.each([
    ['both empty, the failure of 2026-11-01', '', ''],
    ['the first empty', '', SUM],
    ['the second empty', SUM, ''],
    ['not a checksum', 'abc', 'abc'],
  ])('refuses %s', (_label, a, b) => {
    const result = run(['same', a, b]);
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain('match');
  });

  it('refuses two different checksums, and accepts two equal ones', () => {
    expect(run(['same', SUM, 'f'.repeat(64)]).status).toBe(2);
    expect(run(['same', SUM, SUM]).status).toBe(0);
  });
});

describe('the receipt', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'receipt-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const env = () => ({ BACKUP_DIR: dir });
  const backup = (content = CONTENT) => writeFileSync(join(dir, NAME), content);

  it('no receipt, no deployment', () => {
    backup();
    expect(run(['check'], env()).status).toBe(2);
  });

  it('records nothing for an empty name, an empty checksum, a missing or empty backup', () => {
    backup();
    expect(run(['record', '', SUM], env()).status).toBe(2);
    expect(run(['record', NAME, ''], env()).status).toBe(2);
    expect(run(['record', '../../etc/passwd', SUM], env()).status).toBe(2);
    expect(run(['check'], env()).status).toBe(2);
    backup('');
    expect(run(['record', NAME, createHash('sha256').update('').digest('hex')], env()).status).toBe(2);
    expect(run(['check'], env()).status).toBe(2);
  });

  it('records a matching copy, and then refuses if the file changes, vanishes or the receipt is old or empty', () => {
    backup();
    expect(run(['record', NAME, SUM], env()).status).toBe(0);
    expect(run(['check'], env()).status).toBe(0);
    expect(run(['check'], { ...env(), RECEIPT_MAX_AGE_SECONDS: '-1' }).status).toBe(2);
    backup('tampered');
    expect(run(['check'], env()).status).toBe(2);
    backup();
    writeFileSync(join(dir, 'offhost-verified'), '');
    expect(run(['check'], env()).status).toBe(2);
  });

  it('refuses without a backup directory', () => {
    expect(run(['check'], { BACKUP_DIR: '' }).status).toBe(2);
  });
});

describe('deploy.sh', () => {
  it('checks the receipt in production before its first step', () => {
    const deploy = readFileSync(join(PRODUCTION, 'deploy.sh'), 'utf8');
    const check = deploy.indexOf('backup-receipt.sh" check');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(deploy.indexOf('step build'));
    expect(check).toBeLessThan(deploy.indexOf('STEP=start'));
    expect(deploy).toMatch(/DEPLOY_PROFILE.*production[\s\S]*backup-receipt\.sh" check/);
  });
});
