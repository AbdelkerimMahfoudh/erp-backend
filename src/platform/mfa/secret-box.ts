import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * Secrets at rest for administrator MFA (correction phase, 2026-10-12).
 *
 * The TOTP secret must be readable by the server — it has to compute the code — so it cannot be hashed; it is
 * sealed with AES-256-GCM under `PLATFORM_MFA_KEY`, a 32-byte key that lives in server-side configuration only.
 * A database dump alone then yields no second factor. Recovery codes are random and are only ever compared, so
 * they are stored as an HMAC under the same key.
 *
 * Sealed form: `v1:<iv>:<tag>:<ciphertext>`, base64url. Pure: `node:crypto` only.
 */

const VERSION = 'v1';

/** The key from configuration — 32 bytes as base64 or 64 hex characters — or null when absent or malformed. */
export function parseMfaKey(raw: string | null | undefined): Buffer | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  const hex = /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, 'hex') : null;
  const b64 = hex ? null : Buffer.from(text, 'base64');
  const key = hex ?? b64;
  return key && key.length === 32 ? key : null;
}

export function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join(':');
}

/** The plaintext, or null for anything that does not open under this key — tampered, truncated or foreign. */
export function open(sealed: string | null | undefined, key: Buffer): string | null {
  const parts = (sealed ?? '').split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** A keyed digest for a value that is only ever compared: recovery codes, enrolment tokens. */
export function keyedDigest(value: string, key: Buffer): string {
  return createHmac('sha256', key).update(value).digest('hex');
}
