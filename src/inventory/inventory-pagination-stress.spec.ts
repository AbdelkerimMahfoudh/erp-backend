import { InventoryService, type InventoryPage } from './inventory.service';
import { uuidToBin, binToUuid } from '../common/utils/uuid.util';

/**
 * Pagination at import scale — a regression guard on cursor SIZE.
 *
 * The correctness suite proves paging returns every row once. This file asks a
 * different question: does the cursor stay small enough to actually travel in a
 * URL as inventory grows?
 *
 * It exists because the first implementation failed that question. Ordering by
 * `date_in` alone forced the cursor to carry every id already emitted at the
 * boundary timestamp, and `date_in` ties are the NORM here: the column is
 * `DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6)`, MySQL holds `CURRENT_TIMESTAMP`
 * constant for a whole INSERT, and a bulk receive is one INSERT. Measured then:
 *
 *   tie group │ cursor chars │ drain time
 *   ──────────┼──────────────┼───────────
 *         200 │       10 479 │        — exceeded an 8 KB URL already
 *       1 000 │       49 479 │      4 s
 *       5 000 │      260 079 │    458 s
 *
 * Ordering by `id` alone removed ties entirely (UUIDv7 is unique and
 * time-ordered), so the cursor is now one id and constant size. These tests
 * pin that: if anyone reintroduces a tie-accumulating cursor, the size
 * assertions fail long before a shop discovers it.
 */

const BRANCH = uuidToBin('018f0000-0000-7000-8000-0000000000b1');
const PRODUCT = uuidToBin('018f0000-0000-7000-8000-0000000000a1');

/** Conservative real-world ceiling: many proxies cap a request line at 8 KB. */
const PRACTICAL_URL_LIMIT = 8192;
/** What one cursor may occupy, leaving ample room for the rest of the URL. */
const CURSOR_BUDGET = 512;

function id(n: number): Buffer {
  return uuidToBin(`018f0000-0000-7000-8000-${String(n).padStart(12, '0')}`);
}

/** Every row shares one timestamp — the bulk-import worst case. */
const TIED_AT = new Date('2026-01-01T00:00:00.000Z');

function tiedUnits(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: id(i + 1),
    branchId: BRANCH,
    productId: PRODUCT,
    imeiPrimary: `35688${String(i + 1).padStart(10, '0')}`,
    imeiSecondary: null,
    serialNo: null,
    status: 'in_stock',
    cost: 800,
    dateIn: TIED_AT,
    product: {
      brand: 'Apple',
      model: 'iPhone 15',
      variant: '256GB',
      barcode: null,
      trackingType: 'imei',
      specifications: null,
    },
  }));
}

interface Stats {
  rows: number;
  unique: number;
  pages: number;
  maxCursorChars: number;
}

/**
 * Prisma double supporting the slice of behaviour paging depends on:
 * `orderBy id desc`, `cursor` and `skip`. Anything less would let a broken
 * cursor pass.
 */
async function drain(units: any[], limit: number): Promise<Stats> {
  const db = {
    unit: {
      findMany: jest.fn(async ({ where, take, cursor, skip }: any) => {
        let rows = units
          .filter((u: any) => !where?.branchId || u.branchId.equals(where.branchId))
          .sort((a: any, b: any) => Buffer.compare(b.id, a.id));
        if (cursor?.id) {
          const at = rows.findIndex((r: any) => r.id.equals(cursor.id));
          // Prisma resolves the anchor by primary key; -1 would mean the row is
          // genuinely gone, which cannot happen for units.
          rows = at === -1 ? [] : rows.slice(at + (skip ?? 0));
        }
        return rows.slice(0, take);
      }),
      count: jest.fn(async () => units.length),
    },
    stockItem: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
  };

  const service = new InventoryService(
    db as never,
    { branchId: () => BRANCH } as never,
    {} as never,
    {} as never,
  );

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let maxCursorChars = 0;

  do {
    const page: InventoryPage = await service.listStock({ limit, cursor: cursor ?? undefined });
    seen.push(...page.rows.map((r) => binToUuid(r.id)));
    cursor = page.nextCursor;
    if (cursor) maxCursorChars = Math.max(maxCursorChars, cursor.length);
    pages += 1;
    if (pages > 2000) throw new Error('pagination did not terminate');
  } while (cursor);

  return { rows: seen.length, unique: new Set(seen).size, pages, maxCursorChars };
}

describe('inventory pagination — tie-group scale', () => {
  jest.setTimeout(120_000);

  it('1,000 rows sharing one timestamp: every row once, cursor stays small', async () => {
    const stats = await drain(tiedUnits(1000), 50);

    expect(stats.rows).toBe(1000);
    expect(stats.unique).toBe(1000);
    expect(stats.maxCursorChars).toBeLessThan(CURSOR_BUDGET);
  });

  it('5,000 rows sharing one timestamp: every row once, cursor stays small', async () => {
    const stats = await drain(tiedUnits(5000), 50);

    expect(stats.rows).toBe(5000);
    expect(stats.unique).toBe(5000);
    expect(stats.maxCursorChars).toBeLessThan(CURSOR_BUDGET);
  });

  it('a small page size forces many pages without losing or repeating rows', async () => {
    const stats = await drain(tiedUnits(1000), 10);

    expect(stats.rows).toBe(1000);
    expect(stats.unique).toBe(1000);
    expect(stats.pages).toBeGreaterThan(90);
  });

  /**
   * The load-bearing assertion: cursor size must not scale with inventory.
   * Same page size, 5× the rows — the cursor must not grow at all.
   */
  it('cursor size is constant, not proportional to inventory', async () => {
    const small = await drain(tiedUnits(200), 50);
    const large = await drain(tiedUnits(5000), 50);

    expect(large.maxCursorChars).toBe(small.maxCursorChars);
    expect(large.maxCursorChars + 200).toBeLessThan(PRACTICAL_URL_LIMIT);
  });
});
