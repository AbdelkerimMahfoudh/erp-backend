import { Prisma, PrismaClient } from '@prisma/client';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { provisionDefaultRoles } from '../rbac/role-provisioning';
import { AccessService } from '../rbac/access.service';
import { ActingOwnerService } from './acting-owner.service';

/**
 * The temporary Acting Owner (D225, 0112) on REAL MySQL:
 *  - two appointments sent at once: the business row's lock lets one through, the other is refused as overlapping;
 *  - the authority starts at the scheduled time and ends at the end, read from the rows on each request — nothing
 *    has to run, no phone has to be online;
 *  - a revocation ends it on the very next request;
 *  - the delegate, who holds the Owner's permissions, still cannot appoint anyone or remove the appointment;
 *  - the audit rows are written in the same transaction and the database refuses to change them.
 *
 * Env-gated: ACTING_ROOT_URL (root: fixtures) and ACTING_APP_URL (phonestore_app: the service) on a DISPOSABLE
 * database at 0112 or later. Run in the database gates (`deploy/ci-database-gates.sh`).
 */

const ROOT_URL = process.env.ACTING_ROOT_URL ?? '';
const APP_URL = process.env.ACTING_APP_URL ?? '';
const run = ROOT_URL !== '' && APP_URL !== '' ? describe : describe.skip;

jest.setTimeout(120_000);

let root: PrismaClient;
const apps: PrismaClient[] = [];
let seq = 0;
const tag = () => `${Date.now().toString(36)}${seq++}`.toUpperCase().slice(-10);
const PASSWORD = 'owner-password';
const CODE = { challengeId: '00000000-0000-7000-8000-000000000000', code: '123456' };
const hashing = { verify: async (_h: string, p: string) => p === PASSWORD, verifyDummy: async () => false };

async function world() {
  const companyId = newUuidV7Bin();
  const t = tag();
  await root.$executeRaw`INSERT INTO companies (id, name, settings, updated_at, public_store_id) VALUES (${companyId}, ${`Acting ${t}`}, JSON_OBJECT(), NOW(6), ${`AO${t}`})`;
  const { roleIds } = await provisionDefaultRoles(root as never, companyId);
  const store = newUuidV7Bin();
  await root.branch.create({ data: { id: store, companyId, name: `Store ${t}` } });
  const user = async (name: string, role: string) => {
    const id = newUuidV7Bin();
    const u = tag();
    await root.$executeRaw`INSERT INTO users (id, company_id, name, login, personal_id, password_hash, is_active, updated_at)
      VALUES (${id}, ${companyId}, ${name}, ${`ao-${u}`}, ${u.padStart(10, '0')}, 'x', TRUE, NOW(6))`;
    await root.userBranch.create({ data: { id: newUuidV7Bin(), companyId, userId: id, branchId: store, roleId: (roleIds as Record<string, Buffer>)[role] } });
    return id;
  };
  const owner = await user('Owner', 'owner');
  const manager = await user('Mohamed', 'store_manager');
  const employee = await user('Aminetou', 'store_employee');
  return { companyId, store, owner, manager, employee };
}

const app = () => {
  const c = new PrismaClient({ datasources: { db: { url: APP_URL } } });
  apps.push(c);
  return c;
};

function serviceOn(client: PrismaClient, w: Awaited<ReturnType<typeof world>>, actor: Buffer) {
  const audit = {
    recordTx: (tx: Prisma.TransactionClient, e: { entityType: string; entityId: Buffer; action: string; after?: object; before?: object; reason?: string }) =>
      tx.auditLog.create({ data: { companyId: w.companyId, userId: actor, entityType: e.entityType, entityId: e.entityId, action: e.action as never, before: e.before ?? Prisma.JsonNull, after: e.after ?? Prisma.JsonNull, reason: e.reason ?? null } }),
  };
  // The WhatsApp step-up has its own spec (acting-owner-step-up.spec.ts, on the real OtpService); here it always passes.
  const stepUp = { confirm: async () => '00000000-0000-7000-8000-000000000000' };
  return new ActingOwnerService(client as never, { companyId: () => w.companyId, requireUserId: () => actor } as never, audit as never, hashing as never, stepUp as never);
}

run('the Acting Owner on real MySQL', () => {
  beforeAll(async () => {
    root = new PrismaClient({ datasources: { db: { url: ROOT_URL } } });
  });
  afterAll(async () => {
    await Promise.all([root, ...apps].map((c) => c.$disconnect()));
  });

  it('two appointments at once: one is made, the other is refused as overlapping', async () => {
    const w = await world();
    const results = await Promise.allSettled([
      serviceOn(app(), w, w.owner).appoint({ delegateId: binToUuid(w.manager), currentPassword: PASSWORD, ...CODE }),
      serviceOn(app(), w, w.owner).appoint({ delegateId: binToUuid(w.employee), currentPassword: PASSWORD, ...CODE }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.response).toMatchObject({ code: 'delegation_overlap' });
    expect(await root.actingOwnerDelegation.count({ where: { companyId: w.companyId } })).toBe(1);
  });

  it('starts at its time and ends at its end, with nothing running; a revocation ends it on the next request', async () => {
    const access = new AccessService(app() as never);
    const appointed = async (startsAt: Date, endsAt: Date | null) => {
      const w = await world();
      await root.actingOwnerDelegation.create({ data: { id: newUuidV7Bin(), companyId: w.companyId, delegateUserId: w.employee, grantedByUserId: w.owner, startsAt, endsAt } });
      return (await access.getEffectivePermissions(w.employee, w.store)).has('sale.below_cost');
    };
    const now = Date.now();
    expect(await appointed(new Date(now + 60 * 60_000), null)).toBe(false); // scheduled, not yet
    expect(await appointed(new Date(now - 60_000), new Date(now + 60 * 60_000))).toBe(true); // its start reached
    expect(await appointed(new Date(now - 120_000), new Date(now - 1_000))).toBe(false); // its end passed

    // A fresh appointment, then revoked by the Owner: gone on the next request.
    const w = await world();
    const client = app();
    const made = await serviceOn(client, w, w.owner).appoint({ delegateId: binToUuid(w.employee), currentPassword: PASSWORD, ...CODE });
    expect((await access.getEffectivePermissions(w.employee, w.store)).has('user.manage')).toBe(true);
    await serviceOn(client, w, w.owner).revoke(made.id, { currentPassword: PASSWORD, ...CODE });
    expect((await access.getEffectivePermissions(w.employee, w.store)).has('user.manage')).toBe(false);
  });

  it('an appointment is never deleted or rewritten, even by the application account', async () => {
    const w = await world();
    const made = await serviceOn(app(), w, w.owner).appoint({ delegateId: binToUuid(w.manager), endsAt: new Date(Date.now() + 3_600_000).toISOString(), currentPassword: PASSWORD, ...CODE });
    const client = app();
    const id = Buffer.from(made.id.replace(/-/g, ''), 'hex');
    await expect(client.actingOwnerDelegation.delete({ where: { id } })).rejects.toThrow(/never deleted/);
    await expect(client.actingOwnerDelegation.update({ where: { id }, data: { endsAt: new Date(Date.now() + 90 * 86_400_000) } })).rejects.toThrow(/not changed/);
    await serviceOn(client, w, w.owner).revoke(made.id, { currentPassword: PASSWORD, ...CODE });
    await expect(client.actingOwnerDelegation.update({ where: { id }, data: { revokedAt: new Date() } })).rejects.toThrow(/already revoked/);
  });

  it('the delegate cannot appoint anyone nor remove their own appointment; a wrong password changes nothing', async () => {
    const w = await world();
    const made = await serviceOn(app(), w, w.owner).appoint({ delegateId: binToUuid(w.manager), currentPassword: PASSWORD, ...CODE });
    const asDelegate = serviceOn(app(), w, w.manager);
    await expect(asDelegate.appoint({ delegateId: binToUuid(w.employee), currentPassword: PASSWORD, ...CODE })).rejects.toMatchObject({ response: { code: 'owner_only' } });
    await expect(asDelegate.revoke(made.id, { currentPassword: PASSWORD, ...CODE })).rejects.toMatchObject({ response: { code: 'owner_only' } });
    await expect(serviceOn(app(), w, w.owner).revoke(made.id, { currentPassword: 'wrong', ...CODE })).rejects.toMatchObject({ response: { code: 'password_incorrect' } });
    expect((await root.actingOwnerDelegation.findFirstOrThrow({ where: { companyId: w.companyId } })).revokedAt).toBeNull();
  });

  it('audits the appointment in the same transaction, and the database will not let the audit be edited', async () => {
    const w = await world();
    const made = await serviceOn(app(), w, w.owner).appoint({ delegateId: binToUuid(w.manager), currentPassword: PASSWORD, ...CODE });
    const audit = await root.auditLog.findFirstOrThrow({ where: { entityType: 'ActingOwnerDelegation' , companyId: w.companyId }, select: { id: true, reason: true } });
    expect(audit.reason).toBe('Acting Owner appointed');
    await expect(app().auditLog.update({ where: { id: audit.id }, data: { reason: 'nothing happened' } })).rejects.toThrow();
    const told = await root.notification.findMany({ where: { companyId: w.companyId, type: 'acting_owner.appointed' }, select: { targetUserId: true } });
    expect(told.map((n) => binToUuid(n.targetUserId!)).sort()).toEqual([binToUuid(w.owner), binToUuid(w.manager)].sort());
    expect(made.state).toBe('active');
  });
});
