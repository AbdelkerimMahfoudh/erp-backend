import { readFileSync } from 'node:fs';
import { BadRequestException, ForbiddenException, PayloadTooLargeException } from '@nestjs/common';
import { parseCsv } from '../imports/csv';
import { ReportsService, MAX_EXPORT_ROWS } from './reports.service';
import { financialColumnDrift, REPORT_KINDS, REPORTS } from './report-catalogue';
import { translationDrift } from './report-i18n';

/**
 * What a report is allowed to say, and to whom.
 *
 * The rule under all of this: a CSV is a string, and a string has no keys left
 * to strip. `CostGatingInterceptor` protects JSON responses by mapping over the
 * object after the controller returns — but a file written straight to the
 * response never reaches it. So the gating has to happen while the data is
 * still shaped, and these tests exist to prove it does.
 */

const OWNER = new Set([
  'report.view',
  'cost.view',
  'loan.view',
  'supplier.manage',
]);
/** A real manager: reports and stock, no cost and no margin. */
const MANAGER = new Set(['report.view', 'loan.view']);

const BRANCH = Buffer.alloc(16, 7);

interface Seed {
  products?: Record<string, unknown>[];
  employees?: Record<string, unknown>[];
  branches?: Record<string, unknown>[];
  dead?: Record<string, unknown>[];
  loans?: Record<string, unknown>[];
  suppliers?: { rows: Record<string, unknown>[]; nextCursor: string | null }[];
}

function harness(permissions: ReadonlySet<string>, seed: Seed = {}, branchId: Buffer | null = BRANCH) {
  const audited: Record<string, unknown>[] = [];
  const supplierPages = seed.suppliers ?? [{ rows: [], nextCursor: null }];
  let pageIndex = 0;

  const analytics: any = {
    productPerformance: jest.fn(async (days: number) => ({
      windowDays: days,
      products: seed.products ?? [],
    })),
  };
  const dashboard: any = {
    employeePerformance: jest.fn(async () => seed.employees ?? []),
    branchComparison: jest.fn(async () => seed.branches ?? []),
    deadStock: jest.fn(async (limit?: number) => {
      // The export must ask for everything. A limit here would be the dashboard
      // saved to a file rather than a report.
      expect(limit).toBeUndefined();
      return seed.dead ?? [];
    }),
  };
  const loans: any = {
    list: jest.fn(async (_group: unknown, opts: { all?: boolean }) => {
      expect(opts?.all).toBe(true); // never the 200-row screen cap
      return { rows: seed.loans ?? [] };
    }),
  };
  const suppliers: any = {
    list: jest.fn(async () => supplierPages[pageIndex++] ?? { rows: [], nextCursor: null }),
  };
  const tenant: any = { branchId: () => branchId, companyId: () => Buffer.alloc(16, 1) };
  const audit: any = { record: jest.fn(async (p: Record<string, unknown>) => void audited.push(p)) };
  const cls: any = { get: (k: string) => (k === 'permissions' ? permissions : undefined) };
  const db: any = { branch: { findFirst: jest.fn(async () => ({ name: 'Main Store' })) } };

  const service = new ReportsService(analytics, dashboard, loans, suppliers, tenant, audit, cls, db);
  return { service, audited, analytics, dashboard, loans, suppliers, db };
}

/**
 * The file, parsed with the project's own reader.
 *
 * A plain rectangle: header row, then data. Provenance lives in the filename —
 * see the note on `writeCsv`, and the test below that pins it.
 */
function table(csv: string): string[][] {
  return parseCsv(csv).rows;
}

const PRODUCT = {
  label: 'Samsung A15',
  trackingType: 'imei',
  qtySold: 3,
  revenue: 45000,
  cogs: 30000,
  grossProfit: 15000,
  sold30d: 3,
  lastSoldAt: new Date('2026-08-30T10:00:00.000Z'),
};

describe('the catalogue itself', () => {
  it('declares every kind exactly once', () => {
    expect(Object.keys(REPORTS).sort()).toEqual([...REPORT_KINDS].sort());
  });

  it('never marks a column financial that the interceptor would not strip', () => {
    // One list, two consumers. A financial field added to one and forgotten in
    // the other is precisely how a margin column survives into a file.
    expect(financialColumnDrift()).toEqual([]);
  });

  it('carries every header in all three languages', () => {
    expect(translationDrift()).toEqual([]);
  });
});

describe('an Owner exporting', () => {
  it('gets the financial columns', async () => {
    const { service } = harness(OWNER, { products: [PRODUCT] });
    const { csv, columnIds } = await service.export({ kind: 'profit-by-product', locale: 'en' });

    expect(columnIds).toContain('grossProfit');
    expect(columnIds).toContain('cogs');
    const [header, row] = table(csv);
    expect(header).toEqual([
      'Product', 'Tracking', 'Quantity sold', 'Revenue (MRU)',
      'Cost of goods sold (MRU)', 'Gross profit (MRU)',
    ]);
    expect(row).toEqual(['Samsung A15', 'imei', '3', '45000.00', '30000.00', '15000.00']);
  });

  it('names the currency in the header and never in a cell', async () => {
    const { service } = harness(OWNER, { products: [PRODUCT] });
    const { csv } = await service.export({ kind: 'profit-by-product', locale: 'en' });
    const [header, row] = table(csv);
    expect(header.filter((h) => h.includes('MRU'))).toHaveLength(3);
    expect(row.some((c) => c.includes('MRU'))).toBe(false);
  });

  it('says which period the file covers, in its name', async () => {
    const { service } = harness(OWNER, { products: [PRODUCT] });
    const r = await service.export({ kind: 'profit-by-product', locale: 'en', days: 7 });
    expect(r.filename).toMatch(/^profit-by-product_\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}_en\.csv$/);
    expect(r.scope).toBe('Main Store');
    expect(r.rowCount).toBe(1);
  });

  it('names an as-of report so it cannot be mistaken for a period one', async () => {
    // The confusion worth preventing: a current-stock file read as a month of
    // trading. Nothing in the bytes distinguishes them, so the name must.
    const { service } = harness(OWNER, { dead: [] });
    const r = await service.export({ kind: 'dead-stock', locale: 'en' });
    expect(r.filename).toMatch(/^dead-stock_as-of_\d{4}-\d{2}-\d{2}_en\.csv$/);
    expect(r.filename).not.toContain('_to_');
  });

  it('keeps the filename ASCII whatever the language', async () => {
    // A Content-Disposition carrying Arabic needs RFC 5987 encoding that not
    // every client implements, and a file that will not save is not a report.
    const { service } = harness(OWNER, { products: [] });
    for (const locale of ['en', 'fr', 'ar'] as const) {
      const { filename } = await service.export({ kind: 'profit-by-product', locale });
      expect(filename).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});

describe('a Manager exporting the same report', () => {
  it('gets a file with the financial columns absent, not blank', async () => {
    /*
     * Blank cells under a `Gross profit` header would tell the reader a number
     * exists and is being kept from them. The column simply not being there is
     * the honest shape of what they may know.
     */
    const { service } = harness(MANAGER, { products: [PRODUCT] });
    const { csv, columnIds } = await service.export({ kind: 'profit-by-product', locale: 'en' });

    expect(columnIds).not.toContain('grossProfit');
    expect(columnIds).not.toContain('cogs');
    const [header, row] = table(csv);
    expect(header).toEqual(['Product', 'Tracking', 'Quantity sold', 'Revenue (MRU)']);
    expect(row).toEqual(['Samsung A15', 'imei', '3', '45000.00']);
  });

  it('leaks no forbidden figure anywhere in the bytes', async () => {
    const { service } = harness(MANAGER, { products: [PRODUCT] });
    const { csv } = await service.export({ kind: 'profit-by-product', locale: 'en' });

    // Not in a header, not in a cell, not in the metadata block, not in a total.
    expect(csv).not.toContain('15000');
    expect(csv).not.toContain('30000');
    expect(csv.toLowerCase()).not.toContain('profit,');
    expect(csv.toLowerCase()).not.toContain('cost of goods');
  });

  it('is refused a report that is nothing but figures they may not see', async () => {
    /*
     * A profit report stripped to a list of names is not a smaller report, it
     * is a different and useless one. Handing it over as a success is the
     * misleading substitute this must never return.
     */
    const onlyMoney = { ...REPORTS['profit-by-branch'] };
    const saved = REPORTS['profit-by-branch'].columns;
    (REPORTS['profit-by-branch'] as { columns: unknown }).columns = onlyMoney.columns.filter(
      (c) => c.identity || c.financial,
    );
    try {
      const { service } = harness(MANAGER, { branches: [{ name: 'Main', netProfit: 1 }] });
      await expect(service.export({ kind: 'profit-by-branch', locale: 'en' })).rejects.toThrow(
        ForbiddenException,
      );
    } finally {
      (REPORTS['profit-by-branch'] as { columns: unknown }).columns = saved;
    }
  });

  it('is refused the debt report without loan.view', async () => {
    const noLoans = new Set(['report.view']);
    const { service } = harness(noLoans);
    await expect(service.export({ kind: 'debtors-creditors', locale: 'en' })).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('is re-checked on every request, not once', async () => {
    const { service } = harness(MANAGER, { products: [PRODUCT] });
    const first = await service.export({ kind: 'profit-by-product', locale: 'en' });
    const second = await service.export({ kind: 'profit-by-product', locale: 'en' });
    expect(first.columnIds).toEqual(second.columnIds);
    expect(second.columnIds).not.toContain('grossProfit');
  });
});

describe('period and as-of', () => {
  it('refuses a date range on a report that describes the present', async () => {
    // Ignoring it would answer a different question and say nothing about it.
    const { service } = harness(OWNER);
    await expect(
      service.export({ kind: 'dead-stock', locale: 'en', days: 30 }),
    ).rejects.toThrow(BadRequestException);
  });

  it('labels an as-of report with the day it was taken', async () => {
    const { service } = harness(OWNER, { dead: [] });
    const { filename } = await service.export({ kind: 'dead-stock', locale: 'en' });
    expect(filename).toContain('as-of_');
  });

  it.each([0, 367, 1.5, Number.NaN])('rejects days=%p', async (days) => {
    const { service } = harness(OWNER);
    await expect(
      service.export({ kind: 'profit-by-product', locale: 'en', days: days as number }),
    ).rejects.toThrow(BadRequestException);
  });

  it.each([1, 30, 366])('accepts days=%p', async (days) => {
    const { service, analytics } = harness(OWNER, { products: [] });
    await service.export({ kind: 'profit-by-product', locale: 'en', days });
    expect(analytics.productPerformance).toHaveBeenCalledWith(days);
  });

  it('changing the period asks for a different window and names it', async () => {
    const { service, analytics } = harness(OWNER, { products: [PRODUCT] });
    const a = await service.export({ kind: 'profit-by-product', locale: 'en', days: 7 });
    const b = await service.export({ kind: 'profit-by-product', locale: 'en', days: 90 });

    expect(analytics.productPerformance).toHaveBeenNthCalledWith(1, 7);
    expect(analytics.productPerformance).toHaveBeenNthCalledWith(2, 90);
    // The bytes can coincide when the seeded rows do; the name cannot.
    expect(a.filename).not.toEqual(b.filename);
  });
});

describe('completeness', () => {
  it('exports every dead-stock row, not the dashboard\'s ten', async () => {
    const dead = Array.from({ length: 25 }, (_, i) => ({
      label: `Product ${i}`, trackingType: 'quantity', inStock: 1,
      inventoryValue: 100 - i, lastSoldAt: null,
    }));
    const { service } = harness(OWNER, { dead });
    const { rowCount, csv } = await service.export({ kind: 'dead-stock', locale: 'en' });
    expect(rowCount).toBe(25);
    expect(table(csv)).toHaveLength(26); // header + 25
  });

  it('pages through every supplier rather than exporting the first page', async () => {
    const { service, suppliers } = harness(OWNER, {
      suppliers: [
        { rows: [{ name: 'A', outstanding: 100 }], nextCursor: 'c1' },
        { rows: [{ name: 'B', outstanding: 200 }], nextCursor: 'c2' },
        { rows: [{ name: 'C', outstanding: 300 }], nextCursor: null },
      ],
    });
    const { rowCount } = await service.export({ kind: 'debtors-creditors', locale: 'en' });
    expect(suppliers.list).toHaveBeenCalledTimes(3);
    expect(rowCount).toBe(3);
  });

  it('refuses an oversized export instead of truncating it', async () => {
    const dead = Array.from({ length: MAX_EXPORT_ROWS + 1 }, () => ({ label: 'x', inStock: 1 }));
    const { service } = harness(OWNER, { dead });
    await expect(service.export({ kind: 'dead-stock', locale: 'en' })).rejects.toThrow(
      PayloadTooLargeException,
    );
  });

  it('ranks movers by quantity and profit-by-product by profit', async () => {
    const products = [
      { ...PRODUCT, label: 'Earns more', qtySold: 1, grossProfit: 900 },
      { ...PRODUCT, label: 'Moves more', qtySold: 50, grossProfit: 10 },
    ];
    const { service } = harness(OWNER, { products });
    const movers = table((await service.export({ kind: 'movers', locale: 'en' })).csv);
    const profit = table((await service.export({ kind: 'profit-by-product', locale: 'en' })).csv);
    expect(movers[1][0]).toBe('Moves more');
    // productPerformance is already profit-desc; the export keeps that order.
    expect(profit[1][0]).toBe('Earns more');
  });
});

describe('debtors and creditors', () => {
  const seed = {
    loans: [
      { direction: 'they_owe_us', otherParty: 'Ahmed', statusText: 'Confirmed', remaining: 4000, createdAt: new Date('2026-05-02T00:00:00Z') },
      { direction: 'we_owe_them', otherParty: 'Fatima', statusText: 'Confirmed', remaining: 1500, createdAt: new Date('2026-06-11T00:00:00Z') },
      { direction: 'they_owe_us', otherParty: 'Settled', statusText: 'Confirmed', remaining: 0, createdAt: new Date() },
    ],
    suppliers: [{ rows: [{ name: 'Wholesaler', outstanding: 9000 }], nextCursor: null }],
  };

  it('keeps the two directions distinguishable on every row', async () => {
    const { service } = harness(OWNER, seed);
    const rows = table((await service.export({ kind: 'debtors-creditors', locale: 'en' })).csv).slice(1);

    const byName = Object.fromEntries(rows.map((r) => [r[2], r]));
    expect(byName['Ahmed'][0]).toBe('owed_to_us');
    expect(byName['Fatima'][0]).toBe('owed_by_us');
    expect(byName['Wholesaler'][0]).toBe('owed_by_us');
  });

  it('says which ledger each row came from', async () => {
    const { service } = harness(OWNER, seed);
    const rows = table((await service.export({ kind: 'debtors-creditors', locale: 'en' })).csv).slice(1);
    expect(rows.map((r) => r[1]).sort()).toEqual(['loan', 'loan', 'supplier']);
  });

  it('omits a settled debt rather than writing a zero row', async () => {
    const { service } = harness(OWNER, seed);
    const rows = table((await service.export({ kind: 'debtors-creditors', locale: 'en' })).csv).slice(1);
    expect(rows.map((r) => r[2])).not.toContain('Settled');
  });

  it('writes no supplier row at all when the caller may not see the balance', async () => {
    /*
     * `SuppliersService` omits `outstanding` entirely for such a caller. Not
     * written is the only honest option: "we owe nothing" and "you may not know
     * what we owe" cannot share a cell.
     */
    const { service } = harness(MANAGER, {
      loans: seed.loans,
      suppliers: [{ rows: [{ name: 'Wholesaler' }], nextCursor: null }],
    });
    const rows = table((await service.export({ kind: 'debtors-creditors', locale: 'en' })).csv).slice(1);
    expect(rows.map((r) => r[2])).not.toContain('Wholesaler');
  });
});

describe('branch scope', () => {
  it('names the active branch in the file', async () => {
    const { service } = harness(OWNER, { products: [] });
    const { scope } = await service.export({ kind: 'profit-by-product', locale: 'en' });
    expect(scope).toBe('Main Store');
  });

  it('says all branches when no branch is selected', async () => {
    const { service } = harness(OWNER, { products: [] }, null);
    const { scope } = await service.export({ kind: 'profit-by-product', locale: 'en' });
    expect(scope).toBe('All branches');
  });

  it('never claims a branch scope for the branch comparison', async () => {
    // It is company-wide by construction; naming the active branch would be a
    // lie about what the file contains.
    const { service } = harness(OWNER, { branches: [] });
    const { scope } = await service.export({ kind: 'profit-by-branch', locale: 'en' });
    expect(scope).toContain('this report always compares the whole company');
    expect(scope).not.toContain('Main Store');
  });
});

describe('languages', () => {
  it.each([
    ['fr', 'Bénéfice par produit', 'Chiffre d’affaires (MRU)'],
    ['ar', 'الربح حسب المنتج', 'الإيرادات (MRU)'],
  ])('writes %s headers', async (locale, title, revenue) => {
    const { service } = harness(OWNER, { products: [PRODUCT] });
    const { csv } = await service.export({ kind: 'profit-by-product', locale: locale as 'fr' });
    expect(table(csv)[0]).toContain(revenue);
    expect(title.length).toBeGreaterThan(0);
  });

  it('keeps the same numbers whatever the language', async () => {
    const { service } = harness(OWNER, { products: [PRODUCT] });
    const en = table((await service.export({ kind: 'profit-by-product', locale: 'en' })).csv)[1];
    const ar = table((await service.export({ kind: 'profit-by-product', locale: 'ar' })).csv)[1];
    expect(en.slice(2)).toEqual(ar.slice(2));
  });
});

describe('the audit row', () => {
  it('records what was asked for and what was allowed', async () => {
    const { service, audited } = harness(OWNER, { products: [PRODUCT] });
    await service.export({ kind: 'profit-by-product', locale: 'fr', days: 14 });

    expect(audited).toHaveLength(1);
    const after = audited[0].after as Record<string, unknown>;
    expect(audited[0].entityType).toBe('report_export');
    expect(after.kind).toBe('profit-by-product');
    expect(after.days).toBe(14);
    expect(after.locale).toBe('fr');
    expect(after.rowCount).toBe(1);
    expect(after.branchScope).toBe('branch');
    expect(after.columns).toContain('grossProfit');
  });

  it('names the event as GENERATED, never as downloaded', async () => {
    // The server saw itself produce bytes. Whether they reached a person, a
    // share sheet or a bin is not something this process observed.
    const { service, audited } = harness(OWNER, { products: [] });
    await service.export({ kind: 'profit-by-product', locale: 'en' });
    const after = audited[0].after as Record<string, unknown>;
    expect(after.event).toBe('report_export_generated');
    expect(after.outcome).toBe('generated');
    expect(JSON.stringify(after)).not.toMatch(/download|shared|emailed/i);
  });

  it('records the manager\'s narrower column list', async () => {
    const { service, audited } = harness(MANAGER, { products: [PRODUCT] });
    await service.export({ kind: 'profit-by-product', locale: 'en' });
    expect((audited[0].after as Record<string, unknown>).columns).not.toContain('grossProfit');
  });

  it('contains no cell of the file itself', async () => {
    const { service, audited } = harness(OWNER, { products: [PRODUCT] });
    await service.export({ kind: 'profit-by-product', locale: 'en' });
    const serialised = JSON.stringify(audited[0]);
    expect(serialised).not.toContain('Samsung A15');
    expect(serialised).not.toContain('45000');
  });

  it('writes nothing when the export is refused', async () => {
    const { service, audited } = harness(new Set(['report.view']));
    await expect(service.export({ kind: 'debtors-creditors', locale: 'en' })).rejects.toThrow();
    expect(audited).toHaveLength(0);
  });
});

describe('an export changes nothing', () => {
  it('touches no service that writes', async () => {
    // Every collaborator is a read. If an export ever needs a write, that is a
    // design change and this test is where the argument has to be had.
    const { service, analytics, dashboard, loans, suppliers, db } = harness(OWNER, { products: [] });
    await service.export({ kind: 'profit-by-product', locale: 'en' });

    for (const collaborator of [analytics, dashboard, loans, suppliers, db.branch]) {
      for (const [name, fn] of Object.entries(collaborator)) {
        if (typeof fn === 'function' && (fn as jest.Mock).mock) {
          expect(name).toMatch(/^(find|list|get|count|.*Performance|.*Comparison|deadStock)/);
        }
      }
    }
  });
});

describe('every kind produces a readable file', () => {
  it.each(REPORT_KINDS)('%s', async (kind) => {
    const { service } = harness(OWNER, {
      products: [PRODUCT],
      employees: [{ name: 'Seller', salesCount: 2, revenue: 100, margin: 20 }],
      branches: [{ name: 'Main', revenue: 100, grossProfit: 20, netProfit: 10 }],
      dead: [{ label: 'Old', trackingType: 'imei', inStock: 1, inventoryValue: 5, lastSoldAt: null }],
      loans: [{ direction: 'they_owe_us', otherParty: 'X', statusText: 'Confirmed', remaining: 1, createdAt: new Date() }],
      suppliers: [{ rows: [{ name: 'S', outstanding: 2 }], nextCursor: null }],
    });
    const { csv, rowCount } = await service.export({ kind, locale: 'en' });
    expect(rowCount).toBeGreaterThan(0);
    const rows = table(csv);
    expect(rows[0].length).toBeGreaterThan(1);
    // Every data row has exactly as many cells as the header.
    for (const row of rows.slice(1)) expect(row).toHaveLength(rows[0].length);
  });

  it('produces a header-only file when there is nothing to report', async () => {
    const { service } = harness(OWNER, { products: [] });
    const { csv, rowCount } = await service.export({ kind: 'profit-by-product', locale: 'en' });
    expect(rowCount).toBe(0);
    expect(table(csv)).toHaveLength(1);
  });
});

describe('the response a browser actually sees', () => {
  /*
   * Found by a real browser download, not by any test here.
   *
   * A browser hides every response header except a short safelist unless the
   * server opts in. `Content-Disposition` is not on that list, so the endpoint
   * answered 200 with the right bytes and the web client read `null` for the
   * filename — every export would have saved as `report.csv`, losing the
   * report, period and branch that the filename is the only place to carry.
   *
   * Read from source because the alternative is booting the whole application
   * to inspect one CORS option. The value is what matters and it is asserted.
   */
  const main = readFileSync('src/main.ts', 'utf8');

  it('exposes the filename header to browsers', () => {
    expect(main).toMatch(/exposedHeaders:\s*\[[^\]]*'Content-Disposition'/);
  });

  it('exposes the row count too', () => {
    expect(main).toMatch(/exposedHeaders:\s*\[[^\]]*'X-Report-Rows'/);
  });
});
