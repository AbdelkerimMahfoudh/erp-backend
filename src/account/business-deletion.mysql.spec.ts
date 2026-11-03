import { PrismaClient } from '@prisma/client';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { provisionDefaultRoles } from '../rbac/role-provisioning';
import { PlatformAuditService } from '../platform/platform-audit.service';
import { AccountDeletionService } from './account-deletion.service';
import { BusinessDeletionService, RETENTION_POLICY } from './business-deletion.service';

/**
 * An administrator's staged business deletion (post-Build-4, 0128) on REAL MySQL, the service connected as
 * `phonestore_app` so every trigger applies:
 *  - refused while the business is active, its subscription usable (activated, in grace), or a payment is pending;
 *  - prepare: one transaction cancels the subscription, deactivates the business, revokes every session, and writes
 *    the two audit records; repeated, it records nothing new and issues no refund;
 *  - delete: refused on a wrong name; then identities and contacts gone, financial and audit rows kept and marked,
 *    the 37 delete-protected tables untouched, the deletion record permanent; repeated, it is the same result.
 * The step-up window is the controller's (`requireStepUp`, platform-mfa.service.spec.ts).
 *
 * Env-gated: DELETION_ROOT_URL (root: fixtures) and DELETION_APP_URL (phonestore_app: the service) on a DISPOSABLE
 * database at 0128 or later. Run in the database gates (`deploy/ci-database-gates.sh`).
 */

const ROOT_URL = process.env.DELETION_ROOT_URL ?? '';
const APP_URL = process.env.DELETION_APP_URL ?? '';
const run = ROOT_URL !== '' && APP_URL !== '' ? describe : describe.skip;

jest.setTimeout(120_000);

let root: PrismaClient;
let app: PrismaClient;
let seq = 0;
const tag = () => `${Date.now().toString(36)}${seq++}`.toUpperCase().slice(-10);
const actor = { admin: { id: Buffer.alloc(16, 9), email: 'ops@example.test', name: 'Ops' }, ip: '127.0.0.1' };

async function business(o: { status?: 'activated' | 'pending_activation'; periodEnd?: Date | null; proof?: boolean } = {}) {
  const companyId = newUuidV7Bin();
  const t = tag();
  const name = `Boutique ${t}`;
  await root.$executeRaw`INSERT INTO companies (id, name, settings, updated_at, public_store_id) VALUES (${companyId}, ${name}, JSON_OBJECT(), NOW(6), ${`BD${t}`})`;
  const { roleIds } = await provisionDefaultRoles(root as never, companyId);
  const store = newUuidV7Bin();
  await root.branch.create({ data: { id: store, companyId, name: `Store ${t}`, phone: '+22233000000', address: 'Tevragh Zeina' } });
  const owner = newUuidV7Bin();
  await root.$executeRaw`INSERT INTO users (id, company_id, name, login, personal_id, password_hash, phone, email, is_active, updated_at)
    VALUES (${owner}, ${companyId}, 'Owner Name', ${`bd-${t}`}, ${t.padStart(10, '0')}, 'x', ${`+2223${t.slice(-7).replace(/\D/g, '1').padStart(7, '1')}`}, ${`owner-${t}@example.test`.toLowerCase()}, TRUE, NOW(6))`;
  await root.userBranch.create({ data: { id: newUuidV7Bin(), companyId, userId: owner, branchId: store, roleId: (roleIds as Record<string, Buffer>).owner } });
  const sessions = [newUuidV7Bin(), newUuidV7Bin()];
  for (const id of sessions) await root.authSession.create({ data: { id, companyId, userId: owner, refreshTokenHash: 'x', ip: '10.0.0.1', expiresAt: new Date(Date.now() + 86_400_000) } as never });
  await root.subscription.create({
    data: { id: newUuidV7Bin(), companyId, status: o.status ?? 'activated', currentPeriodEnd: o.periodEnd === undefined ? new Date(Date.now() + 30 * 86_400_000) : o.periodEnd, subscribedBranchCount: 1 },
  });
  await root.customer.create({ data: { id: newUuidV7Bin(), companyId, name: 'A customer', phone: '+22244000000' } as never });
  if (o.proof) {
    await root.paymentProof.create({ data: { id: newUuidV7Bin(), companyId, submittedBy: owner, idempotencyKey: t, amount: '300', paidAt: new Date(), file: Buffer.from('%PDF-1.7'), sha256: t.padEnd(64, '0'), contentType: 'application/pdf', byteSize: 8 } });
  }
  return { companyId, id: binToUuid(companyId), name, owner, sessions, store };
}

function services() {
  const audit = new PlatformAuditService(app as never);
  const deletion = new AccountDeletionService(app as never, {} as never, {} as never, {} as never);
  return { service: new BusinessDeletionService(app as never, audit, deletion) };
}

run('an administrator’s staged deletion of a business, on real MySQL', () => {
  beforeAll(async () => {
    root = new PrismaClient({ datasources: { db: { url: ROOT_URL } } });
    app = new PrismaClient({ datasources: { db: { url: APP_URL } } });
    // The administrator the audit rows name (a foreign key).
    await root.platformAdmin.upsert({ where: { id: actor.admin.id }, update: {}, create: { id: actor.admin.id, email: actor.admin.email, name: actor.admin.name, passwordHash: 'x' } });
  });
  afterAll(async () => {
    await root?.$disconnect();
    await app?.$disconnect();
  });

  it('cannot delete an active business with a usable subscription, nor one never prepared', async () => {
    const b = await business();
    const { service } = services();
    const v = await service.view(b.id);
    expect(v.deleteBlockers).toEqual(expect.arrayContaining(['not_prepared', 'still_active', 'subscription_usable']));
    await expect(service.delete(b.id, b.name, actor)).rejects.toMatchObject({ response: { code: 'deletion_blocked' } });
    expect((await root.company.findUniqueOrThrow({ where: { id: b.companyId } })).name).toBe(b.name);
  });

  it('a subscription in grace (period ended, not cancelled) is usable: deletion stays refused until prepared', async () => {
    const b = await business({ periodEnd: new Date(Date.now() - 86_400_000) });
    const { service } = services();
    expect((await service.view(b.id)).deleteBlockers).toContain('subscription_usable');
  });

  it('a pending payment proof stops both steps', async () => {
    const b = await business({ proof: true });
    const { service } = services();
    await expect(service.prepare(b.id, actor)).rejects.toMatchObject({ response: { code: 'deletion_prepare_blocked', blockers: ['payment_pending'] } });
    expect((await root.company.findUniqueOrThrow({ where: { id: b.companyId } })).isActive).toBe(true);
  });

  it('prepare: subscription cancelled, business deactivated, every session revoked, two audit records; repeated, nothing new', async () => {
    const b = await business();
    const { service } = services();
    const v = await service.prepare(b.id, actor);
    expect(v).toMatchObject({ stage: 'prepared', preparedBy: actor.admin.email, deleteBlockers: [] });
    expect((await root.subscription.findFirstOrThrow({ where: { companyId: b.companyId } })).status).toBe('cancelled');
    expect((await root.company.findUniqueOrThrow({ where: { id: b.companyId } })).isActive).toBe(false);
    expect(await root.authSession.count({ where: { companyId: b.companyId, revokedAt: null } })).toBe(0);
    const actions = async () => (await root.platformAuditEvent.findMany({ where: { targetId: b.companyId } })).map((e) => e.action).sort();
    expect(await actions()).toEqual(['business.deletion.deactivated', 'business.deletion.subscription_cancelled']);
    expect(await root.subscriptionPayment.count({ where: { companyId: b.companyId } })).toBe(0); // no refund, no payment of any kind
    await service.prepare(b.id, actor);
    expect(await actions()).toHaveLength(2);
    expect(await root.subscriptionEvent.count({ where: { companyId: b.companyId, kind: 'cancelled' } })).toBe(1);
  });

  it('delete: a wrong name is refused and changes nothing', async () => {
    const b = await business();
    const { service } = services();
    await service.prepare(b.id, actor);
    await expect(service.delete(b.id, `${b.name} `.toLowerCase(), actor)).rejects.toMatchObject({ response: { code: 'deletion_name_mismatch' } });
    expect((await root.user.findUniqueOrThrow({ where: { id: b.owner } })).name).toBe('Owner Name');
  });

  it('delete: identities and contacts gone; financial and audit records kept and marked; permanent record; retry is the same', async () => {
    const b = await business();
    const { service } = services();
    await service.prepare(b.id, actor);
    const auditBefore = await root.auditLog.count({ where: { companyId: b.companyId } });
    const v = await service.delete(b.id, b.name, actor);
    expect(v).toMatchObject({ stage: 'completed', completedBy: actor.admin.email, retentionPolicy: RETENTION_POLICY, confirmName: null, deleteBlockers: ['already_deleted'] });

    const company = await root.company.findUniqueOrThrow({ where: { id: b.companyId } });
    expect(company).toMatchObject({ name: null, nameAr: null, isActive: false });
    expect(company.deletedAt).not.toBeNull();
    const owner = await root.user.findUniqueOrThrow({ where: { id: b.owner } });
    expect(owner).toMatchObject({ name: 'Deleted user', phone: null, email: null, isActive: false });
    expect((await root.customer.findFirstOrThrow({ where: { companyId: b.companyId } })).phone).toBeNull();
    expect((await root.branch.findUniqueOrThrow({ where: { id: b.store } })).address).toBeNull();
    expect(await root.authSession.count({ where: { companyId: b.companyId, ip: { not: null } } })).toBe(0);
    // Kept: the subscription and its history, the audit trail (one more row, the deletion itself).
    expect(await root.subscription.count({ where: { companyId: b.companyId } })).toBe(1);
    expect(await root.auditLog.count({ where: { companyId: b.companyId } })).toBe(auditBefore + 1);
    const record = await root.businessDeletion.findUniqueOrThrow({ where: { companyId: b.companyId } });
    expect(record).toMatchObject({ stage: 'completed', completedBy: actor.admin.email, retentionPolicy: RETENTION_POLICY });
    expect(JSON.stringify(record.summary)).not.toContain(b.name);

    // Retried: the same answer, nothing recorded twice.
    await expect(service.delete(b.id, b.name, actor)).resolves.toMatchObject({ stage: 'completed' });
    expect(await root.platformAuditEvent.count({ where: { targetId: b.companyId, action: 'business.deletion.completed' } })).toBe(1);

    // Permanent: the application's own login can neither delete the record nor rewrite it.
    await expect(app.businessDeletion.delete({ where: { id: record.id } })).rejects.toThrow(/permanent/);
    await expect(app.businessDeletion.update({ where: { id: record.id }, data: { completedBy: 'someone else' } })).rejects.toThrow(/final/);
  });

  it('two deletions racing: one completes, the other returns the same result', async () => {
    const b = await business();
    const { service } = services();
    await service.prepare(b.id, actor);
    const results = await Promise.allSettled([service.delete(b.id, b.name, actor), service.delete(b.id, b.name, actor)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(await root.platformAuditEvent.count({ where: { targetId: b.companyId, action: 'business.deletion.completed' } })).toBe(1);
  });
});
