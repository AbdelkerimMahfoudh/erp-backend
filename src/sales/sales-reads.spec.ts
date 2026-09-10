import { NotFoundException } from '@nestjs/common';
import { SalesService } from './sales.service';
import { ListSalesDto } from './dto/list-sales.dto';
import { newUuidV7Bin, binToUuid } from '../common/utils/uuid.util';

/**
 * The secure sales reads (I1-CP3).
 *
 * Before this, `GET /sales` required no permission and fell back to `{}` when
 * no branch header was present — so any signed-in user could read every sale in
 * the company, cost and margin included, by sending no header at all. It then
 * returned raw rows with `take: 100`, which silently amputates the history of
 * any shop past its first weeks.
 *
 * The permission itself is enforced by `PermissionsGuard` and asserted in
 * `sales-read-authorization.spec.ts`. What matters HERE is the query that
 * reaches the database, because that is where the remaining two dangers live:
 * a filter applied in the app instead of in SQL, and a branch that is not in
 * the `where`. So the double records the arguments rather than pretending to be
 * a database.
 */

const BRANCH = newUuidV7Bin();
const OTHER_BRANCH = newUuidV7Bin();

interface Recorded {
  findMany: Record<string, any>[];
  findUnique: Record<string, any>[];
}

function makeService(opts: {
  rows?: any[];
  unique?: any | null;
  branchId?: Buffer | undefined;
}): { service: SalesService; recorded: Recorded } {
  const recorded: Recorded = { findMany: [], findUnique: [] };
  const db = {
    sale: {
      findMany: (args: Record<string, any>) => {
        recorded.findMany.push(args);
        return Promise.resolve(opts.rows ?? []);
      },
      findUnique: (args: Record<string, any>) => {
        recorded.findUnique.push(args);
        return Promise.resolve(opts.unique ?? null);
      },
    },
  };
  const branchId = 'branchId' in opts ? opts.branchId : BRANCH;
  const tenant = {
    companyId: () => newUuidV7Bin(),
    branchId: () => branchId,
    requireBranchId: () => {
      if (!branchId) throw new Error('X-Branch-Id header is required for this operation');
      return branchId;
    },
    userId: () => newUuidV7Bin(),
  };
  const service = new SalesService(
    db as never,
    tenant as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    // A2: the approvals service. These read tests never sell below the floor.
    { consume: async () => null } as never,
  );
  return { service, recorded };
}

/** A row shaped like what `list()` selects, with sensible defaults. */
function saleRow(over: Record<string, any> = {}) {
  return {
    id: newUuidV7Bin(),
    invoiceNo: '00007',
    soldAt: new Date('2026-08-03T04:02:36.987Z'),
    total: 1000,
    totalCost: 700,
    margin: 300,
    amountPaid: 1000,
    balanceDue: 0,
    payStatus: 'paid',
    isReversed: false,
    returnWindowHours: 0,
    returnDeadlineAt: null,
    user: { name: 'Amina' },
    customer: null,
    payments: [{ method: 'cash' }],
    items: [{ unitId: newUuidV7Bin(), quantity: 1, voided: false }],
    returns: [],
    ...over,
  };
}

const query = (over: Partial<ListSalesDto> = {}): ListSalesDto => over as ListSalesDto;

describe('the list is scoped to the active branch, in SQL', () => {
  it('always puts the branch in the where clause', async () => {
    const { service, recorded } = makeService({});
    await service.list(query());
    expect(recorded.findMany[0].where.branchId).toBe(BRANCH);
  });

  /**
   * The old code used `branchId ? { branchId } : {}` — an empty filter when the
   * header was missing, which is the whole company. The permission is
   * branch-scoped so the guard refuses first, but the service must not be the
   * thing standing between a missing header and every sale in the company.
   */
  it('refuses to run at all without an active branch, rather than listing everything', async () => {
    const { service, recorded } = makeService({ branchId: undefined });
    await expect(service.list(query())).rejects.toThrow(/X-Branch-Id/);
    expect(recorded.findMany).toHaveLength(0);
  });
});

describe('every filter is applied by the database', () => {
  it('searches the invoice, the identifiers, the product and who sold it', async () => {
    const { service, recorded } = makeService({});
    await service.list(query({ search: '356938035643809' }));
    const or = recorded.findMany[0].where.OR;
    const asJson = JSON.stringify(or);

    // The point is coverage of what a person actually remembers, and that all
    // of it is a database condition rather than a filter over a loaded page.
    expect(asJson).toContain('invoiceNo');
    expect(asJson).toContain('imeiPrimary');
    expect(asJson).toContain('imeiSecondary');
    expect(asJson).toContain('serialNo');
    expect(asJson).toContain('barcode');
    expect(asJson).toContain('brand');
    expect(asJson).toContain('model');
    expect(asJson).toContain('variant');
    // Who sold it, and who bought it.
    expect(asJson).toContain('user');
    expect(asJson).toContain('customer');
    expect(or.every((c: unknown) => JSON.stringify(c).includes('356938035643809'))).toBe(true);
  });

  it('omits the search condition entirely for blank input', async () => {
    const { service, recorded } = makeService({});
    await service.list(query({ search: '   ' }));
    expect(recorded.findMany[0].where.OR).toBeUndefined();
  });

  it('filters pay status and payment method in the query', async () => {
    const { service, recorded } = makeService({});
    await service.list(query({ payStatus: 'partial,credit', paymentMethod: 'card' }));
    const where = recorded.findMany[0].where;
    expect(where.payStatus).toEqual({ in: ['partial', 'credit'] });
    expect(where.payments).toEqual({ some: { method: { in: ['card'] } } });
  });

  it('rejects an unknown status or method instead of ignoring it', async () => {
    const { service } = makeService({});
    await expect(service.list(query({ payStatus: 'pade' }))).rejects.toThrow(/Unknown payment status/);
    await expect(service.list(query({ paymentMethod: 'cheque' }))).rejects.toThrow(/Unknown payment method/);
  });

  it('turns a date range into a soldAt filter covering whole days', async () => {
    const { service, recorded } = makeService({});
    await service.list(query({ from: '2026-08-03', to: '2026-08-03' }));
    expect(recorded.findMany[0].where.soldAt).toEqual({
      gte: new Date('2026-08-03T00:00:00.000Z'),
      lt: new Date('2026-08-04T00:00:00.000Z'),
    });
  });
});

describe('paging cannot skip or repeat a sale', () => {
  it('asks for one more row than the page, and reports a cursor only when there is more', async () => {
    const rows = Array.from({ length: 4 }, () => saleRow());
    const { service, recorded } = makeService({ rows });
    const page = await service.list(query({ limit: 3 }));

    expect(recorded.findMany[0].take).toBe(4);
    expect(page.rows).toHaveLength(3);
    expect(page.nextCursor).toBe(binToUuid(rows[2]!.id));
  });

  it('reports no cursor on the last page', async () => {
    const { service } = makeService({ rows: [saleRow(), saleRow()] });
    expect((await service.list(query({ limit: 3 }))).nextCursor).toBeNull();
  });

  /**
   * Keyset, not skip/take: the primary key is a UUIDv7, so `id desc` is both
   * "newest first" and a total order, and a sale completed mid-scroll cannot
   * shift the page under the reader.
   */
  it('pages by the primary key, skipping the cursor row itself', async () => {
    const cursor = binToUuid(newUuidV7Bin());
    const { service, recorded } = makeService({});
    await service.list(query({ cursor }));
    expect(recorded.findMany[0].orderBy).toEqual({ id: 'desc' });
    expect(recorded.findMany[0].skip).toBe(1);
    expect(recorded.findMany[0].cursor).toBeDefined();
  });

  it('clamps the page size, so no caller can ask for the whole history at once', async () => {
    const { service, recorded } = makeService({});
    await service.list(query({ limit: 5000 }));
    await service.list(query({ limit: -3 }));
    await service.list(query());
    expect(recorded.findMany.map((a) => a.take)).toEqual([51, 2, 21]);
  });
});

describe('what a row says', () => {
  it('counts lines and things separately', async () => {
    const rows = [
      saleRow({
        items: [
          { unitId: newUuidV7Bin(), quantity: 1, voided: false },
          { unitId: null, quantity: 10, voided: false },
        ],
      }),
    ];
    const { service } = makeService({ rows });
    const row = (await service.list(query())).rows[0]!;
    // One phone and a box of ten cables is 2 lines and 11 things. A list that
    // said "2 items" would misdescribe what left the shop.
    expect(row.lineCount).toBe(2);
    expect(row.itemCount).toBe(11);
    expect(row.serializedCount).toBe(1);
  });

  it('ignores voided lines in those counts', async () => {
    const rows = [
      saleRow({
        items: [
          { unitId: newUuidV7Bin(), quantity: 1, voided: false },
          { unitId: newUuidV7Bin(), quantity: 1, voided: true },
        ],
      }),
    ];
    const { service } = makeService({ rows });
    expect((await service.list(query())).rows[0]!.lineCount).toBe(1);
  });

  it('lists each payment method once', async () => {
    const rows = [saleRow({ payments: [{ method: 'cash' }, { method: 'cash' }, { method: 'card' }] })];
    const { service } = makeService({ rows });
    expect((await service.list(query())).rows[0]!.paymentMethods).toEqual(['cash', 'card']);
  });

  /**
   * Cost and margin are NOT stripped here. They are named exactly as
   * `FINANCIAL_FIELDS` expects so the global cost-gating interceptor removes
   * them for a caller without `cost.view`. Re-implementing that strip in the
   * service would be a second place to keep in step with the first.
   */
  it('names the financial fields the way the global gating expects', async () => {
    const { service } = makeService({ rows: [saleRow()] });
    const row = (await service.list(query())).rows[0]! as Record<string, unknown>;
    expect(Object.keys(row)).toEqual(expect.arrayContaining(['totalCost', 'margin']));
  });
});

describe('the return policy each sale carries', () => {
  it('reports "no policy" — not "expired" — for a sale sold without one', async () => {
    const { service } = makeService({ rows: [saleRow({ returnWindowHours: 0, returnDeadlineAt: null })] });
    const policy = (await service.list(query())).rows[0]!.returnPolicy;
    expect(policy).toMatchObject({ windowHours: 0, deadlineAt: null, eligible: false, reason: 'no_return_policy' });
  });

  it('is open while the snapshotted deadline is in the future', async () => {
    const deadline = new Date(Date.now() + 3_600_000);
    const { service } = makeService({
      rows: [saleRow({ returnWindowHours: 24, returnDeadlineAt: deadline })],
    });
    const policy = (await service.list(query())).rows[0]!.returnPolicy;
    expect(policy.eligible).toBe(true);
    expect(policy.reason).toBe('within_window');
    expect(policy.deadlineAt).toEqual(deadline);
  });

  it('is closed once that deadline has passed', async () => {
    const { service } = makeService({
      rows: [saleRow({ returnWindowHours: 24, returnDeadlineAt: new Date(Date.now() - 1000) })],
    });
    const policy = (await service.list(query())).rows[0]!.returnPolicy;
    expect(policy.reason).toBe('window_expired');
    expect(policy.requiresOwnerException).toBe(true);
  });

  it('says an accessory-only sale is not supported yet, rather than refusing vaguely', async () => {
    const { service } = makeService({
      rows: [
        saleRow({
          returnWindowHours: 24,
          returnDeadlineAt: new Date(Date.now() + 3_600_000),
          items: [{ unitId: null, quantity: 3, voided: false }],
        }),
      ],
    });
    expect((await service.list(query())).rows[0]!.returnPolicy.reason).toBe('quantity_not_supported');
  });

  it('reports a reversed sale as settled', async () => {
    const { service } = makeService({
      rows: [saleRow({ isReversed: true, returnWindowHours: 24, returnDeadlineAt: new Date(Date.now() + 3_600_000) })],
    });
    expect((await service.list(query())).rows[0]!.returnPolicy.reason).toBe('sale_reversed');
  });
});

describe('the detail read fails closed, and identically', () => {
  const id = binToUuid(newUuidV7Bin());

  const detailRow = (over: Record<string, any> = {}) => ({
    id: newUuidV7Bin(),
    invoiceNo: '00007',
    soldAt: new Date('2026-08-03T04:02:36.987Z'),
    branchId: BRANCH,
    branch: { id: BRANCH, name: 'Main' },
    user: { name: 'Amina' },
    customer: null,
    subtotal: 1000,
    discount: 0,
    taxTotal: 0,
    total: 1000,
    totalCost: 700,
    margin: 300,
    amountPaid: 1000,
    balanceDue: 0,
    payStatus: 'paid',
    dueDate: null,
    isReversed: false,
    returnWindowHours: 0,
    returnDeadlineAt: null,
    returnPolicyOverriddenBy: null,
    returnPolicyOverrideReason: null,
    items: [],
    payments: [],
    returns: [],
    ...over,
  });

  it('answers the same 404 for an unknown sale and for another branch’s sale', async () => {
    const unknown = makeService({ unique: null });
    const otherBranch = makeService({ unique: detailRow({ branchId: OTHER_BRANCH }) });

    const a = await unknown.service.getById(id).catch((e) => e);
    const b = await otherBranch.service.getById(id).catch((e) => e);

    expect(a).toBeInstanceOf(NotFoundException);
    expect(b).toBeInstanceOf(NotFoundException);
    // Identical, deliberately: a different message would confirm that an
    // invoice exists somewhere else in the company.
    expect(a.message).toBe(b.message);
  });

  /**
   * A FOURTH way in, and the one the test suite missed entirely: `uuidToBin`
   * throws a plain Error on anything that is not a UUID, which Nest turns into
   * a 500. Live verification found it — 62 suites had not.
   *
   * A 500 here is not merely untidy. It tells the caller "that id was
   * structurally invalid" where a real-but-not-yours id says 404, and that
   * difference is exactly the signal the identical-404 rule exists to withhold.
   */
  it('answers the same 404 for a malformed id, never a 500', async () => {
    const { service, recorded } = makeService({ unique: detailRow() });
    const unknown = makeService({ unique: null });

    for (const bad of ['not-a-uuid', '', '123', '019fc5c9-0000-7000-8000', "'; DROP TABLE sales;--"]) {
      const e = await service.getById(bad).catch((err) => err);
      expect(e).toBeInstanceOf(NotFoundException);
      expect(e.message).toBe((await unknown.service.getById(id).catch((err) => err)).message);
    }
    // And it never reaches the database at all.
    expect(recorded.findUnique).toHaveLength(0);
  });

  /**
   * Cross-company is handled one layer down: the tenant extension injects
   * `companyId` into the unique lookup, so another company's sale is simply not
   * found. What this asserts is that the service does not defeat that by
   * looking the sale up some other way.
   */
  it('looks the sale up by primary key, leaving company scoping to the tenant extension', async () => {
    const { service, recorded } = makeService({ unique: detailRow() });
    await service.getById(id);
    expect(Object.keys(recorded.findUnique[0].where)).toEqual(['id']);
    expect(recorded.findMany).toHaveLength(0);
  });

  it('returns the lines, the identifiers and the payments', async () => {
    const unitId = newUuidV7Bin();
    const { service } = makeService({
      unique: detailRow({
        items: [
          {
            id: newUuidV7Bin(),
            unitId,
            quantity: 1,
            price: 1000,
            discount: 0,
            taxAmount: 0,
            cost: 700,
            voided: false,
            unit: {
              id: unitId,
              imeiPrimary: '356938035643809',
              imeiSecondary: null,
              serialNo: null,
              product: { brand: 'Samsung', model: 'A15', variant: '128GB', trackingType: 'imei' },
            },
            product: null,
          },
        ],
        payments: [{ id: newUuidV7Bin(), method: 'cash', amount: 1000, paidAt: new Date() }],
      }),
    });

    const sale = await service.getById(id);
    expect(sale.lines[0]).toMatchObject({
      imei: '356938035643809',
      product: 'Samsung A15 128GB',
      quantity: 1,
      cost: 700,
      trackingType: 'imei',
    });
    expect(sale.payments[0]).toMatchObject({ method: 'cash', amount: 1000 });
  });

  it('shows who changed the policy and why, when somebody did', async () => {
    const { service } = makeService({
      unique: detailRow({
        returnWindowHours: 72,
        returnDeadlineAt: new Date(Date.now() + 3_600_000),
        returnPolicyOverriddenBy: { name: 'Yusuf' },
        returnPolicyOverrideReason: 'regular customer travelling',
        items: [{ id: newUuidV7Bin(), unitId: newUuidV7Bin(), quantity: 1, price: 1, discount: 0, taxAmount: 0, cost: 1, voided: false, unit: null, product: null }],
      }),
    });
    const sale = await service.getById(id);
    expect(sale.returnPolicy).toMatchObject({
      windowHours: 72,
      overriddenBy: 'Yusuf',
      overrideReason: 'regular customer travelling',
      eligible: true,
    });
  });

  it('reports an already-returned sale as such', async () => {
    const { service } = makeService({
      unique: detailRow({
        returnWindowHours: 24,
        returnDeadlineAt: new Date(Date.now() + 3_600_000),
        returns: [{ id: newUuidV7Bin() }],
        items: [{ id: newUuidV7Bin(), unitId: newUuidV7Bin(), quantity: 1, price: 1, discount: 0, taxAmount: 0, cost: 1, voided: false, unit: null, product: null }],
      }),
    });
    expect((await service.getById(id)).returnPolicy.reason).toBe('already_returned');
  });
});
