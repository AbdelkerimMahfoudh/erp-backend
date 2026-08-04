import { MissingTenantContextError, scopeTenantArgs } from './tenant.extension';

describe('scopeTenantArgs (fail-closed tenant isolation)', () => {
  const companyId = Buffer.alloc(16, 1);

  it('throws when a tenant model has no company context (never runs unscoped)', () => {
    expect(() => scopeTenantArgs('Unit', 'findMany', {}, undefined)).toThrow(
      MissingTenantContextError,
    );
  });

  it('passes global models through untouched, even without context', () => {
    const args = { where: { key: 'sale.create' } };
    expect(scopeTenantArgs('Permission', 'findFirst', args, undefined)).toBe(args);
    expect(scopeTenantArgs('TacCatalog', 'findMany', {}, undefined)).toEqual({});
  });

  it('injects companyId into where for reads', () => {
    const out = scopeTenantArgs('Unit', 'findMany', { where: { status: 'in_stock' } }, companyId);
    expect(out.where).toEqual({ status: 'in_stock', companyId });
  });

  it('injects companyId into where for findUnique (extendedWhereUnique)', () => {
    const out = scopeTenantArgs('Sale', 'findUnique', { where: { id: Buffer.alloc(16) } }, companyId);
    expect((out.where as Record<string, unknown>).companyId).toBe(companyId);
  });

  it('injects companyId into data for create', () => {
    const out = scopeTenantArgs('Unit', 'create', { data: { imeiPrimary: '123' } }, companyId);
    expect(out.data).toEqual({ imeiPrimary: '123', companyId });
  });

  it('injects companyId into every row for createMany', () => {
    const out = scopeTenantArgs('Unit', 'createMany', { data: [{ a: 1 }, { a: 2 }] }, companyId);
    expect(out.data).toEqual([
      { a: 1, companyId },
      { a: 2, companyId },
    ]);
  });

  it('scopes both where and create for upsert', () => {
    const out = scopeTenantArgs(
      'Setting',
      'upsert',
      { where: { id: Buffer.alloc(16) }, create: { key: 'x' }, update: {} },
      companyId,
    );
    expect((out.where as Record<string, unknown>).companyId).toBe(companyId);
    expect((out.create as Record<string, unknown>).companyId).toBe(companyId);
  });
});
