import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scopeTenantArgs, MissingTenantContextError } from './tenant.extension';

/**
 * Every model is either a tenant's or accounted for (docs/48 control 4).
 *
 * The tenant extension scopes every model by `companyId` and fails closed
 * for the rest — a model with no `companyId` can only be reached through the
 * unscoped client, on purpose, by code that filters it itself. That list must
 * be a decision, not an accident: a new model without a company column that
 * nobody classified is a drift failure here, before it is a leak in a shop.
 */

const schema = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((m) => ({ name: m[1], body: m[2] }));
const hasCompany = (body: string) => /^\s+companyId\s+Bytes\b/m.test(body);

/** Reference data shared by every shop: read by anyone, written by nobody at runtime. */
const GLOBAL_REFERENCE = ['Permission', 'TacCatalog', 'DeviceBrand', 'DeviceModel', 'PlanVersion'];

/** The platform realm (docs/15 §4): no company at all, reached only by platform code on the unscoped client. */
const PLATFORM_REALM = ['PlatformAdmin', 'PlatformAdminSession', 'PlatformAuditEvent', 'ContactVerification'];

/**
 * Records that BELONG to a company but are keyed differently: the company row
 * itself, and the inter-store records that name a source and a destination
 * company. Each is read through the unscoped client with both sides checked
 * explicitly (`consignment/*`, `stores/*`).
 */
const TWO_SIDED_OR_SELF = ['Company', 'StoreConnection', 'Consignment', 'ConsignmentLine', 'ConsignmentLedgerEntry'];

/** A registration attempt is created before its company exists; the column is nullable for that instant only. */
const NULLABLE_COMPANY = ['RegistrationAttempt'];

describe('tenant scoping covers every model', () => {
  it('names every model without a company column, and nothing else', () => {
    const without = models.filter((m) => !hasCompany(m.body)).map((m) => m.name).sort();
    const accounted = [...GLOBAL_REFERENCE, ...PLATFORM_REALM, ...TWO_SIDED_OR_SELF].sort();
    expect(without).toEqual(accounted);
  });

  it('keeps the nullable-company list to the one registration instant', () => {
    const nullable = models.filter((m) => /^\s+companyId\s+Bytes\?/m.test(m.body)).map((m) => m.name);
    expect(nullable).toEqual(NULLABLE_COMPANY);
  });

  it('the extension scopes a tenant model and refuses to run it without a company', () => {
    const companyId = Buffer.alloc(16, 1);
    for (const model of models.filter((m) => hasCompany(m.body)).slice(0, 12)) {
      const scoped = scopeTenantArgs(model.name, 'findMany', { where: { id: Buffer.alloc(16, 2) } }, companyId);
      expect((scoped as unknown as { where: { companyId: Buffer } }).where.companyId).toBe(companyId);
      expect(() => scopeTenantArgs(model.name, 'findMany', {}, undefined)).toThrow(MissingTenantContextError);
    }
  });

  it('and injects the company on every write shape', () => {
    const companyId = Buffer.alloc(16, 3);
    expect(scopeTenantArgs('Sale', 'create', { data: { total: 1 } }, companyId)).toEqual({ data: { total: 1, companyId } });
    expect(scopeTenantArgs('Sale', 'createMany', { data: [{ a: 1 }, { a: 2 }] }, companyId)).toEqual({
      data: [{ a: 1, companyId }, { a: 2, companyId }],
    });
    expect(scopeTenantArgs('Sale', 'upsert', { where: { id: 1 }, create: { a: 1 }, update: {} }, companyId)).toEqual({
      where: { id: 1, companyId },
      create: { a: 1, companyId },
      update: {},
    });
    expect(scopeTenantArgs('Sale', 'deleteMany', { where: {} }, companyId)).toEqual({ where: { companyId } });
  });

  it('a model nobody has classified is scoped, never global — the safe default', () => {
    const companyId = Buffer.alloc(16, 4);
    expect(() => scopeTenantArgs('SomeFutureModel', 'findMany', {}, undefined)).toThrow(MissingTenantContextError);
    expect(scopeTenantArgs('SomeFutureModel', 'findMany', {}, companyId)).toEqual({ where: { companyId } });
  });
});
