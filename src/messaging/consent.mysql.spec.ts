import { Prisma, PrismaClient } from '@prisma/client';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import { recipientHash } from './recipient-hash';
import { WHATSAPP_CONSENT_VERSION } from './whatsapp-consent';
import { WhatsAppRecords } from './whatsapp-records';

/**
 * The operational WhatsApp consent history (0100; D213) on REAL MySQL — what the in-memory records cannot show: the
 * contact row lock that orders two decisions about one number across separate connection pools, the triggers that
 * keep the history append-only for the application account, the CHECKs as written, and DATETIME(6) ordering.
 *
 * Env-gated, and skipped otherwise: set CONSENT_ROOT_URL (root: the fixtures and the reads) and CONSENT_APP_URL
 * (phonestore_app: the records under test, so the triggers see the application account) to a DISPOSABLE database with
 * 0100 applied, whose name starts with `grace_` or `consent_`. It writes rows and never removes them (it cannot: the
 * triggers refuse): drop the database afterwards. CI runs it in the database gates (`deploy/ci-database-gates.sh`).
 */

const ROOT_URL = process.env.CONSENT_ROOT_URL ?? '';
const APP_URL = process.env.CONSENT_APP_URL ?? '';
const run = ROOT_URL !== '' && APP_URL !== '' ? describe : describe.skip;

jest.setTimeout(120_000);

const KEY = 'consent-mysql-spec-hash-key-32-characters!';
const hasher = { hash: (n: string) => recipientHash(n, KEY) };

let root: PrismaClient;
const apps: PrismaClient[] = [];
let seq = 0;
/** A number nobody else in this database uses. */
const number = () => `+2224${(Date.now() % 1_000_000).toString().padStart(6, '0')}${(seq++ % 100).toString().padStart(2, '0')}`;

async function company(): Promise<Buffer> {
  const id = newUuidV7Bin();
  const tag = `${Date.now().toString(36)}${seq++}`.toUpperCase().slice(-10);
  await root.$executeRaw`INSERT INTO companies (id, name, settings, updated_at, public_store_id) VALUES (${id}, ${`Consent ${tag}`}, JSON_OBJECT(), NOW(6), ${`CS${tag}`})`;
  return id;
}

/** A person of the business: the audit row's actor must exist (audit_logs.user_id references users). */
async function user(companyId: Buffer): Promise<Buffer> {
  const id = newUuidV7Bin();
  const tag = `${Date.now().toString(36)}${seq++}`.slice(-10);
  await root.$executeRaw`INSERT INTO users (id, company_id, name, login, personal_id, password_hash, updated_at) VALUES (${id}, ${companyId}, 'Consent', ${`consent-${tag}`}, ${tag.toUpperCase().padStart(10, '0')}, 'x', NOW(6))`;
  return id;
}

function recordsOn(client: PrismaClient) {
  return new WhatsAppRecords(client as never, hasher as never);
}

const grant = (r: WhatsAppRecords, to: string, companyId: Buffer, userId: Buffer | null = null) =>
  r.recordConsent({ number: to, version: WHATSAPP_CONSENT_VERSION, locale: 'ar', companyId, userId, source: 'mobile_registration', ip: '203.0.113.7' });

run('the consent history on real MySQL (0100)', () => {
  beforeAll(async () => {
    for (const url of [ROOT_URL, APP_URL]) {
      const name = new URL(url).pathname.replace(/^\//, '');
      if (!/^(grace_|consent_)/.test(name)) throw new Error(`Refusing to write to ${name}: this spec needs a disposable grace_* or consent_* database.`);
    }
    root = new PrismaClient({ datasources: { db: { url: ROOT_URL } } });
    for (let i = 0; i < 4; i++) apps.push(new PrismaClient({ datasources: { db: { url: APP_URL } } }));
    const applied = await root.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM _prisma_migrations WHERE migration_name = '0100_whatsapp_operational_consent' AND finished_at IS NOT NULL`;
    if (Number(applied[0].n) !== 1) throw new Error('0100 is not applied to this database.');
  });

  afterAll(async () => {
    await Promise.all([root, ...apps].map((c) => c?.$disconnect()));
  });

  it('a grant records the version, the locale shown, the purpose and an audit event with the address', async () => {
    const to = number();
    const c = await company();
    expect(await grant(recordsOn(apps[0]), to, c)).toBe('recorded');
    const rows = await root.whatsAppConsent.findMany({ where: { numberHash: hasher.hash(to) } });
    expect(rows).toEqual([expect.objectContaining({ event: 'active', version: WHATSAPP_CONSENT_VERSION, locale: 'ar', purposes: 'operational_whatsapp', source: 'mobile_registration' })]);
    expect(rows[0].numberMasked).not.toContain(to.slice(4));
    const audit = await root.auditLog.findFirst({ where: { companyId: c, entityType: 'WhatsAppConsent' } });
    expect(audit).toMatchObject({ ip: '203.0.113.7', reason: 'Operational WhatsApp consent granted for a verified number' });
  });

  it('four processes granting the same agreement at once write one row', async () => {
    const to = number();
    const c = await company();
    const actor = await user(c);
    const outcomes = await Promise.all(apps.map((client) => grant(recordsOn(client), to, c, actor)));
    expect(outcomes.filter((o) => o === 'recorded')).toHaveLength(1);
    expect(await root.whatsAppConsent.count({ where: { numberHash: hasher.hash(to) } })).toBe(1);
  });

  it('withdrawals racing each other write one; a grant and a withdrawal racing leave a consistent state', async () => {
    const to = number();
    const c = await company();
    const actor = await user(c);
    await grant(recordsOn(apps[0]), to, c, actor);
    const outcomes = await Promise.all(apps.map((client) => recordsOn(client).withdrawConsent({ number: to, companyId: c, userId: actor, source: 'account_settings' })));
    expect(outcomes.filter((o) => o === 'recorded')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'unchanged')).toHaveLength(apps.length - 1);
    const state = await recordsOn(root).contactState(to);
    expect(state).toMatchObject({ consented: false, consent: 'withdrawn', optOutScope: 'all' });

    const raced = await Promise.all([grant(recordsOn(apps[1]), to, c, actor), recordsOn(apps[2]).withdrawConsent({ number: to, companyId: c, userId: actor, source: 'account_settings' })]);
    const after = await recordsOn(root).contactState(to);
    const newest = await root.whatsAppConsent.findFirst({ where: { numberHash: hasher.hash(to), event: { in: ['active', 'withdrawn'] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    // Whichever came second decided, and the contact row agrees with it.
    expect(after.consent).toBe(newest!.event === 'active' ? 'active' : 'withdrawn');
    expect(after.optOutScope).toBe(newest!.event === 'active' ? 'none' : 'all');
    expect(raced).toHaveLength(2);
  });

  it('the application account can neither edit nor delete a decision', async () => {
    const to = number();
    await grant(recordsOn(apps[0]), to, await company());
    const row = await root.whatsAppConsent.findFirstOrThrow({ where: { numberHash: hasher.hash(to) } });
    await expect(apps[0].$executeRaw`UPDATE whatsapp_consents SET event = 'withdrawn' WHERE id = ${row.id}`).rejects.toThrow(/immutable/);
    await expect(apps[0].$executeRaw`DELETE FROM whatsapp_consents WHERE id = ${row.id}`).rejects.toThrow(/immutable/);
    expect(await root.whatsAppConsent.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ event: 'active' });
  });

  it('the CHECKs refuse a grant without a version, an unknown event and an unknown locale', async () => {
    const insert = (event: string, version: string | null, locale: string | null) =>
      apps[0].$executeRaw`INSERT INTO whatsapp_consents (id, number_hash, number_masked, event, version, locale, source) VALUES (${newUuidV7Bin()}, ${'0'.repeat(64)}, '+000***00', ${event}, ${version}, ${locale}, 'account_settings')`;
    const code = async (p: Promise<unknown>) => {
      try {
        await p;
        return 'accepted';
      } catch (e) {
        return e instanceof Prisma.PrismaClientKnownRequestError ? String(e.meta?.code ?? e.code) : String((e as Error).message).match(/3819|Check constraint/)?.[0] ?? 'other';
      }
    };
    expect(await code(insert('granted', null, 'en'))).toMatch(/3819|Check constraint/);
    expect(await code(insert('marketing', null, null))).toMatch(/3819|Check constraint/);
    expect(await code(insert('granted', WHATSAPP_CONSENT_VERSION, 'de'))).toMatch(/3819|Check constraint/);
  });

  it('pending until verified: four processes verifying the same number at once activate it exactly once', async () => {
    const to = number();
    const c = await company();
    const actor = await user(c);
    await recordsOn(apps[0]).recordPending({ number: to, version: WHATSAPP_CONSENT_VERSION, locale: 'fr', companyId: c, userId: actor, source: 'employee_activation' });
    expect(await recordsOn(root).contactState(to)).toMatchObject({ consent: 'pending', consented: false, pendingLive: true });
    const outcomes = await Promise.all(apps.map((client) => recordsOn(client).activatePending({ number: to, userId: actor, companyId: c })));
    expect(outcomes.filter((o) => o === 'activated')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'unchanged')).toHaveLength(apps.length - 1);
    const rows = await root.whatsAppConsent.findMany({ where: { numberHash: hasher.hash(to) }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => r.event)).toEqual(['pending_unverified', 'active']);
    expect(rows[1].pendingId).toEqual(rows[0].id);
    expect(await recordsOn(root).contactState(to)).toMatchObject({ consent: 'active', consented: true });
  });

  it('an agreement left 24 hours: a late verification activates nothing, two sweeps racing write one expiry', async () => {
    const to = number();
    const c = await company();
    const actor = await user(c);
    const pendingId = newUuidV7Bin();
    await recordsOn(root).recordPending({ number: to, version: WHATSAPP_CONSENT_VERSION, locale: 'en', companyId: c, userId: actor, source: 'mobile_registration' });
    // Aged as only an operator can (the application account cannot touch the history): a copy 25 hours old.
    await root.$executeRaw`INSERT INTO whatsapp_consents (id, number_hash, number_masked, event, version, locale, purposes, actor_company_id, actor_user_id, source, created_at)
      SELECT ${pendingId}, number_hash, number_masked, event, version, locale, purposes, actor_company_id, actor_user_id, source, NOW(6) - INTERVAL 25 HOUR
      FROM whatsapp_consents WHERE number_hash = ${hasher.hash(to)} LIMIT 1`;
    await root.$executeRaw`DELETE FROM whatsapp_consents WHERE number_hash = ${hasher.hash(to)} AND id <> ${pendingId}`;
    expect(await recordsOn(apps[0]).activatePending({ number: to, userId: actor, companyId: c })).toBe('no_pending');
    const [a, b] = await Promise.all([recordsOn(apps[1]).expireStalePending(), recordsOn(apps[2]).expireStalePending()]);
    const expired = await root.whatsAppConsent.findMany({ where: { pendingId } });
    expect(expired).toEqual([expect.objectContaining({ event: 'expired', source: 'expiry' })]);
    expect(a + b).toBeGreaterThanOrEqual(1);
    expect(await recordsOn(root).contactState(to)).toMatchObject({ consented: false, pendingLive: false });
  });

  it('UNIQUE (pending_id): a pending agreement is concluded once, and an expiry must name the agreement it ends', async () => {
    const to = number();
    const c = await company();
    const actor = await user(c);
    await recordsOn(apps[0]).recordPending({ number: to, version: WHATSAPP_CONSENT_VERSION, locale: 'en', companyId: c, userId: actor, source: 'mobile_registration' });
    await recordsOn(apps[0]).activatePending({ number: to, userId: actor, companyId: c });
    const pending = await root.whatsAppConsent.findFirstOrThrow({ where: { numberHash: hasher.hash(to), event: 'pending_unverified' } });
    await expect(
      apps[0].$executeRaw`INSERT INTO whatsapp_consents (id, number_hash, number_masked, event, pending_id, source) VALUES (${newUuidV7Bin()}, ${hasher.hash(to)}, '+222***00', 'expired', ${pending.id}, 'expiry')`,
    ).rejects.toThrow(/Duplicate|ux_whatsapp_consents_pending|1062/);
    await expect(
      apps[0].$executeRaw`INSERT INTO whatsapp_consents (id, number_hash, number_masked, event, source) VALUES (${newUuidV7Bin()}, ${hasher.hash(to)}, '+222***00', 'expired', 'expiry')`,
    ).rejects.toThrow(/3819|Check constraint/);
  });

  it('a STOP after a grant withdraws, ordered by when it is recorded', async () => {
    const to = number();
    await grant(recordsOn(apps[0]), to, await company());
    await recordsOn(apps[1]).applyInbound(hasher.hash(to), '+222***00', new Date(Date.now() - 60_000), 'stop');
    expect(await recordsOn(root).contactState(to)).toMatchObject({ consent: 'withdrawn', consented: false });
  });
});
