import { Prisma, PrismaClient } from '@prisma/client';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { recipientHash } from '../messaging/recipient-hash';
import { WHATSAPP_CONSENT_VERSION } from '../messaging/whatsapp-consent';
import { WhatsAppRecords } from '../messaging/whatsapp-records';
import { activateIfReadyTx, type ActivationDb } from '../platform/staff-activation-rules';
import { StaffInvitationService } from './staff-invitation.service';

/**
 * Employee invitations (0101; D214) on REAL MySQL — what the in-memory world cannot show: the row locks that order a
 * confirmation, a cancellation and a reinvitation across separate connection pools, the one-live-invitation UNIQUE
 * column, the triggers that keep an ended invitation ended for the application account, and the CHECKs as written.
 *
 * Env-gated, and skipped otherwise: set INVITATION_ROOT_URL (root: fixtures and reads) and INVITATION_APP_URL
 * (phonestore_app: the service under test, so the triggers see the application account) to a DISPOSABLE database with
 * 0101 applied, whose name starts with `grace_` or `consent_`. It writes rows it cannot remove: drop the database
 * afterwards. CI runs it in the database gates (`deploy/ci-database-gates.sh`).
 */

const ROOT_URL = process.env.INVITATION_ROOT_URL ?? '';
const APP_URL = process.env.INVITATION_APP_URL ?? '';
const run = ROOT_URL !== '' && APP_URL !== '' ? describe : describe.skip;

jest.setTimeout(120_000);

const KEY = 'invitation-mysql-spec-hash-key-32-chars!!';
const INVITATION_KEY = 'invitation-mysql-spec-reference-key-32ch';
const CODE = '123456';
const hasher = { hash: (n: string) => recipientHash(n, KEY) };

let root: PrismaClient;
const apps: PrismaClient[] = [];
let seq = 0;
const number = () => `+2225${(Date.now() % 1_000_000).toString().padStart(6, '0')}${(seq++ % 100).toString().padStart(2, '0')}`;
const tag = () => `${Date.now().toString(36)}${seq++}`.toUpperCase().slice(-10);

async function company(): Promise<Buffer> {
  const id = newUuidV7Bin();
  const t = tag();
  await root.$executeRaw`INSERT INTO companies (id, name, settings, updated_at, public_store_id) VALUES (${id}, ${`Invite ${t}`}, JSON_OBJECT(), NOW(6), ${`IV${t}`})`;
  return id;
}

async function person(companyId: Buffer, o: { phone?: string; pending?: boolean } = {}): Promise<Buffer> {
  const id = newUuidV7Bin();
  const t = tag();
  const pending = o.pending ?? false;
  await root.$executeRaw`INSERT INTO users (id, company_id, name, login, personal_id, password_hash, phone, is_active, invited_at, activated_at, updated_at)
    VALUES (${id}, ${companyId}, ${pending ? 'Fatima' : 'Owner'}, ${`iv-${t}`}, ${t.padStart(10, '0')}, 'x', ${o.phone ?? null}, ${!pending}, ${pending ? new Date() : null}, ${pending ? null : new Date()}, NOW(6))`;
  return id;
}

/** The service on one connection pool, as the API runs it; only what the invitation paths touch is real. */
function serviceOn(client: PrismaClient, companyId: Buffer, ownerId: Buffer) {
  const records = new WhatsAppRecords(client as never, hasher as never);
  const verification = {
    start: async (destination: string) => {
      await root.$executeRaw`INSERT INTO contact_verifications (id, channel, destination, code_hash, expires_at) VALUES (${newUuidV7Bin()}, 'phone', ${destination}, 'x', NOW(6) + INTERVAL 10 MINUTE)`;
      return { delivery: 'outbox' as const };
    },
    latestChallengeFor: async (destination: string) => {
      const row = await client.contactVerification.findFirst({ where: { destination, consumedAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true } });
      return row?.id ?? null;
    },
    confirmChallenge: async (_id: Buffer, code: string) => (code === CODE ? 'ok' : 'wrong'),
  };
  const audit = {
    recordTx: (tx: Prisma.TransactionClient, e: { entityType: string; entityId: Buffer; action: string; after?: object }) =>
      tx.auditLog.create({ data: { companyId, userId: ownerId, entityType: e.entityType, entityId: e.entityId, action: e.action as never, after: e.after ?? Prisma.JsonNull } }),
  };
  const activation = {
    activateInTx: (tx: Prisma.TransactionClient, userId: Buffer, actor: string) => activateIfReadyTx(tx as unknown as ActivationDb, userId, new Date(), actor),
    tryActivate: async () => ({ activated: false, alreadyActive: false, pending: ['seat_payment'] }),
  };
  return {
    records,
    service: new StaffInvitationService(
      client as never,
      { companyId: () => companyId, requireUserId: () => ownerId } as never,
      audit as never,
      { hash: async (p: string) => `hash(${p})` } as never,
      verification as never,
      { canDeliver: () => true } as never,
      {} as never,
      activation as never,
      { withdraw: async () => undefined } as never,
      { staffInvitationKey: INVITATION_KEY } as never,
      records,
    ),
  };
}

/** A business, its Owner and a pending employee with an invitation: the reference, as the Owner was shown it. */
async function invited() {
  const c = await company();
  const owner = await person(c);
  const phone = number();
  const employee = await person(c, { phone, pending: true });
  const { invitation } = await serviceOn(apps[0], c, owner).service.reinvite(binToUuid(employee));
  return { c, owner, phone, employee, reference: invitation.reference, uuid: binToUuid(employee) };
}

const ask = (client: PrismaClient, f: Awaited<ReturnType<typeof invited>>) =>
  serviceOn(client, f.c, f.owner).service.requestCode(f.reference, f.phone, 'fr', { version: WHATSAPP_CONSENT_VERSION, locale: 'fr' }, '203.0.113.7');
const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
const codeOf = (e: unknown) => (e as { response?: { code?: string } }).response?.code ?? (e as Error).message;

run('employee invitations on real MySQL (0101)', () => {
  beforeAll(async () => {
    for (const url of [ROOT_URL, APP_URL]) {
      const name = new URL(url).pathname.replace(/^\//, '');
      if (!/^(grace_|consent_)/.test(name)) throw new Error(`Refusing to write to ${name}: this spec needs a disposable grace_* or consent_* database.`);
    }
    root = new PrismaClient({ datasources: { db: { url: ROOT_URL } } });
    for (let i = 0; i < 4; i++) apps.push(new PrismaClient({ datasources: { db: { url: APP_URL } } }));
    const applied = await root.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM _prisma_migrations WHERE migration_name = '0101_staff_invitations' AND finished_at IS NOT NULL`;
    if (Number(applied[0].n) !== 1) throw new Error('0101 is not applied to this database.');
  });

  afterAll(async () => {
    await Promise.all([root, ...apps].map((c) => c?.$disconnect()));
  });

  it('the reference is stored only as its keyed hash, and the invitation names a business and a person — never a number', async () => {
    const f = await invited();
    const row = await root.staffInvitation.findFirstOrThrow({ where: { userId: f.employee } });
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const dump = JSON.stringify(await root.$queryRaw`SELECT * FROM staff_invitations WHERE user_id = ${f.employee}`, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
    expect(dump).not.toContain(f.reference.replace(/-/g, ''));
    expect(dump).not.toContain(f.phone.slice(4));
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(72 * 60 * 60 * 1000);
  });

  it('four processes confirming the same reference at once: one activation — of the consent, the invitation and the account', async () => {
    const f = await invited();
    await ask(apps[0], f);
    const outcomes = await Promise.all(apps.map((client) => settle(serviceOn(client, f.c, f.owner).service.confirm(f.reference, CODE, 'Secret-pass-1'))));
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    for (const o of outcomes.filter((x) => !x.ok)) expect(['invitation_unavailable', 'code_mismatch']).toContain(codeOf((o as { e: unknown }).e));
    const consents = await root.whatsAppConsent.findMany({ where: { numberHash: hasher.hash(f.phone) }, orderBy: { createdAt: 'asc' } });
    expect(consents.map((r) => r.event)).toEqual(['pending_unverified', 'active']);
    expect(consents[0].actorUserId).toEqual(f.employee);
    const invitation = await root.staffInvitation.findFirstOrThrow({ where: { userId: f.employee } });
    expect(invitation.usedAt).not.toBeNull();
    expect(invitation.pendingConsentId).toEqual(consents[0].id);
    const user = await root.user.findUniqueOrThrow({ where: { id: f.employee } });
    expect(user).toMatchObject({ isActive: true });
    expect(user.phoneVerifiedAt).not.toBeNull();
    expect(user.activatedAt).not.toBeNull();
  });

  it('a confirmation racing the Owner’s cancellation: one of them wins, whole — never an activated account withdrawn, never two conclusions', async () => {
    for (let round = 0; round < 3; round++) {
      const f = await invited();
      await ask(apps[0], f);
      const [confirmed, cancelled] = await Promise.all([
        settle(serviceOn(apps[1], f.c, f.owner).service.confirm(f.reference, CODE, 'Secret-pass-1')),
        settle(serviceOn(apps[2], f.c, f.owner).service.cancel(f.uuid)),
      ]);
      expect(confirmed.ok !== cancelled.ok).toBe(true);
      const user = await root.user.findUniqueOrThrow({ where: { id: f.employee } });
      const invitation = await root.staffInvitation.findFirstOrThrow({ where: { userId: f.employee } });
      const conclusions = await root.whatsAppConsent.findMany({ where: { pendingId: invitation.pendingConsentId } });
      expect(conclusions).toHaveLength(1);
      if (confirmed.ok) {
        expect(user).toMatchObject({ isActive: true, deletedAt: null });
        expect(invitation).toMatchObject({ revokedAt: null });
        expect(conclusions[0].event).toBe('active');
        expect(codeOf((cancelled as { e: unknown }).e)).toBe('not_pending');
      } else {
        expect(user.deletedAt).not.toBeNull();
        expect(user.activatedAt).toBeNull();
        expect(invitation).toMatchObject({ usedAt: null, revokedReason: 'cancelled' });
        expect(conclusions[0]).toMatchObject({ event: 'cancelled', source: 'invitation_cancelled' });
        expect(codeOf((confirmed as { e: unknown }).e)).toBe('invitation_unavailable');
      }
    }
  });

  it('two reinvitations at once: each revokes the one before it, and exactly one invitation is left live', async () => {
    const f = await invited();
    await ask(apps[0], f);
    const results = await Promise.all([1, 2].map((i) => settle(serviceOn(apps[i], f.c, f.owner).service.reinvite(f.uuid))));
    expect(results.every((r) => r.ok)).toBe(true);
    const rows = await root.staffInvitation.findMany({ where: { userId: f.employee }, orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.revokedAt === null && r.usedAt === null)).toHaveLength(1);
    expect(rows.filter((r) => r.revokedReason === 'reinvited')).toHaveLength(2);
    // The first invitation's pending agreement was concluded once, as replaced.
    const conclusions = await root.whatsAppConsent.findMany({ where: { pendingId: rows[0].pendingConsentId } });
    expect(conclusions).toEqual([expect.objectContaining({ event: 'cancelled', source: 'invitation_replaced' })]);
  });

  it('one number invited by two businesses: each invitation activates only its own account', async () => {
    const a = await invited();
    const c = await company();
    const owner = await person(c);
    const other = await person(c, { phone: a.phone, pending: true });
    await serviceOn(apps[0], c, owner).service.reinvite(binToUuid(other));
    await ask(apps[0], a);
    await serviceOn(apps[1], a.c, a.owner).service.confirm(a.reference, CODE, 'Secret-pass-1');
    expect(await root.user.findUniqueOrThrow({ where: { id: a.employee } })).toMatchObject({ isActive: true });
    const untouched = await root.user.findUniqueOrThrow({ where: { id: other } });
    expect(untouched).toMatchObject({ isActive: false, phoneVerifiedAt: null, activatedAt: null });
    expect(await root.staffInvitation.findFirstOrThrow({ where: { userId: other } })).toMatchObject({ usedAt: null, revokedAt: null, pendingConsentId: null });
  });

  it('the application account cannot re-open, re-point or delete an invitation; the database keeps one live per person', async () => {
    const f = await invited();
    const row = await root.staffInvitation.findFirstOrThrow({ where: { userId: f.employee } });
    await expect(apps[0].$executeRaw`UPDATE staff_invitations SET expires_at = NOW(6) + INTERVAL 30 DAY WHERE id = ${row.id}`).rejects.toThrow(/keeps its business/);
    await expect(apps[0].$executeRaw`UPDATE staff_invitations SET token_hash = ${'f'.repeat(64)} WHERE id = ${row.id}`).rejects.toThrow(/keeps its business/);
    await expect(apps[0].$executeRaw`DELETE FROM staff_invitations WHERE id = ${row.id}`).rejects.toThrow(/never deleted/);
    await apps[0].$executeRaw`UPDATE staff_invitations SET revoked_at = NOW(6), revoked_reason = 'cancelled' WHERE id = ${row.id}`;
    await expect(apps[0].$executeRaw`UPDATE staff_invitations SET revoked_at = NULL, revoked_reason = NULL WHERE id = ${row.id}`).rejects.toThrow(/ended invitation is never changed/);
    // One live per person: a second live row for the same person is refused by the UNIQUE generated column.
    await apps[0].$executeRaw`INSERT INTO staff_invitations (id, company_id, user_id, token_hash, issued_by, expires_at) VALUES (${newUuidV7Bin()}, ${f.c}, ${f.employee}, ${'a'.repeat(64)}, 'spec', NOW(6) + INTERVAL 1 DAY)`;
    await expect(
      apps[0].$executeRaw`INSERT INTO staff_invitations (id, company_id, user_id, token_hash, issued_by, expires_at) VALUES (${newUuidV7Bin()}, ${f.c}, ${f.employee}, ${'b'.repeat(64)}, 'spec', NOW(6) + INTERVAL 1 DAY)`,
    ).rejects.toThrow(/Duplicate|ux_staff_invitations_live|1062/);
  });

  it('the CHECKs: one end only, a reason with a revocation and none without, a known reason, and no use without a consent', async () => {
    const f = await invited();
    const hash = () => `${tag()}${seq}`.toLowerCase().padEnd(64, '0');
    const refused = /3819|Check constraint/;
    const consent = newUuidV7Bin();
    await expect(
      apps[0].$executeRaw`INSERT INTO staff_invitations (id, company_id, user_id, token_hash, issued_by, expires_at, used_at, revoked_at, revoked_reason, pending_consent_id)
        VALUES (${newUuidV7Bin()}, ${f.c}, ${f.employee}, ${hash()}, 'spec', NOW(6), NOW(6), NOW(6), 'cancelled', ${consent})`,
    ).rejects.toThrow(refused);
    await expect(
      apps[0].$executeRaw`INSERT INTO staff_invitations (id, company_id, user_id, token_hash, issued_by, expires_at, revoked_at) VALUES (${newUuidV7Bin()}, ${f.c}, ${f.employee}, ${hash()}, 'spec', NOW(6), NOW(6))`,
    ).rejects.toThrow(refused);
    await expect(
      apps[0].$executeRaw`INSERT INTO staff_invitations (id, company_id, user_id, token_hash, issued_by, expires_at, revoked_reason) VALUES (${newUuidV7Bin()}, ${f.c}, ${f.employee}, ${hash()}, 'spec', NOW(6), 'cancelled')`,
    ).rejects.toThrow(refused);
    await expect(
      apps[0].$executeRaw`INSERT INTO staff_invitations (id, company_id, user_id, token_hash, issued_by, expires_at, revoked_at, revoked_reason) VALUES (${newUuidV7Bin()}, ${f.c}, ${f.employee}, ${hash()}, 'spec', NOW(6), NOW(6), 'forgotten')`,
    ).rejects.toThrow(refused);
    await expect(
      apps[0].$executeRaw`INSERT INTO staff_invitations (id, company_id, user_id, token_hash, issued_by, expires_at, used_at) VALUES (${newUuidV7Bin()}, ${f.c}, ${f.employee}, ${hash()}, 'spec', NOW(6), NOW(6))`,
    ).rejects.toThrow(refused);
  });

  it('the consent history refuses a cancellation that names no agreement (amended 0100)', async () => {
    await expect(
      apps[0].$executeRaw`INSERT INTO whatsapp_consents (id, number_hash, number_masked, event, source) VALUES (${newUuidV7Bin()}, ${'0'.repeat(64)}, '+222***00', 'cancelled', 'invitation_cancelled')`,
    ).rejects.toThrow(/3819|Check constraint/);
  });
});
