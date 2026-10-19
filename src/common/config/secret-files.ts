import { readFileSync } from 'node:fs';

/**
 * Secrets given as files (D200, docs/100 §4).
 *
 * A secret in an environment variable is visible wherever the environment is: `docker inspect`, `docker compose
 * config`, a copied env file, a support ticket with a container dump pasted into it. So production hands each secret
 * to the API as a read-only file under `/run/secrets` and names it with `NAME_FILE`; this reads the file into `NAME`
 * before anything else reads the configuration. The plain variable keeps working for local development, and the
 * production guard requires the file form where it matters (`production-guard.ts`).
 *
 * Only the names listed here are read this way, and a name may be given one way only: both at once is refused rather
 * than resolved, because "which one won?" is not a question to discover in production. A file must hold one line:
 * one trailing newline (as `openssl rand` and editors write it) is dropped, anything else is refused. Nothing here
 * logs or returns a value; an error names the setting and the problem, never the content.
 */
export const SECRET_FILE_SETTINGS = [
  // The API's own database URL carries the application identity's password.
  'APP_DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'OTP_PEPPER',
  'MESSAGING_HASH_KEY',
  'PLATFORM_MFA_KEY',
  'STAFF_INVITATION_KEY',
  'SMTP_USERNAME',
  'SMTP_PASSWORD',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
] as const;

export type SecretFileSetting = (typeof SECRET_FILE_SETTINGS)[number];

type ReadFile = (path: string) => string;

/**
 * For every listed `NAME` whose `NAME_FILE` is set: read the file into `NAME`. Returns the names it loaded.
 * Throws — before the application builds anything — when a file is missing, unreadable, empty or holds several lines,
 * or when `NAME` was also given directly.
 */
export function loadSecretFiles(env: NodeJS.ProcessEnv, read: ReadFile = (path) => readFileSync(path, 'utf8')): SecretFileSetting[] {
  const loaded: SecretFileSetting[] = [];
  for (const name of SECRET_FILE_SETTINGS) {
    const path = env[`${name}_FILE`]?.trim();
    if (!path) continue;
    if ((env[name] ?? '') !== '') {
      throw new Error(`${name} and ${name}_FILE are both set. Give the secret one way only (the file, in production).`);
    }
    let raw: string;
    try {
      raw = read(path);
    } catch (e) {
      const code = (e as { code?: unknown })?.code;
      throw new Error(`${name}_FILE names a file that cannot be read${typeof code === 'string' ? ` (${code})` : ''}.`);
    }
    const value = raw.replace(/\r?\n$/, '');
    if (value.trim() === '') throw new Error(`${name}_FILE names an empty file.`);
    if (/[\r\n]/.test(value)) throw new Error(`${name}_FILE must hold the secret on one line.`);
    env[name] = value;
    loaded.push(name);
  }
  return loaded;
}
