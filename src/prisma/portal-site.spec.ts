import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * deploy/production/portal-site.sh, executed (post-Build-4): every refusal before the edge is touched, and an install
 * that validates the edge, restarts it and checks the live site. `docker` and `curl` are stand-ins on PATH that answer as
 * the production edge and API would; everything else — bash, the shared library, flock, the files — is real. Linux only
 * (CI): the script needs flock and a POSIX shell, as on the server.
 */
const ROOT = join(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'deploy', 'production', 'portal-site.sh');
const run = process.platform === 'win32' ? describe.skip : describe;

interface World {
  dir: string;
  web: string;
  env: NodeJS.ProcessEnv;
  release: (o?: { routes?: string; js?: string }) => string;
  apiEnv: (lines: string[]) => void;
}

function world(o: { host?: string; live?: Record<string, string> } = {}): World {
  const dir = mkdtempSync(join(tmpdir(), 'portal-site-'));
  const bin = join(dir, 'bin');
  const web = join(dir, 'web');
  mkdirSync(bin);
  mkdirSync(web);
  const live = { '/subscription': '200', '/claim/check': '200', '/admin': '404', admin_me: '403', ...(o.live ?? {}) };
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env bash\ncase "$*" in *" ps -q "*) echo edge-id ;; inspect*) echo running ;; esac\nexit 0\n`,
  );
  writeFileSync(
    join(bin, 'curl'),
    `#!/usr/bin/env bash
url="\${@: -1}"; code=""; headers=0
for a in "$@"; do [ "$a" = "-D" ] && headers=1; done
case "$url" in
  https://dukan.tsxmr.com/subscription) code=${live['/subscription']} ;;
  https://dukan.tsxmr.com/claim/check) code=${live['/claim/check']} ;;
  https://dukan.tsxmr.com/admin) code=${live['/admin']} ;;
  https://api.tsxmr.com/api/v1/platform/admin/me) code=${live.admin_me} ;;
  *) code=200 ;;
esac
if [ "$headers" = 1 ]; then printf 'HTTP/2 %s\\r\\nx-robots-tag: noindex, nofollow\\r\\naccess-control-allow-origin: https://dukan.tsxmr.com\\r\\n\\r\\n' "$code"; else printf '%s' "$code"; fi
`,
  );
  chmodSync(join(bin, 'docker'), 0o755);
  chmodSync(join(bin, 'curl'), 0o755);
  const apiEnvFile = join(dir, 'api.env');
  const apiEnv = (lines: string[]) => writeFileSync(apiEnvFile, lines.join('\n') + '\n');
  apiEnv(['CORS_ORIGINS=https://dukan-test.tsxmr.com,https://dukan.tsxmr.com,https://admin.tsxmr.com', 'ADMIN_ORIGINS=https://admin.tsxmr.com', 'PORTAL_ORIGIN=https://dukan.tsxmr.com']);
  const stack = join(dir, 'stack.env');
  writeFileSync(
    stack,
    [
      'DEPLOY_PROFILE=production',
      'API_HOST=api.tsxmr.com',
      'ACME_EMAIL=ops@example.test',
      'EDGE_HTTP_BIND=80',
      'EDGE_HTTPS_BIND=443',
      `SECRETS_DIR=${join(dir, 'secrets')}`,
      `BACKUP_DIR=${join(dir, 'backups')}`,
      `API_ENV_FILE=${apiEnvFile}`,
      `WEB_DIR=${web}`,
      `PORTAL_HOST=${o.host ?? 'dukan.tsxmr.com'}`,
    ].join('\n') + '\n',
  );
  let n = 0;
  const release = (r: { routes?: string; js?: string } = {}) => {
    const rel = join(dir, `release-${n++}`);
    mkdirSync(join(rel, 'site', 'assets'), { recursive: true });
    writeFileSync(join(rel, 'site', 'app-shell.html'), '<!doctype html>');
    writeFileSync(join(rel, 'site', '404.html'), '<!doctype html>');
    writeFileSync(join(rel, 'site', 'assets', 'index.js'), r.js ?? 'fetch("/api/v1/platform/portal/session")');
    writeFileSync(join(rel, 'routes.caddy'), r.routes ?? `header Content-Security-Policy "connect-src 'self' https://api.tsxmr.com;"\nrewrite /claim/* /app-shell.html\n`);
    writeFileSync(join(rel, 'portal-release.txt'), 'commit abcdef1\napi https://api.tsxmr.com\n');
    return rel;
  };
  return { dir, web, release, apiEnv, env: { ...process.env, STACK_ENV: stack, PATH: `${bin}:${process.env.PATH}` } };
}

const sh = (w: World, ...args: string[]) => spawnSync('bash', [SCRIPT, ...args], { env: w.env, encoding: 'utf8' });

run('portal-site.sh, executed', () => {
  it('asks for --confirm api.tsxmr.com', () => {
    const w = world();
    const r = sh(w, 'install', w.release());
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--confirm api.tsxmr.com');
  });

  it('refuses another hostname, an API that does not name the portal, or names it as an administrator origin', () => {
    expect(sh(world({ host: 'dukan-test.tsxmr.com' }), 'install', '/nowhere', '--confirm', 'api.tsxmr.com').status).toBe(2);
    const w = world();
    const rel = w.release();
    w.apiEnv(['CORS_ORIGINS=https://admin.tsxmr.com', 'ADMIN_ORIGINS=https://admin.tsxmr.com', 'PORTAL_ORIGIN=https://dukan.tsxmr.com']);
    expect(sh(w, 'install', rel, '--confirm', 'api.tsxmr.com').stderr).toContain('CORS_ORIGINS does not name https://dukan.tsxmr.com');
    w.apiEnv(['CORS_ORIGINS=https://dukan.tsxmr.com', 'ADMIN_ORIGINS=https://admin.tsxmr.com,https://dukan.tsxmr.com', 'PORTAL_ORIGIN=https://dukan.tsxmr.com']);
    expect(sh(w, 'install', rel, '--confirm', 'api.tsxmr.com').stderr).toContain("ADMIN_ORIGINS names the customers' portal");
    w.apiEnv(['CORS_ORIGINS=https://dukan.tsxmr.com', 'ADMIN_ORIGINS=https://admin.tsxmr.com', 'PORTAL_ORIGIN=https://dukan-test.tsxmr.com']);
    expect(sh(w, 'install', rel, '--confirm', 'api.tsxmr.com').stderr).toContain('PORTAL_ORIGIN');
    expect(existsSync(join(w.web, 'enabled'))).toBe(false);
  });

  it('refuses a release that serves /admin, holds console code, or was built for another API — before the edge', () => {
    const w = world();
    for (const [release, why] of [
      [w.release({ routes: `header Content-Security-Policy "connect-src 'self' https://api.tsxmr.com;"\nrewrite /admin/* /app-shell.html\n` }), 'serves the console'],
      [w.release({ js: 'fetch("/api/v1/platform/admin/me")' }), 'holds console code'],
      [w.release({ routes: `header Content-Security-Policy "connect-src 'self' https://dukan-test.tsxmr.com;"\n` }), 'was not built for https://api.tsxmr.com'],
    ] as const) {
      const r = sh(w, 'install', release, '--confirm', 'api.tsxmr.com');
      expect({ why, status: r.status, said: r.stderr.includes(why) }).toEqual({ why, status: 2, said: true });
    }
    expect(existsSync(join(w.web, 'enabled'))).toBe(false);
  });

  it('installs: the release kept, the site enabled, the edge restarted, the live checks pass, the log written', () => {
    const w = world();
    const r = sh(w, 'install', w.release(), '--confirm', 'api.tsxmr.com');
    expect({ status: r.status, err: r.stderr }).toEqual({ status: 0, err: '' });
    expect(r.stdout).toMatch(/Installed portal release \d{8}T\d{6}Z at https:\/\/dukan\.tsxmr\.com/);
    expect(r.stdout).toContain('PORTAL_LIVE stays as it is');
    expect(readlinkSync(join(w.web, 'portal', 'current'))).toMatch(/^releases\/\d{8}T\d{6}Z$/);
    expect(readFileSync(join(w.web, 'enabled', 'customer-portal.caddy'), 'utf8')).toContain('log_skip /claim/*');
    expect(readFileSync(join(w.dir, 'backups', 'deployments.log'), 'utf8')).toMatch(/portal-site install release=\S+ previous=none host=dukan\.tsxmr\.com/);
  });

  it('fails the install when the live site answers wrongly: /admin served, or the API letting the portal into an administrator route', () => {
    for (const live of [{ '/admin': '200' }, { admin_me: '401' }, { '/claim/check': '404' }]) {
      const w = world({ live });
      const r = sh(w, 'install', w.release(), '--confirm', 'api.tsxmr.com');
      expect({ live, status: r.status }).toEqual({ live, status: 2 });
    }
  });
});
