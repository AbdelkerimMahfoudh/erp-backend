import { BadRequestException, NotFoundException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SaleSelectionService } from './sale-selection.service';
import { branchDisclosure } from './sale-selection-rules';

/** Another branch's stock is disclosed only to a caller with `branch.manage`. */

const here = Buffer.from('aa', 'hex');
const there = Buffer.from('bb', 'hex');
const IMEI = '490154203237518';

function unitAt(branchId: Buffer, status = 'in_stock') {
  return {
    id: Buffer.alloc(16, 1),
    status,
    branchId,
    branch: { name: 'Tevragh Zeina' },
    cost: 100,
    dateIn: new Date('2026-09-01'),
    imeiPrimary: IMEI,
    imeiSecondary: null,
    serialNo: null,
    product: { brand: 'Apple', model: 'iPhone 15', variant: '128 GB · Black', specifications: null, trackingType: 'imei' },
  };
}

function service(
  found: unknown,
  permissions: string[],
  extra: { product?: unknown; stock?: unknown } = {},
) {
  const findFirst = jest.fn().mockResolvedValue(found);
  const productFindFirst = jest.fn().mockResolvedValue(extra.product ?? null);
  const stockFindFirst = jest.fn().mockResolvedValue(extra.stock ?? null);
  const db = {
    unit: { findFirst },
    // The barcode fallback, exercised only when no unit matches.
    product: { findFirst: productFindFirst },
    stockItem: { findFirst: stockFindFirst },
  };
  const tenant = { requireBranchId: () => here };
  const pricing = {
    getUnitPricing: jest.fn().mockResolvedValue({ price: 30000 }),
    getProductPricing: jest.fn().mockResolvedValue({ price: 25000 }),
  };
  const cls = { get: () => new Set(permissions) };
  return {
    svc: new SaleSelectionService(db as never, tenant as never, pricing as never, cls as never),
    findFirst,
    productFindFirst,
    stockFindFirst,
  };
}

async function failure(p: Promise<unknown>) {
  try {
    await p;
    return null;
  } catch (e) {
    return { type: (e as Error).constructor, body: (e as NotFoundException).getResponse() as { code: string; message: string } };
  }
}

describe('branchDisclosure', () => {
  it('here is always here', () => {
    expect(branchDisclosure(here, here, false)).toBe('here');
    expect(branchDisclosure(here, here, true)).toBe('here');
  });
  it('elsewhere is shown only with branch.manage', () => {
    expect(branchDisclosure(there, here, true)).toBe('shown');
    expect(branchDisclosure(there, here, false)).toBe('hidden');
  });
});

describe('without branch.manage', () => {
  it('a phone in stock at another branch is only "not available in this branch"', async () => {
    const { svc } = service(unitAt(there), ['sale.create']);
    const f = await failure(svc.select(IMEI));
    expect(f?.type).toBe(NotFoundException);
    expect(f?.body).toEqual({ code: 'not_available_here', message: 'This item is not available in this branch.' });
    expect(JSON.stringify(f?.body)).not.toMatch(/Tevragh|iPhone|in_stock/);
  });
  it('a phone sold at another branch gets the same answer', async () => {
    const { svc } = service(unitAt(there, 'sold'), ['sale.create']);
    expect((await failure(svc.select(IMEI)))?.body.code).toBe('not_available_here');
  });
  it('an unknown IMEI is indistinguishable from another branch', async () => {
    const { svc } = service(null, ['sale.create']);
    const unknown = await failure(svc.select(IMEI));
    const elsewhere = await failure(service(unitAt(there), ['sale.create']).svc.select(IMEI));
    expect(unknown).toEqual(elsewhere);
  });
  it('a phone here is still fully answered, with no branch disclosed', async () => {
    const r = await service(unitAt(here), ['sale.create']).svc.select(IMEI);
    expect(r.availability).toBe('available');
    expect(r.otherBranch).toBeNull();
    expect(r.identifierMasked).toBe('•••• 7518');
  });
});

describe('a serial number with punctuation', () => {
  it('is looked up whole, so a dashed serial finds its unit', async () => {
    // The live defect: CAN-1662030-0019 was stripped to CAN16620300019 before
    // the lookup, and no unit carries that. The serial is kept as written.
    const SERIAL = 'CAN-1662030-0019';
    const found = { ...unitAt(here), imeiPrimary: null, serialNo: SERIAL, product: { ...unitAt(here).product, trackingType: 'serial' } };
    const { svc, findFirst } = service(found, ['sale.create']);
    const r = await svc.select(SERIAL);
    expect(r.kind).toBe('unit');
    expect(r.matchedBy).toBe('serial');
    const where = findFirst.mock.calls[0][0].where;
    expect(JSON.stringify(where)).toContain(SERIAL);
    expect(JSON.stringify(where)).not.toContain('CAN16620300019');
  });
});

describe('with branch.manage', () => {
  const perms = ['sale.create', 'branch.manage'];
  it('says the phone is at another branch, and which, with no price', async () => {
    const r = await service(unitAt(there), perms).svc.select(IMEI);
    expect(r.availability).toBe('other_branch');
    expect(r.otherBranch).toEqual({ name: 'Tevragh Zeina' });
    expect(r.price).toBeNull();
    expect(JSON.stringify(r)).not.toMatch(/branchId/);
  });
  it('an unknown IMEI is plainly not found', async () => {
    expect((await failure(service(null, perms).svc.select(IMEI)))?.body.code).toBe('not_found');
  });
});

describe('company isolation and malformed input', () => {
  it("another company's phone is invisible: the tenant client finds nothing, and the answer is generic", async () => {
    // TENANT_PRISMA scopes every query to the caller's company, so a phone in
    // another company arrives here as null.
    const { svc, findFirst } = service(null, ['sale.create']);
    expect((await failure(svc.select(IMEI)))?.body.code).toBe('not_available_here');
    expect(findFirst).toHaveBeenCalledTimes(1);
    const src = readFileSync(join(__dirname, 'sale-selection.service.ts'), 'utf8');
    expect(src).toContain('@Inject(TENANT_PRISMA) private readonly db: TenantPrisma');
  });
  it.each([
    ['', 'identifier_missing'],
    // A fifteen-digit number with a bad checksum is an INVALID IMEI, said so —
    // never quietly reinterpreted as a barcode.
    ['490154203237519', 'imei_checksum'],
  ])('refuses %p (%s) before any lookup', async (raw, code) => {
    const { svc, findFirst } = service(unitAt(here), ['sale.create', 'branch.manage']);
    const f = await failure(svc.select(raw));
    expect(f?.type).toBe(BadRequestException);
    expect(f?.body.code).toBe(code);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('a non-IMEI code (a serial or barcode) is allowed through to the lookup, never guessed at', async () => {
    // 14 digits used to be refused as a short IMEI; now it may be a barcode, so
    // the lookup runs and decides. Nothing found → the generic not-here answer.
    const { svc, findFirst } = service(null, ['sale.create']);
    expect((await failure(svc.select('49015420323751')))?.body.code).toBe('not_available_here');
    expect(findFirst).toHaveBeenCalledTimes(1);
  });
});

describe('a barcode finds a counted product to sell', () => {
  const CABLE = {
    id: Buffer.alloc(16, 9),
    brand: 'Anker',
    model: 'USB-C Cable',
    variant: '1m',
    specifications: null,
    trackingType: 'quantity',
  };

  it('returns a product selection with the branch stock available, and no unit or cost', async () => {
    const { svc } = service(null, ['sale.create'], {
      product: CABLE,
      stock: { quantity: 10, reservedQuantity: 3 },
    });
    const r = (await svc.select('6901234567890')) as Record<string, unknown>;
    expect(r.kind).toBe('product');
    expect(r.unitId).toBeNull();
    expect(r.availability).toBe('available');
    expect(r.matchedBy).toBe('barcode');
    expect(r.identifierMasked).toBe('6901234567890'); // a barcode is shown whole, not masked
    expect(r.quantityAvailable).toBe(7); // owned minus reserved
    expect(r.price).toBe(25000);
    expect('cost' in r).toBe(false); // a counted product has no single per-unit cost
  });

  it('is unavailable when nothing is sellable at the branch, and quotes no price', async () => {
    const { svc } = service(null, ['sale.create'], {
      product: CABLE,
      stock: { quantity: 3, reservedQuantity: 3 },
    });
    const r = (await svc.select('6901234567890')) as Record<string, unknown>;
    expect(r.availability).toBe('unavailable');
    expect(r.quantityAvailable).toBe(0);
    expect(r.price).toBeNull();
  });

  it('does not sell a SERIALIZED product by its box barcode — that needs the unit', async () => {
    const { svc } = service(null, ['sale.create'], {
      product: { ...CABLE, trackingType: 'imei' },
    });
    // Falls through to the generic not-found answer; a specific unit is required.
    expect((await failure(svc.select('6901234567890')))?.body.code).toBe('not_available_here');
  });
});
