import { BadRequestException } from '@nestjs/common';

/**
 * Keyset cursor for catalog paging (G1).
 *
 * Same reasoning as the inventory cursor: the catalog changes while a manager
 * scrolls, and with `skip`/`take` adding one product shifts every later row so
 * the next page silently skips one. The sort key is `id` alone — a UUIDv7
 * `BINARY(16)`, unique, immutable and time-ordered — so `id DESC` reads as
 * "newest first" while being a TOTAL order, which means ties cannot exist and
 * the cursor stays one id long whatever the catalog size.
 *
 * Products are never hard-deleted (archiving sets `deleted_at`), so the anchor
 * row cannot vanish mid-scroll.
 */
export interface CatalogCursor {
  id: string;
}

/** Opaque to clients on purpose, so the internal shape can change freely. */
export function encodeCatalogCursor(cursor: CatalogCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeCatalogCursor(raw: string): CatalogCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('Invalid pagination cursor');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new BadRequestException('Invalid pagination cursor');
  }
  const { id } = parsed as Record<string, unknown>;
  // Validated here because it is interpolated into a binary comparison.
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new BadRequestException('Invalid pagination cursor');
  }
  return { id };
}
