import { createHmac, randomBytes } from 'node:crypto';

/**
 * An employee invitation's reference (0101, D214): what the Owner reads out or shares, and the employee types.
 *
 * Twelve characters of Crockford's base32 — digits and capitals without I, L, O and U — shown in three groups,
 * `K7QM-9XRT-2CHD`: 60 random bits, short enough to read over a counter, typed without telling 0 from O or 1 from I
 * (both are accepted). It names nothing: no business, no person, no number. It is shown to the Owner once and never
 * stored — only its HMAC under STAFF_INVITATION_KEY, in this purpose's own domain, so the hash is comparable with no
 * other secret's and a leaked database yields no working reference.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LENGTH = 12;
const DOMAIN = 'dukan-erp/staff-invitation/v1';

/** How long an invitation can be opened: 72 hours (the owner's decision, D214). */
export const STAFF_INVITATION_TTL_MS = 72 * 60 * 60 * 1000;

/** The app's own link to the join form. It only opens the form, prefilled: it accepts and activates nothing. */
export const JOIN_LINK_BASE = 'dukanerp://join';

/** A fresh reference, normalised (no separators). 32 divides 256, so each byte's low five bits are uniform. */
export function newReference(): string {
  const bytes = randomBytes(LENGTH);
  let out = '';
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}

/** The reference as shown: three groups of four. */
export function formatReference(reference: string): string {
  return `${reference.slice(0, 4)}-${reference.slice(4, 8)}-${reference.slice(8, 12)}`;
}

/** The link that opens the join form with this reference filled in. */
export function joinLink(reference: string): string {
  return `${JOIN_LINK_BASE}?ref=${formatReference(reference)}`;
}

/**
 * What a person typed, as a reference: separators and spaces dropped, case folded, O read as 0 and I or L as 1.
 * Null when it cannot be one — refused before any lookup.
 */
export function normaliseReference(typed: unknown): string | null {
  if (typeof typed !== 'string' || typed.length > 40) return null;
  const folded = typed
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (folded.length !== LENGTH) return null;
  for (const c of folded) if (!ALPHABET.includes(c)) return null;
  return folded;
}

/** The stored form: HMAC-SHA256 (hex) of the normalised reference under the invitation key, in this purpose's domain. */
export function referenceHash(key: string, reference: string): string {
  return createHmac('sha256', key).update(`${DOMAIN}\n${reference}`).digest('hex');
}
