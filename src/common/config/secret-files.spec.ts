import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSecretFiles, SECRET_FILE_SETTINGS } from './secret-files';

/**
 * Secrets given as files (D200): production mounts them read-only under /run/secrets and names them with NAME_FILE,
 * so no secret is in `docker inspect`. These pin how a file becomes a setting — and every way it must refuse.
 */
const files = (map: Record<string, string>) => (path: string) => {
  if (!(path in map)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return map[path];
};

describe('loadSecretFiles', () => {
  it('reads NAME_FILE into NAME, dropping the one trailing newline a generator writes', () => {
    const env: NodeJS.ProcessEnv = { SMTP_PASSWORD_FILE: '/run/secrets/smtp_password' };
    const loaded = loadSecretFiles(env, files({ '/run/secrets/smtp_password': 'xsmtpsib-abc123\n' }));
    expect(env.SMTP_PASSWORD).toBe('xsmtpsib-abc123');
    expect(loaded).toEqual(['SMTP_PASSWORD']);
  });

  it('keeps a value without a trailing newline exactly, and a Windows line ending is dropped too', () => {
    const env: NodeJS.ProcessEnv = { OTP_PEPPER_FILE: '/a', JWT_ACCESS_SECRET_FILE: '/b' };
    loadSecretFiles(env, files({ '/a': ' padded value ', '/b': 'value\r\n' }));
    expect(env.OTP_PEPPER).toBe(' padded value ');
    expect(env.JWT_ACCESS_SECRET).toBe('value');
  });

  it('leaves the plain variable alone when no file is named (local development)', () => {
    const env: NodeJS.ProcessEnv = { SMTP_PASSWORD: 'local-value' };
    expect(loadSecretFiles(env, files({}))).toEqual([]);
    expect(env.SMTP_PASSWORD).toBe('local-value');
  });

  it('refuses a secret given both ways, rather than choosing one', () => {
    const env: NodeJS.ProcessEnv = { SMTP_PASSWORD: 'one', SMTP_PASSWORD_FILE: '/f' };
    expect(() => loadSecretFiles(env, files({ '/f': 'two' }))).toThrow('SMTP_PASSWORD and SMTP_PASSWORD_FILE are both set');
  });

  it('treats an empty plain variable as unset (a template line), so the file may still give it', () => {
    const env: NodeJS.ProcessEnv = { SMTP_PASSWORD: '', SMTP_PASSWORD_FILE: '/f' };
    loadSecretFiles(env, files({ '/f': 'from-file' }));
    expect(env.SMTP_PASSWORD).toBe('from-file');
  });

  it.each([
    ['a missing file', {}, 'cannot be read (ENOENT)'],
    ['an empty file', { '/f': '' }, 'names an empty file'],
    ['a file holding only a newline', { '/f': '\n' }, 'names an empty file'],
    ['a file holding two lines', { '/f': 'one\ntwo\n' }, 'must hold the secret on one line'],
  ])('refuses %s', (_label, map, message) => {
    expect(() => loadSecretFiles({ SMTP_PASSWORD_FILE: '/f' }, files(map))).toThrow(message);
  });

  it('never puts the content of a file into an error', () => {
    const secret = 'xsmtpsib-never-in-an-error';
    for (const map of [{ '/f': `${secret}\nsecond line` }]) {
      try {
        loadSecretFiles({ SMTP_PASSWORD_FILE: '/f' }, files(map));
        throw new Error('expected a refusal');
      } catch (e) {
        expect(String((e as Error).message)).not.toContain(secret);
      }
    }
    try {
      loadSecretFiles({ SMTP_PASSWORD: secret, SMTP_PASSWORD_FILE: '/f' }, files({ '/f': 'x' }));
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(secret);
    }
  });

  it('reads only the listed secrets: an unlisted NAME_FILE is not read', () => {
    // The migration identity's URL is never the API's: it is not on the list, so a file naming it is not read.
    const env: NodeJS.ProcessEnv = { DATABASE_URL_FILE: '/f', SHADOW_DATABASE_URL_FILE: '/f' };
    const read = jest.fn(files({ '/f': 'mysql://x' }));
    loadSecretFiles(env, read);
    expect(read).not.toHaveBeenCalled();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('covers the API database URL, the SMTP login and key, and the four keys production generates', () => {
    for (const name of ['APP_DATABASE_URL', 'SMTP_PASSWORD', 'SMTP_USERNAME', 'JWT_ACCESS_SECRET', 'OTP_PEPPER', 'MESSAGING_HASH_KEY', 'PLATFORM_MFA_KEY', 'STAFF_INVITATION_KEY']) {
      expect(SECRET_FILE_SETTINGS).toContain(name);
    }
  });

  it('is loaded first by every operator script that reads secrets in the production tools container', () => {
    const root = join(__dirname, '..', '..', '..');
    for (const file of ['prisma/platform-admin-mfa.ts', 'scripts/whatsapp-prove.ts', 'scripts/email-prove.ts', 'scripts/rehearsal-fixture.ts']) {
      const source = readFileSync(join(root, file), 'utf8');
      const loader = Math.max(source.indexOf("import '../src/common/config/load-secret-files';"), source.indexOf('loadSecretFiles(process.env);'));
      const firstOther = source.search(/^import (?!\{ loadSecretFiles \}|'\.\.\/src\/common\/config\/load-secret-files')/m);
      expect({ file, loadsFirst: loader > -1 && (firstOther === -1 || loader < firstOther) }).toEqual({ file, loadsFirst: true });
    }
  });

  it('runs before the application module is imported, so configuration validation sees the loaded values', () => {
    const main = readFileSync(join(__dirname, '..', '..', 'main.ts'), 'utf8');
    const loader = main.indexOf("import './common/config/load-secret-files';");
    const appModule = main.indexOf("import { AppModule } from './app.module';");
    expect(loader).toBeGreaterThan(-1);
    expect(appModule).toBeGreaterThan(-1);
    expect(loader).toBeLessThan(appModule);
    // Nothing before it but reflect-metadata: any other import could pull the configuration in first.
    const before = main
      .slice(0, loader)
      .split(/\r?\n/)
      .filter((l) => l.startsWith('import '));
    expect(before).toEqual(["import 'reflect-metadata';"]);
  });
});
