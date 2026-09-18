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

function service(found: unknown, permissions: string[]) {
  const findFirst = jest.fn().mockResolvedValue(found);
  const db = { unit: { findFirst } };
  const tenant = { requireBranchId: () => here };
  const pricing = { getUnitPricing: jest.fn().mockResolvedValue({ price: 30000 }) };
  const cls = { get: () => new Set(permissions) };
  return { svc: new SaleSelectionService(db as never, tenant as never, pricing as never, cls as never), findFirst };
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
    expect(f?.body).toEqual({ code: 'not_available_here', message: 'This phone is not available in this branch.' });
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
    ['', 'imei_missing'],
    ['49015420323751', 'imei_length'],
    ['490154203237519', 'imei_checksum'],
  ])('refuses %p (%s) before any lookup', async (raw, code) => {
    const { svc, findFirst } = service(unitAt(here), ['sale.create', 'branch.manage']);
    const f = await failure(svc.select(raw));
    expect(f?.type).toBe(BadRequestException);
    expect(f?.body.code).toBe(code);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
