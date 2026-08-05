/**
 * Canonical contact handling for F1 Stage 1.
 *
 * We store one phone format — E.164 (`+` then 8–15 digits) — because it is what
 * a WhatsApp/OTP provider will expect later (Stage 4) and it makes the
 * per-company unique index meaningful: two spellings of the same number must
 * collide, not slip past as different strings.
 *
 * We deliberately do NOT pull in `libphonenumber` here. It is a new dependency
 * (which needs approval per CLAUDE.md), and full local→international conversion
 * needs a default region we do not have until a provider and country are
 * chosen. Stage 1 therefore accepts numbers already in international form and
 * normalizes only punctuation and a leading `00` international prefix.
 */

/** E.164: `+`, a leading non-zero digit, then a total of 8–15 digits. */
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Normalize a phone to E.164, or return `null` if it is not a valid
 * international number. Pure and side-effect free so it can be unit-tested
 * directly; the service turns a `null` into a 400.
 */
export function toE164(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2); // common international dialling prefix
  return E164.test(s) ? s : null;
}

/** A deliberately permissive check — email is optional recovery, not verified. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(raw: string): boolean {
  return typeof raw === 'string' && raw.length <= 160 && EMAIL.test(raw);
}
