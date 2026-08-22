import { randomInt } from 'node:crypto';

/**
 * What somebody types into the one sign-in field (CP3).
 *
 * Either a phone number or a generated personal ID. Only one, never both, and
 * never a Store ID — a shopkeeper should not have to know their business's
 * identifier to reach their own till.
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

export type IdentifierKind = 'personal_id' | 'phone' | 'unrecognised';

export interface ClassifiedIdentifier {
  kind: IdentifierKind;
  /** The canonical form to look up, or null when nothing sensible was typed. */
  value: string | null;
}

/**
 * Decide what somebody typed, without asking them.
 *
 * The personal ID is checked **first**. It starts with a letter, so no phone
 * normalisation can ever produce one, and testing it first means an ID is
 * never mangled by the phone rules — the failure the brief warns about, where
 * an arbitrary identifier is transformed as though it were a number.
 */
export function classifyIdentifier(raw: string): ClassifiedIdentifier {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return { kind: 'unrecognised', value: null };

  if (isPersonalId(trimmed)) {
    return { kind: 'personal_id', value: normalisePersonalId(trimmed) };
  }

  const phone = normalisePhone(trimmed);
  if (phone) return { kind: 'phone', value: phone };

  return { kind: 'unrecognised', value: null };
}
