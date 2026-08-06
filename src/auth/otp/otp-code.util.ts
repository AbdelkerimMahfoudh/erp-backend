import { createHmac, randomInt, timingSafeEqual, createHash, randomBytes } from 'node:crypto';

/**
 * OTP secret handling (F1 Stage 4A).
 *
 * Everything here uses Node's built-in `crypto` — no new dependency, and
 * nothing home-rolled beyond composing primitives in the standard way.
 *
 * The central decision: a six-digit code carries about 20 bits of entropy, so
 * an ordinary unkeyed digest of it is not a one-way function in any useful
 * sense. All one million candidates can be hashed in milliseconds, meaning a
 * stolen database would hand over every live code. Argon2 (used elsewhere in
 * this project for passwords) would slow that down but still allows an offline
 * attack, and it is far too slow to run on every verification attempt.
 *
 * The answer is a **keyed** hash: HMAC-SHA256 with a server-side pepper that
 * lives in configuration and never in the database. Without the key, a dump of
 * `otp_challenges` is inert. With it, verification is a single fast HMAC.
 */

/** Six digits, including codes that legitimately start with zero. */
export const OTP_DIGITS = 6;

/**
 * Generate a code.
 *
 * `randomInt` is the CSPRNG-backed, rejection-sampled integer generator — not
 * `Math.random()`, and not a modulo of random bytes, both of which skew the
 * distribution. Padding preserves leading zeros, so `000123` is a real code and
 * not silently turned into `123`.
 */
export function generateOtpCode(): string {
  return String(randomInt(0, 10 ** OTP_DIGITS)).padStart(OTP_DIGITS, '0');
}

/** A code must be exactly six ASCII digits. Anything else never reaches a hash. */
export function isWellFormedCode(code: string): boolean {
  return typeof code === 'string' && new RegExp(`^\\d{${OTP_DIGITS}}$`).test(code);
}

/**
 * Hash a code for storage.
 *
 * The challenge id is mixed in so the same code issued to two challenges
 * produces two different hashes: without it, identical hashes would reveal
 * that two live challenges share a code, and a hash captured from one row
 * could be matched against another.
 */
export function hashOtpCode(code: string, challengeId: string, pepper: string): string {
  if (!pepper) {
    // Callers must check first; this is the last line of defence against a
    // deployment silently hashing with an empty key.
    throw new Error('OTP pepper is not configured');
  }
  return createHmac('sha256', pepper).update(`${challengeId}:${code}`).digest('hex');
}

/**
 * Constant-time comparison.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself leak, so both
 * sides are digested to a fixed width first. A plain `===` here would leak the
 * matching prefix length and let an attacker recover a code digit by digit.
 */
export function codeMatches(
  submitted: string,
  storedHash: string,
  challengeId: string,
  pepper: string,
): boolean {
  if (!isWellFormedCode(submitted)) return false;
  const candidate = hashOtpCode(submitted, challengeId, pepper);
  const a = createHash('sha256').update(candidate).digest();
  const b = createHash('sha256').update(storedHash).digest();
  return timingSafeEqual(a, b);
}

/**
 * A verification-intent token: 256 bits, URL-safe.
 *
 * Unlike the code, this is high-entropy, so a plain SHA-256 digest is a real
 * one-way function for it and no pepper is required.
 */
export function generateIntentToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashIntentToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Mask a destination for logs, audit rows and support screens.
 *
 * Enough to recognise which number was used, never enough to dial it or to
 * reconstruct it from a log aggregator.
 */
export function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  if (digits.length <= 4) return '***';
  return `${e164.slice(0, 4)}***${digits.slice(-2)}`;
}
