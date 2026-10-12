import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords for platform administrators (RFC 6238 over RFC 4226; correction phase,
 * 2026-10-12): HMAC-SHA1, 30-second steps, six digits — what every authenticator app (Google Authenticator,
 * Microsoft Authenticator, 1Password, Aegis…) produces from an `otpauth://` key. One step either side is
 * accepted for a phone clock a little off; a step at or before the last one accepted is refused, so a code
 * seen over a shoulder cannot be used again.
 *
 * Pure: no clock, no database. `node:crypto` only.
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps accepted either side of now. */
export const TOTP_WINDOW = 1;
/** 160 bits, as RFC 4226 recommends for HMAC-SHA1. */
export const TOTP_SECRET_BYTES = 20;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch);
    if (index < 0) throw new Error('Not a base32 key');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret, as the base32 key an authenticator app is given. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

export function stepAt(epochMs: number): number {
  return Math.floor(epochMs / 1000 / TOTP_STEP_SECONDS);
}

/** The code for one step (RFC 4226 §5.3 dynamic truncation). */
export function totpForStep(secretBase32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * The step a code matches — within the window, after the last step this administrator used — or null.
 * Every candidate is compared in constant time, and every candidate is computed, so the answer takes as long for
 * a near miss as for a match.
 */
export function verifyTotp(secretBase32: string, code: string, epochMs: number, lastUsedStep: number | null): number | null {
  const typed = (code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(typed)) return null;
  const now = stepAt(epochMs);
  let matched: number | null = null;
  for (let step = now - TOTP_WINDOW; step <= now + TOTP_WINDOW; step++) {
    const expected = Buffer.from(totpForStep(secretBase32, step));
    if (timingSafeEqual(expected, Buffer.from(typed)) && (lastUsedStep === null || step > lastUsedStep) && matched === null) matched = step;
  }
  return matched;
}

/** The key as an authenticator app reads it from a QR code or a link. The label names the account, not a secret. */
export function otpauthUri(input: { issuer: string; account: string; secret: string }): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const params = new URLSearchParams({ secret: input.secret, issuer: input.issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
