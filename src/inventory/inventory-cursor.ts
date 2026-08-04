import { BadRequestException } from '@nestjs/common';

/**
 * Keyset cursor for inventory paging.
 *
 * Why keyset and not `skip`/`take`: stock changes while a user scrolls. With
 * offset paging, selling one unit shifts every later row up by one, so the next
 * page silently skips an item — inventory that hides stock is worse than
 * inventory that is slow.
 *
 * Why value-based and not Prisma's `cursor`: Prisma's cursor locates a specific
 * row to page from. If that row leaves the filtered set — the unit was sold and
 * the filter is `in_stock` — the position cannot be found and the listing ends
 * early, which is the same silent truncation in a different disguise. Comparing
 * *values* has no such failure mode; the anchor row may vanish and paging still
 * resumes at exactly the right place.
 *
 * Ties: `date_in` is DATETIME(6), and a bulk receive can stamp several units
 * within the same microsecond. A plain `<` would drop the tied rows, so the
 * cursor also carries the ids already returned at the boundary timestamp and
 * excludes them by id. That set is bounded by the page size.
 */

/** Which stream the cursor points into — the two shapes page independently. */
export type CursorSection = 'unit' | 'stock';

export interface InventoryCursor {
  section: CursorSection;
  /** Boundary sort value (ISO-8601, microsecond precision preserved). */
  at: string;
  /** Ids already emitted that share `at` exactly. */
  seen: string[];
}

/**
 * Opaque to clients on purpose: base64url of JSON. Encoding it discourages
 * hand-crafted cursors and lets the internal shape change without a contract
 * change.
 */
export function encodeCursor(cursor: InventoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): InventoryCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('Invalid pagination cursor');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new BadRequestException('Invalid pagination cursor');
  }

  const { section, at, seen } = parsed as Record<string, unknown>;

  if (section !== 'unit' && section !== 'stock') {
    throw new BadRequestException('Invalid pagination cursor');
  }
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    throw new BadRequestException('Invalid pagination cursor');
  }
  if (!Array.isArray(seen) || seen.some((id) => typeof id !== 'string')) {
    throw new BadRequestException('Invalid pagination cursor');
  }

  return { section, at, seen: seen as string[] };
}
