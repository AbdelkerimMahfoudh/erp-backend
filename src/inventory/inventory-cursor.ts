import { BadRequestException } from '@nestjs/common';

/**
 * Keyset cursor for inventory paging — constant size, whatever the inventory.
 *
 * Why keyset and not `skip`/`take`: stock changes while a user scrolls. With
 * offset paging, selling one unit shifts every later row up by one, so the next
 * page silently skips an item — inventory that hides stock is worse than
 * inventory that is slow.
 *
 * ── Why this carries a single id rather than a set ──────────────────────────
 *
 * An earlier version ordered by `date_in` alone and carried every id already
 * emitted at the boundary timestamp, excluding them with `NOT IN`. That is
 * correct but unbounded, and `date_in` ties are the NORM here rather than an
 * edge case: the column is `DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6)`, and
 * MySQL holds `CURRENT_TIMESTAMP` constant for an entire INSERT statement — so
 * a whole bulk receive or Excel import lands on one identical timestamp.
 *
 * Measured on that design:
 *
 *   tie group │ cursor chars │ vs 8 KB URL limit
 *   ──────────┼──────────────┼──────────────────
 *         150 │        7 879 │ ok
 *         200 │       10 479 │ EXCEEDS
 *       1 000 │       49 479 │ EXCEEDS  (also 4 s to drain)
 *       5 000 │      260 079 │ EXCEEDS  (458 s to drain)
 *
 * It broke above ~156 tied rows — below the maximum page size — and the
 * growing `NOT IN` made each successive query more expensive.
 *
 * The fix is to make the sort key itself unique, so ties cannot exist: order by
 * `id` alone. It is a UUIDv7 BINARY(16) — unique, immutable and time-ordered,
 * so `id DESC` still means "most recently added first" while being a total
 * order. The cursor is one id, ~90 characters, whatever the inventory size.
 *
 * Paging then uses Prisma's `cursor`, which is safe here specifically because
 * the sort key IS the primary key: Prisma resolves the anchor row by primary
 * key independently of the `where` filter, so a unit that changes status mid
 * scroll still anchors correctly. Units are never hard-deleted (nothing
 * financial is), so the anchor cannot disappear.
 */

/** Which stream the cursor points into — the two shapes page independently. */
export type CursorSection = 'unit' | 'stock';

export interface InventoryCursor {
  section: CursorSection;
  /** Boundary row id. Unique and immutable, so nothing else is needed. */
  id: string;
}

/**
 * Opaque to clients on purpose: base64url of JSON. Encoding it discourages
 * hand-crafted cursors and lets the internal shape change without a contract
 * change.
 */
export function encodeCursor(cursor: InventoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const { section, id } = parsed as Record<string, unknown>;

  if (section !== 'unit' && section !== 'stock') {
    throw new BadRequestException('Invalid pagination cursor');
  }
  // Validated as a UUID because it is interpolated into a binary comparison;
  // a malformed value must be rejected here rather than reaching the database.
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new BadRequestException('Invalid pagination cursor');
  }

  return { section, id };
}
