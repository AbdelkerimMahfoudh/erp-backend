import { PrismaClient } from '@prisma/client';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import { provisionDefaultRoles } from '../rbac/role-provisioning';
import { NotificationsService } from './notifications.service';
import { PushDevicesService } from './push-devices.service';
import { PushDispatcher, type PushMessage, type PushProvider } from './push-dispatcher';

/**
 * Notifications (D225, 0113) on REAL MySQL:
 *  - a dispatch retried — or run twice at once — pushes each device once: the UNIQUE delivery row decides;
 *  - a store's broadcast reaches only that store's members; nobody else's phone is touched;
 *  - read state is per person: one member reading a store broadcast leaves it unread for the others;
 *  - the level holds: an Approvals-only member is not pushed an Important event, an All-activity member is;
 *  - the actor is never pushed their own action;
 *  - a phone that changes hands, even to another business, moves to the newcomer and is pushed only their events.
 *
 * Env-gated: NOTIFY_ROOT_URL (root: fixtures) and NOTIFY_APP_URL (phonestore_app: the services) on a DISPOSABLE
 * database at 0113 or later. Run in the database gates (`deploy/ci-database-gates.sh`).
 */

const ROOT_URL = process.env.NOTIFY_ROOT_URL ?? '';
const APP_URL = process.env.NOTIFY_APP_URL ?? '';
const run = ROOT_URL !== '' && APP_URL !== '' ? describe : describe.skip;

jest.setTimeout(120_000);

let root: PrismaClient;
const apps: PrismaClient[] = [];
let seq = 0;
const tag = () => `${Date.now().toString(36)}${seq++}`.toUpperCase().slice(-10);
const app = () => {
  const c = new PrismaClient({ datasources: { db: { url: APP_URL } } });
  apps.push(c);
  return c;
};

class RecordingProvider implements PushProvider {
  sent: PushMessage[] = [];
  async send(messages: readonly PushMessage[]) {
    // Slow enough that two dispatches overlap.
    await new Promise((r) => setTimeout(r, 50));
    this.sent.push(...messages);
    return messages.map(() => ({ ok: true as const }));
  }
}

async function world() {
  const companyId = newUuidV7Bin();
  const t = tag();
  await root.$executeRaw`INSERT INTO companies (id, name, settings, updated_at, public_store_id) VALUES (${companyId}, ${`Notify ${t}`}, JSON_OBJECT(), NOW(6), ${`NT${t}`})`;
  const { roleIds } = await provisionDefaultRoles(root as never, companyId);
  const store = async (name: string) => {
    const id = newUuidV7Bin();
    await root.branch.create({ data: { id, companyId, name: `${name} ${t}`, nameAr: 'المتجر' } });
    return id;
  };
  const a = await store('A');
  const b = await store('B');
  const person = async (role: string, branchId: Buffer, level?: string) => {
    const id = newUuidV7Bin();
    const u = tag();
    await root.$executeRaw`INSERT INTO users (id, company_id, name, login, personal_id, password_hash, is_active, updated_at)
      VALUES (${id}, ${companyId}, ${role}, ${`nt-${u}`}, ${u.padStart(10, '0')}, 'x', TRUE, NOW(6))`;
    await root.userBranch.create({ data: { id: newUuidV7Bin(), companyId, userId: id, branchId, roleId: (roleIds as Record<string, Buffer>)[role] } });
    if (level) await root.notificationPreference.create({ data: { userId: id, companyId, level } });
    await root.pushDevice.create({ data: { id: newUuidV7Bin(), companyId, userId: id, token: `ExponentPushToken[${u}]`, platform: 'ios', locale: 'ar' } });
    return id;
  };
  const manager = await person('store_manager', a, 'all');
  const seller = await person('store_employee', a);
  const elsewhere = await person('store_manager', b, 'all');
  const notification = async (type: string, branchId: Buffer, actorUserId: Buffer | null) => {
    const id = newUuidV7Bin();
    await root.notification.create({ data: { id, companyId, branchId, targetUserId: null, type, title: 'x', actorUserId } });
    return id;
  };
  return { companyId, a, b, manager, seller, elsewhere, notification };
}

const dispatcherOn = (client: PrismaClient, provider: PushProvider) => new PushDispatcher(client as never, { pushChannel: 'expo' } as never, provider);

run('notifications on real MySQL', () => {
  beforeAll(async () => {
    root = new PrismaClient({ datasources: { db: { url: ROOT_URL } } });
  });
  afterAll(async () => {
    await Promise.all([root, ...apps].map((c) => c.$disconnect()));
  });

  it('two dispatches of one notification at once push each device once', async () => {
    const w = await world();
    const n = await w.notification('return.requested', w.a, w.seller);
    const provider = new RecordingProvider();
    await Promise.all([dispatcherOn(app(), provider).dispatch(n), dispatcherOn(app(), provider).dispatch(n)]);
    await dispatcherOn(app(), provider).dispatch(n);
    // The manager of store A only: the seller asked (never their own action), store B's manager is not in A.
    expect(provider.sent).toHaveLength(1);
    expect(await root.pushDelivery.count({ where: { notificationId: n } })).toBe(1);
    expect((await root.pushDelivery.findFirstOrThrow({ where: { notificationId: n } })).status).toBe('sent');
    expect(provider.sent[0].title).toBe('مرتجع للمراجعة');
  });

  it('a store broadcast never reaches another store’s phone, whatever their level', async () => {
    const w = await world();
    const n = await w.notification('sale.recorded', w.a, null);
    const provider = new RecordingProvider();
    await dispatcherOn(app(), provider).dispatch(n);
    const devices = await root.pushDevice.findMany({ where: { userId: { in: [w.manager, w.elsewhere] } }, select: { token: true, userId: true } });
    const elsewhere = devices.find((d) => d.userId.equals(w.elsewhere))!.token;
    expect(provider.sent.map((m) => m.token)).not.toContain(elsewhere);
    // The manager chose All activity: a routine sale reaches them. The employee is on Approvals only: it does not.
    expect(provider.sent).toHaveLength(1);
  });

  it('read state is per person and survives across devices', async () => {
    const w = await world();
    const n = await w.notification('sale.recorded', w.a, null);
    const service = new NotificationsService([] as never, app() as never);
    await service.markRead(w.manager, n);
    expect((await service.listForUser(w.manager)).unreadCount).toBe(0);
    expect((await service.listForUser(w.seller)).unreadCount).toBe(1);
    // Another device of the manager reads the same server state.
    expect((await new NotificationsService([] as never, app() as never).listForUser(w.manager)).rows[0].isRead).toBe(true);
  });

  it('a level is stored once per account and read back', async () => {
    const w = await world();
    const service = new NotificationsService([] as never, app() as never);
    expect(await service.preferenceOf(w.seller)).toMatchObject({ level: 'approvals', isDefault: true });
    await service.setPreference(w.seller, 'important');
    expect(await new NotificationsService([] as never, app() as never).preferenceOf(w.seller)).toMatchObject({ level: 'important', isDefault: false });
  });

  it('a phone that changes hands across businesses is the newcomer’s: one row, and the previous business stops reaching it', async () => {
    const first = await world();
    const second = await world();
    const token = (await root.pushDevice.findFirstOrThrow({ where: { userId: first.manager } })).token;
    const devices = new PushDevicesService(app() as never);
    await devices.revoke(first.manager, token);
    await devices.register(second.manager, second.companyId, { token, platform: 'ios', locale: 'fr' });
    await devices.register(second.manager, second.companyId, { token, platform: 'ios', locale: 'fr' });
    const rows = await root.pushDevice.findMany({ where: { token } });
    expect(rows).toHaveLength(1);
    expect(rows[0].companyId.equals(second.companyId)).toBe(true);
    // The first business's sale reaches no phone that is now the second's.
    const provider = new RecordingProvider();
    await dispatcherOn(app(), provider).dispatch(await first.notification('sale.recorded', first.a, null));
    expect(provider.sent.map((m) => m.token)).not.toContain(token);
  });
});
