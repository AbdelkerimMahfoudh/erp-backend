import { Prisma, PrismaClient } from '@prisma/client';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { provisionDefaultRoles } from '../rbac/role-provisioning';
import { AccessService } from '../rbac/access.service';
import { RoleChangeService } from './role-change.service';

/**
 * Employee ↔ Manager (D225) on REAL MySQL: what an in-memory world cannot show.
 *  - The change is in force on the person's next request: the permissions AccessService resolves for every request
 *    come from the rows just committed, through the application account. No session keeps the old role.
 *  - A demoted Manager's price-edit grant goes in the same transaction.
 *  - Two changes to one person at once are serialised by the row lock: the second reads what the first committed.
 *
 * Env-gated, and skipped otherwise: ROLE_ROOT_URL (root: fixtures) and ROLE_APP_URL (phonestore_app: the service) to a
 * DISPOSABLE database at 0111 or later. Run in the database gates (`deploy/ci-database-gates.sh`).
 */

const ROOT_URL = process.env.ROLE_ROOT_URL ?? '';
const APP_URL = process.env.ROLE_APP_URL ?? '';
const run = ROOT_URL !== '' && APP_URL !== '' ? describe : describe.skip;

jest.setTimeout(120_000);

let root: PrismaClient;
const apps: PrismaClient[] = [];
let seq = 0;
const tag = () => `${Date.now().toString(36)}${seq++}`.toUpperCase().slice(-10);

async function world() {
  const companyId = newUuidV7Bin();
  const t = tag();
  await root.$executeRaw`INSERT INTO companies (id, name, settings, updated_at, public_store_id) VALUES (${companyId}, ${`Roles ${t}`}, JSON_OBJECT(), NOW(6), ${`RL${t}`})`;
  const { roleIds } = await provisionDefaultRoles(root as never, companyId);
  const store = async (name: string) => {
    const id = newUuidV7Bin();
    await root.branch.create({ data: { id, companyId, name: `${name} ${t}` } });
    return id;
  };
  const a = await store('A');
  const b = await store('B');
  const user = async (name: string) => {
    const id = newUuidV7Bin();
    const u = tag();
    await root.$executeRaw`INSERT INTO users (id, company_id, name, login, personal_id, password_hash, is_active, updated_at)
      VALUES (${id}, ${companyId}, ${name}, ${`rl-${u}`}, ${u.padStart(10, '0')}, 'x', TRUE, NOW(6))`;
    return id;
  };
  const owner = await user('Owner');
  const person = await user('Aminetou');
  const assign = async (userId: Buffer, branchId: Buffer, role: string) => {
    const id = newUuidV7Bin();
    await root.userBranch.create({ data: { id, companyId, userId, branchId, roleId: (roleIds as Record<string, Buffer>)[role] } });
    return id;
  };
  await assign(owner, a, 'owner');
  await assign(owner, b, 'owner');
  return { companyId, a, b, owner, person, assign };
}

function serviceOn(client: PrismaClient, w: Awaited<ReturnType<typeof world>>) {
  const audit = {
    recordTx: (tx: Prisma.TransactionClient, e: { entityType: string; entityId: Buffer; action: string; after?: object; before?: object }) =>
      tx.auditLog.create({ data: { companyId: w.companyId, userId: w.owner, entityType: e.entityType, entityId: e.entityId, action: e.action as never, before: e.before ?? Prisma.JsonNull, after: e.after ?? Prisma.JsonNull } }),
  };
  return new RoleChangeService(
    client as never,
    { companyId: () => w.companyId, requireUserId: () => w.owner } as never,
    audit as never,
    { maySeat: async () => ({ allowed: true, full: [] }) } as never,
  );
}

const app = () => {
  const c = new PrismaClient({ datasources: { db: { url: APP_URL } } });
  apps.push(c);
  return c;
};

run('Employee ↔ Manager on real MySQL', () => {
  beforeAll(async () => {
    root = new PrismaClient({ datasources: { db: { url: ROOT_URL } } });
  });
  afterAll(async () => {
    await Promise.all([root, ...apps].map((c) => c.$disconnect()));
  });

  it('a promotion is in force on the next request: Manager permissions resolve at once, audited in the same transaction', async () => {
    const w = await world();
    await w.assign(w.person, w.a, 'store_employee');
    const client = app();
    const access = new AccessService(client as never);
    const before = await access.getEffectivePermissions(w.person, w.a);
    expect(before.has('goal.manage')).toBe(false);

    await serviceOn(client, w).change(binToUuid(w.person), { role: 'store_manager', branchIds: [binToUuid(w.a)] });

    const after = await access.getEffectivePermissions(w.person, w.a);
    expect(after.has('goal.manage')).toBe(true);
    const audits = await root.auditLog.count({ where: { entityId: w.person, entityType: 'User' } });
    expect(audits).toBe(1);
    const told = await root.notification.findFirst({ where: { targetUserId: w.person, type: 'staff.role_changed' } });
    expect(told?.payload).toMatchObject({ role: 'store_manager' });
  });

  it('a demotion ends Manager permissions and the price-edit grant together', async () => {
    const w = await world();
    const ub = await w.assign(w.person, w.a, 'store_manager');
    const perm = await root.permission.findFirstOrThrow({ where: { key: 'price.edit' }, select: { id: true } });
    await root.userBranchPermission.create({ data: { companyId: w.companyId, userBranchId: ub, permissionId: perm.id, grantedById: w.owner } });
    const client = app();
    const access = new AccessService(client as never);
    expect((await access.getEffectivePermissions(w.person, w.a)).has('price.edit')).toBe(true);

    await serviceOn(client, w).change(binToUuid(w.person), { role: 'store_employee', branchIds: [binToUuid(w.a)] });

    const now = await access.getEffectivePermissions(w.person, w.a);
    expect(now.has('price.edit')).toBe(false);
    expect(now.has('goal.manage')).toBe(false);
    expect(await root.userBranchPermission.count({ where: { userBranchId: ub } })).toBe(0);
  });

  it('two promotions of one person at once: one changes, the other finds it done — never two rows for one store', async () => {
    const w = await world();
    await w.assign(w.person, w.a, 'store_employee');
    const [one, two] = [serviceOn(app(), w), serviceOn(app(), w)];
    const results = await Promise.allSettled([
      one.change(binToUuid(w.person), { role: 'store_manager', branchIds: [binToUuid(w.a), binToUuid(w.b)] }),
      two.change(binToUuid(w.person), { role: 'store_manager', branchIds: [binToUuid(w.a), binToUuid(w.b)] }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason.response).toMatchObject({ code: 'role_unchanged' });
    expect(await root.userBranch.count({ where: { userId: w.person } })).toBe(2);
  });

  it('the Owner is never changed', async () => {
    const w = await world();
    const other = await w.assign(w.person, w.a, 'owner');
    await expect(serviceOn(app(), w).change(binToUuid(w.person), { role: 'store_employee', branchIds: [binToUuid(w.a)] })).rejects.toMatchObject({
      response: { code: 'owner_role_fixed' },
    });
    expect((await root.userBranch.findUniqueOrThrow({ where: { id: other }, select: { roleId: true } })).roleId).toBeTruthy();
  });
});
