import { randomInt } from 'node:crypto';

/**
 * What somebody types into the one sign-in field.
 *
 * An **email address or a WhatsApp number** — one or the other, never both, and
 * never a Store ID: a shopkeeper should not have to know their business's
 * identifier to reach their own till.
 *
 * "WhatsApp number" is what the app calls it, because that is what a shop calls
 * the number they are reachable on. Technically it is a **normalised phone
 * identifier and nothing more.** Nothing here proves the number is registered
 * with WhatsApp, or reachable, or verified — no verification service exists
 * yet. The label is a user-facing convention; it is not a claim.
 *
 * Pure and dependency-free so every rule here is testable without a database.
 */

/**
 * The alphabet a personal ID is drawn from.
 *
 * `I`, `L`, `O`, `U`, `0` and `1` are all absent, because these codes get
 * written on paper and read back over a phone. Thirty characters, so eight of
 * them give about 6.6e11 possibilities.
 */
export const ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ID_PREFIX = 'U-';
export const ID_BODY_LENGTH = 8;
export const ID_LENGTH = ID_PREFIX.length + ID_BODY_LENGTH;

/**
 * A fresh personal ID.
 *
 * `randomInt` rather than `Math.random`: this is an identifier people
 * authenticate with, and a predictable sequence would let one account's code
 * suggest another's. Uniqueness is still the database's job — the caller
 * retries on the unique-constraint violation, because two concurrent creations
 * racing on the same code is exactly what an application-level check misses.
 */
export function generatePersonalId(): string {
  let body = '';
  for (let i = 0; i < ID_BODY_LENGTH; i++) {
    body += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  }
  return ID_PREFIX + body;
}

/**
 * Whether a string is shaped like a personal ID.
 *
 * Case-insensitive, because somebody reading one off a note should not have to
 * care, and the stored form is always uppercase.
 */
export function isPersonalId(raw: string): boolean {
  const value = raw.trim().toUpperCase();
  if (value.length !== ID_LENGTH) return false;
  if (!value.startsWith(ID_PREFIX)) return false;
  return [...value.slice(ID_PREFIX.length)].every((c) => ID_ALPHABET.includes(c));
}

/** The stored form: trimmed and uppercased. */
export function normalisePersonalId(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * One canonical phone number.
 *
 * Mauritanian numbers are eight digits, usually written with spaces or hyphens
 * and sometimes with the +222 country code. All of those are the same number,
 * and a shop typing it the way it is printed on a card must not be told their
 * details are wrong.
 *
 * Returns `null` when the input is not a plausible phone at all, so the caller
 * can tell "this is a badly typed number" from "this was never a number".
 */
export function normalisePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  // Everything except digits and a single leading +.
  const cleaned = trimmed.replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(cleaned)) return null;

  const digits = cleaned.replace(/^\+/, '');

  // Local eight-digit form → assume the country the product is sold in.
  if (digits.length === 8) return `+222${digits}`;

  // Already carrying 222, with or without the plus.
  if (digits.length === 11 && digits.startsWith('222')) return `+${digits}`;

  /*
    Anything else is kept as an international number rather than rejected: the
    product is sold in Mauritania but a supplier or an owner abroad is not an
    error, and guessing a country code for them would be worse than storing
    what they typed.
  */
  if (digits.length >= 9 && digits.length <= 15) return `+${digits}`;

  return null;
}

/**
 * One canonical email address.
 *
 * **The case policy is the database's, not an invention here.** `users.email`
 * is `utf8mb4_0900_ai_ci` — case- and accent-insensitive — exactly like `login`
 * and `personal_id` before it. So `Owner@Shop.com` and `owner@shop.com` are
 * already the same row to MySQL, both for the unique index and for the lookup.
 * Storing the lowercased form simply makes what is written match what is
 * compared; it does not add a rule the database was not already applying.
 *
 * Strictly, RFC 5321 lets a local part be case-sensitive. No mail provider
 * anybody uses actually treats it that way, and honouring it here would let
 * `Ali@shop.com` and `ali@shop.com` become two accounts that cannot both
 * sign in — a foot-gun in exchange for a technicality.
 *
 * Validation is deliberately permissive, matching `users/contact.util.ts`:
 * refusing a legitimate but unusual address is a support call, while a typo is
 * caught immediately by the sign-in failing.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const EMAIL_MAX_LENGTH = 160;

export function isEmail(raw: string): boolean {
  const value = (raw ?? '').trim();
  return value.length <= EMAIL_MAX_LENGTH && EMAIL_SHAPE.test(value);
}

export function normaliseEmail(raw: string): string {
  return (raw ?? '').trim().toLowerCase();
}

export type IdentifierKind = 'email' | 'phone' | 'personal_id' | 'unrecognised';

export interface ClassifiedIdentifier {
  kind: IdentifierKind;
  /** The canonical form to look up, or null when nothing sensible was typed. */
  value: string | null;
}

/**
 * Decide what somebody typed, without asking them.
 *
 * Order matters, and each step is chosen so an earlier rule can never mangle
 * something meant for a later one:
 *
 *  1. **Email** — an `@` appears in no phone number and in no personal ID, so
 *     anything containing one is an email attempt and is never fed to the
 *     phone normaliser.
 *  2. **Personal ID** — starts with a letter, so no phone normalisation can
 *     produce one. Checked before phone for the same reason.
 *  3. **Phone** — the permissive parser, so a number typed the way it is
 *     printed on a card still resolves.
 *
 * The personal ID remains here **only as the transitional legacy path**. It is
 * not offered by the sign-in UI and is not advertised; it exists because every
 * active user at the time of this change had neither an email nor a phone, and
 * removing it would have locked all of them out of their own shop. See
 * `docs/36`. It comes out once those accounts carry a real contact.
 */
export function classifyIdentifier(raw: string): ClassifiedIdentifier {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return { kind: 'unrecognised', value: null };

  if (trimmed.includes('@')) {
    return isEmail(trimmed)
      ? { kind: 'email', value: normaliseEmail(trimmed) }
      : { kind: 'unrecognised', value: null };
  }

  if (isPersonalId(trimmed)) {
    return { kind: 'personal_id', value: normalisePersonalId(trimmed) };
  }

  const phone = normalisePhone(trimmed);
  if (phone) return { kind: 'phone', value: phone };

  return { kind: 'unrecognised', value: null };
}
