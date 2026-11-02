import { ConflictException, NotFoundException } from '@nestjs/common';

/**
 * Which lines of a basket were refused, and why (D227). By position and stable reason, never by IMEI or serial: the app
 * highlights its own line, and writes the words in the reader's language. Any refused line means nothing was saved.
 */
export type LineRefusal = 'not_found' | 'unavailable' | 'duplicate' | 'insufficient_quantity';

export interface RefusedLine {
  /** The line's place in the request's `lines`. */
  line: number;
  reason: LineRefusal;
  /** How many could still be sold, for `insufficient_quantity` when it is known. */
  available?: number;
}

export const refusedLine = (line: number): RefusedLine => ({ line, reason: 'unavailable' });

/** True when this unit is already in the basket; remembers it otherwise. */
export function seenTwice(seen: Set<string>, unitId: Buffer): boolean {
  const key = unitId.toString('hex');
  if (seen.has(key)) return true;
  seen.add(key);
  return false;
}

const WORDS: Record<LineRefusal, string> = {
  not_found: 'That item was not found.',
  unavailable: 'That item was taken while you were selling — it is no longer available.',
  duplicate: 'That item is already in this sale.',
  insufficient_quantity: 'There is not enough of that item left to sell.',
};

/** Nothing can be found at all is a 404, as a single item always answered; anything else is a conflict. */
export function lineConflict(lines: RefusedLine[]): ConflictException | NotFoundException {
  const body = { code: 'sale_line_conflict', message: WORDS[lines[0].reason], lines };
  return lines.every((l) => l.reason === 'not_found') ? new NotFoundException(body) : new ConflictException(body);
}
