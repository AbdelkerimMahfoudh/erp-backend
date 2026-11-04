import { PrismaClient } from '@prisma/client';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import { ConnectionsService } from './connections.service';

/**
 * Partner stores end to end on REAL MySQL (post-Build-4: "the code does not exist" for every code). Two distinct active
 * businesses, the exact 10-character codes the app shows, the service connected as `phonestore_app`:
 * A's code found by B whatever its case and spaces — without A ever opting into search; B asks; A sees and accepts;
 * both see it active; retries add nothing; and each refusal its own answer. Only the public preview before acceptance.
 *
 * Env-gated: CONNECT_ROOT_URL (root: fixtures) and CONNECT_APP_URL (phonestore_app) on a DISPOSABLE database. Run in
 * the database gates (`deploy/ci-database-gates.sh`).
 */
const ROOT_URL = process.env.CONNECT_ROOT_URL ?? '';
const APP_URL = process.env.CONNECT_APP_URL ?? '';
const run = ROOT_URL !== '' && APP_URL !== '' ? describe : describe.skip;
jest.setTimeout(120_000);

let root: PrismaClient;
let app: PrismaClient;
let seq = 0;
const code = () => `${Date.now().toString(16)}${seq++}`.toUpperCase().slice(-10).padStart(10, 'A');

async function business(o: { active?: boolean } = {}) {
  const id = newUuidV7Bin();
  const publicStoreId = code();
  // Never discoverable: the code alone must find it.
  await root.$executeRaw`INSERT INTO companies (id, name, settings, updated_at, public_store_id, is_active, is_discoverable) VALUES (${id}, ${`Shop ${publicStoreId}`}, JSON_OBJECT(), NOW(6), ${publicStoreId}, ${o.active ?? true}, FALSE)`;
  await root.branch.create({ data: { id: newUuidV7Bin(), companyId: id, name: `Store ${publicStoreId}` } });
  const user = newUuidV7Bin();
  await root.$executeRaw`INSERT INTO users (id, company_id, name, login, personal_id, password_hash, is_active, updated_at) VALUES (${user}, ${id}, 'Owner', ${`c-${publicStoreId}`}, ${publicStoreId}, 'x', TRUE, NOW(6))`;
  return { id, user, publicStoreId };
}

const as = (b: { id: Buffer; user: Buffer }) =>
  new ConnectionsService(app as never, { companyId: () => b.id, userId: () => b.user, requireUserId: () => b.user } as never, { record: async () => undefined } as never);

run('partner stores on real MySQL', () => {
  beforeAll(() => {
    root = new PrismaClient({ datasources: { db: { url: ROOT_URL } } });
    app = new PrismaClient({ datasources: { db: { url: APP_URL } } });
  });
  afterAll(async () => {
    await root?.$disconnect();
    await app?.$disconnect();
  });

  it('A’s displayed code — lowercase, with spaces — finds A for B, without A in search; only its public preview', async () => {
    const [a, b] = [await business(), await business()];
    const found = await as(b).lookup(`  ${a.publicStoreId.toLowerCase()} `);
    expect(found.store.publicStoreId).toBe(a.publicStoreId);
    expect(found.relationship).toBeNull();
    expect(Object.keys(found.store).sort().join()).not.toMatch(/cost|price|staff|phone|email|balance/i);
  });

  it('B asks, A sees it and accepts, both see it accepted; a retry adds nothing', async () => {
    const [a, b] = [await business(), await business()];
    await as(b).request(a.publicStoreId);
    await as(b).request(` ${a.publicStoreId.toLowerCase()}`);
    expect(await root.storeConnection.count({ where: { OR: [{ requesterCompanyId: b.id, addresseeCompanyId: a.id }, { requesterCompanyId: a.id, addresseeCompanyId: b.id }] } })).toBe(1);
    const incoming = (await as(a).list()).rows.find((r: { direction: string }) => r.direction === 'incoming')!;
    expect(incoming).toMatchObject({ status: 'pending', canDecide: true });
    await as(a).decide(incoming.id, true);
    for (const side of [a, b]) expect((await as(side).list()).rows.map((r: { status: string }) => r.status)).toEqual(['accepted']);
    // Already partners: its own answer, and still one row.
    await expect(as(b).request(a.publicStoreId)).rejects.toMatchObject({ response: { code: 'connection_already_connected' } });
    expect(await root.storeConnection.count({ where: { OR: [{ requesterCompanyId: b.id }, { addresseeCompanyId: b.id }] } })).toBe(1);
    expect((await as(b).lookup(a.publicStoreId)).relationship).toMatchObject({ status: 'accepted' });
  });

  it('each refusal its own answer: invalid, unknown, own code, inactive store, pending request', async () => {
    const [a, b, gone] = [await business(), await business(), await business({ active: false })];
    await expect(as(b).lookup('ABC')).rejects.toMatchObject({ response: { code: 'store_code_invalid' } });
    await expect(as(b).lookup('ZZZZZZZZZZ')).rejects.toMatchObject({ response: { code: 'store_code_unknown' } });
    await expect(as(b).lookup(b.publicStoreId)).rejects.toMatchObject({ response: { code: 'connection_self' } });
    await expect(as(b).lookup(gone.publicStoreId)).rejects.toMatchObject({ response: { code: 'store_unavailable' } });
    await as(b).request(a.publicStoreId);
    expect((await as(b).lookup(a.publicStoreId)).relationship).toMatchObject({ status: 'pending', direction: 'outgoing' });
  });
});
