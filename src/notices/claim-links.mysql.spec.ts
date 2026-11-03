import { PrismaClient } from '@prisma/client';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import { CLAIM_LINK_TTL_MS, ClaimLinkService, hashClaimToken } from './claim-links.service';

/**
 * The account-ready message's single-use link (post-Build-4, 0129) on REAL MySQL, as `phonestore_app`:
 *  - only the hash is stored; the token opens exactly once, and a second use, an expired link or a malformed one is
 *    refused with its own reason;
 *  - two redemptions racing: one session, never two;
 *  - a failed session opening leaves the link unspent;
 *  - a new message's link revokes the earlier messages'; a retry of the same message keeps its earlier one.
 *
 * Env-gated: CLAIM_ROOT_URL (root: fixtures) and CLAIM_APP_URL (phonestore_app) on a DISPOSABLE database at 0129 or
 * later. Run in the database gates (`deploy/ci-database-gates.sh`).
 */

const ROOT_URL = process.env.CLAIM_ROOT_URL ?? '';
const APP_URL = process.env.CLAIM_APP_URL ?? '';
const run = ROOT_URL !== '' && APP_URL !== '' ? describe : describe.skip;

jest.setTimeout(120_000);

let root: PrismaClient;
let app: PrismaClient;
let seq = 0;
const tag = () => `${Date.now().toString(36)}${seq++}`.toUpperCase().slice(-10);

async function owner() {
  const companyId = newUuidV7Bin();
  const userId = newUuidV7Bin();
  const t = tag();
  await root.$executeRaw`INSERT INTO companies (id, name, settings, updated_at, public_store_id) VALUES (${companyId}, ${`Claim ${t}`}, JSON_OBJECT(), NOW(6), ${`CL${t}`})`;
  await root.$executeRaw`INSERT INTO users (id, company_id, name, login, personal_id, password_hash, is_active, updated_at)
    VALUES (${userId}, ${companyId}, 'Owner', ${`cl-${t}`}, ${t.padStart(10, '0')}, 'x', TRUE, NOW(6))`;
  return { companyId, userId };
}

run('portal claim links on real MySQL', () => {
  beforeAll(() => {
    root = new PrismaClient({ datasources: { db: { url: ROOT_URL } } });
    app = new PrismaClient({ datasources: { db: { url: APP_URL } } });
  });
  afterAll(async () => {
    await root?.$disconnect();
    await app?.$disconnect();
  });

  it('stores only the hash; opens once; then used; expired and malformed links are refused with their reason', async () => {
    const links = new ClaimLinkService(app as never);
    const o = await owner();
    const { token, expiresAt } = await links.issue(o);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await root.portalClaimLink.findMany({ where: { companyId: o.companyId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashClaimToken(token));
    expect(JSON.stringify(rows, (_k, v) => (Buffer.isBuffer(v) ? '' : v))).not.toContain(token);
    expect(expiresAt.getTime() - rows[0].createdAt.getTime()).toBe(CLAIM_LINK_TTL_MS);

    await expect(links.redeem(token, async (_tx, link) => link.userId.equals(o.userId))).resolves.toEqual({ ok: true, result: true });
    await expect(links.redeem(token, async () => true)).resolves.toEqual({ ok: false, reason: 'used' });

    const later = await owner();
    const old = await links.issue(later, new Date(Date.now() - CLAIM_LINK_TTL_MS - 1000));
    await expect(links.redeem(old.token, async () => true)).resolves.toEqual({ ok: false, reason: 'expired' });
    await expect(links.redeem('not-a-link', async () => true)).resolves.toEqual({ ok: false, reason: 'invalid' });
    await expect(links.redeem('B'.repeat(43), async () => true)).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it('two redemptions racing open one session; a failed opening leaves the link unspent', async () => {
    const links = new ClaimLinkService(app as never);
    const o = await owner();
    const { token } = await links.issue(o);
    await expect(links.redeem(token, async () => { throw new Error('session refused'); })).rejects.toThrow('session refused');
    expect((await root.portalClaimLink.findFirstOrThrow({ where: { companyId: o.companyId } })).usedAt).toBeNull();
    let opened = 0;
    const raced = await Promise.all([1, 2, 3].map(() => links.redeem(token, async () => ++opened)));
    expect(raced.filter((r) => r.ok)).toHaveLength(1);
    expect(opened).toBe(1);
  });

  it('a new message’s link revokes the earlier messages’; a retry of the same message keeps its earlier link', async () => {
    const links = new ClaimLinkService(app as never);
    const o = await owner();
    const first = newUuidV7Bin();
    const a = await links.issue({ ...o, noticeId: first });
    const retry = await links.issue({ ...o, noticeId: first });
    await expect(links.redeem(a.token, async () => 'a')).resolves.toEqual({ ok: true, result: 'a' });
    const b = await links.issue({ ...o, noticeId: newUuidV7Bin() });
    await expect(links.redeem(retry.token, async () => 'retry')).resolves.toEqual({ ok: false, reason: 'invalid' });
    await expect(links.redeem(b.token, async () => 'b')).resolves.toEqual({ ok: true, result: 'b' });
  });
});
