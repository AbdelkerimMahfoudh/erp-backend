import { BadRequestException } from '@nestjs/common';
import { isValidImei } from '../inventory/imei.util';

/**
 * Choosing the phone to sell — the rules every way of finding it shares.
 *
 * A phone can be scanned, typed or picked from the shelf. Whichever it was, the
 * answer is one selection describing the SAME existing Unit, and these rules are
 * the only place its availability is decided. They are pure so each can be
 * tested on its own.
 *
 * Finding a phone never creates anything: no Product, no Unit, no stock line,
 * and never a barcode made out of an IMEI.
 */

/** What a sale may do with the phone it found. */
export type Availability =
  | 'available'
  | 'sold'
  | 'faulty'
  | 'reserved'
  | 'other_branch'
  | 'unavailable';

/**
 * Presentation characters only: spaces, dashes, dots, slashes. Anything else is
 * kept, so a serial number with letters survives and a mistyped letter in an
 * IMEI is caught by validation rather than silently removed.
 */
export function normalizeIdentifier(raw: string): string {
  return raw.trim().replace(/[\s\-./]+/g, '');
}

/** A fifteen-digit all-number code — the one shape that is an IMEI. */
export function looksLikeImei(identifier: string): boolean {
  return /^\d{15}$/.test(identifier);
}

/**
 * The one gate every identifier passes before it is looked up.
 *
 * An item can be found three ways — an IMEI, a serial number, or a product
 * barcode — so this no longer assumes every code is an IMEI. It refuses only
 * two things: nothing at all, and a fifteen-digit number whose checksum is
 * wrong. That second rule matters: a mistyped IMEI is an **invalid IMEI**, and
 * must be told so — never quietly reinterpreted as a barcode, which is exactly
 * the "guess the type from altered digits" mistake that attaches a code to the
 * wrong thing. Everything else (a serial, a barcode, a shorter or longer
 * number) is allowed through, and the lookup decides what it is.
 */
export function assertLookupIdentifier(identifier: string): void {
  if (identifier.length === 0) {
    throw new BadRequestException({ code: 'identifier_missing', message: 'Enter an identifier' });
  }
  if (looksLikeImei(identifier) && !isValidImei(identifier)) {
    throw new BadRequestException({ code: 'imei_checksum', message: 'That is not a valid IMEI — check the digits' });
  }
}

/**
 * Whether this phone can be sold here, now.
 *
 * Another branch's phone is reported as exactly that and nothing more — which
 * branch it sits in is not disclosed by a sale lookup.
 */
export function availabilityOf(status: string, unitBranchId: Buffer, activeBranchId: Buffer): Availability {
  if (status === 'sold') return 'sold';
  if (status === 'faulty' || status === 'returned') return 'faulty';
  if (!unitBranchId.equals(activeBranchId)) return 'other_branch';
  if (status === 'in_stock') return 'available';
  if (status === 'reserved' || status === 'in_transit') return 'reserved';
  return 'unavailable';
}

/**
 * Storage and colour, when the catalogue actually says them.
 *
 * Explicit specification fields win. Otherwise a phone variant written the way
 * receiving writes it — "128 GB · Black" — is read apart: the part carrying a
 * GB/TB size is the storage and the rest is the colour. Nothing is guessed: a
 * variant that does not read that way answers null for both.
 */
export function variantParts(
  variant: string | null,
  specifications: Record<string, unknown> | null,
): { storage: string | null; colour: string | null } {
  const spec = (k: string) => {
    const v = specifications?.[k];
    return typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null;
  };
  let storage = spec('storage');
  let colour = spec('colour') ?? spec('color');
  if ((!storage || !colour) && variant) {
    const parts = variant.split(/\s*[·|/,]\s*/).map((p) => p.trim()).filter(Boolean);
    const sized = parts.find((p) => /^\d+(?:\.\d+)?\s*(?:GB|TB|Go|To)$/i.test(p));
    if (sized) {
      // As the catalogue wrote it: "128 GB" stays "128 GB", "128 Go" stays "128 Go".
      storage ??= sized;
      const rest = parts.filter((p) => p !== sized);
      colour ??= rest.length > 0 ? rest.join(' · ') : null;
    }
  }
  return { storage, colour };
}

/** The last four digits, for a screen that must show which phone without showing the number. */
export function maskIdentifier(identifier: string | null): string | null {
  if (!identifier) return null;
  return `•••• ${identifier.slice(-4)}`;
}

/** The one answer a caller without `branch.manage` gets for a phone that is not here. */
export const NOT_AVAILABLE_HERE = {
  code: 'not_available_here',
  message: 'This phone is not available in this branch.',
} as const;

/**
 * Whether the caller may learn anything about a phone outside the active
 * branch. Without `branch.manage` a phone elsewhere — sold, in stock or
 * otherwise — is answered exactly like a number that exists nowhere, so the
 * lookup cannot be used to probe other branches' stock.
 */
export function branchDisclosure(
  unitBranchId: Buffer,
  activeBranchId: Buffer,
  canViewBranches: boolean,
): 'here' | 'shown' | 'hidden' {
  if (unitBranchId.equals(activeBranchId)) return 'here';
  return canViewBranches ? 'shown' : 'hidden';
}
