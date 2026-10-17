import { createHash, createHmac } from 'node:crypto';

/**
 * A verification code's stored hash, by version: 2 = HMAC-SHA256 under OTP_PEPPER; 1 = the earlier unkeyed SHA-256,
 * kept only to check a code issued before 0093 (or on a development machine without a pepper). The destination is
 * folded in, so a code stolen for one contact cannot be replayed against another. One function for the service and the
 * staging retrieval command, so the two can never disagree.
 */
export function otpHash(destination: string, code: string, version: number, pepper: string | null): string {
  if (version === 2 && pepper) return createHmac('sha256', pepper).update(`${destination}:${code}`).digest('hex');
  return createHash('sha256').update(`${destination}:${code}`).digest('hex');
}

/**
 * Walk the six-digit space for the code behind a stored hash (staging retrieval only). Null when the row cannot be
 * re-derived: a keyed row without the pepper, or a code that is not six digits.
 */
export function recoverOtp(destination: string, codeHash: string, version: number, pepper: string | null): string | null {
  if (version === 2 && !pepper) return null;
  for (let i = 0; i < 1_000_000; i++) {
    const candidate = String(i).padStart(6, '0');
    if (otpHash(destination, candidate, version, pepper) === codeHash) return candidate;
  }
  return null;
}
