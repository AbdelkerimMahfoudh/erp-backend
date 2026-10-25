import { Prisma, PrismaClient } from '@prisma/client';
import { HashingService } from '../common/security/hashing.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import { systemClock } from '../entitlement/clock';
import { PlatformAuditService } from '../platform/platform-audit.service';
import { RegistrationService } from '../platform/registration.service';
import { AcquisitionService, AcquisitionUnavailableException } from './acquisition.service';
import { LookupLimiter } from './lookup-limiter';
import { PromoterService } from './promoter.service';
import { ReferralInvitationService } from './referral-invitation.service';
import { signReferralToken } from './referral-token';

/**
 * Promoter attribution and user invitations (0103, D221) on REAL MySQL — what the in-memory world cannot show: a code
 * unique for ever under concurrent issue and forced collisions, one live code per promoter, the attribution written
 * with the business or not at all, a replay that never attributes twice, one live invitation per person and language
 * under racing taps, the triggers that keep codes, invitations and attributions as they were written, and the CHECKs.
 *
 * Env-gated, and skipped otherwise: set ACQUISITION_ROOT_URL (root: fixtures and reads) and ACQUISITION_APP_URL
 * (phonestore_app: the services under test, so the triggers see the application account) to a DISPOSABLE database
 * with 0103 applied, whose name starts with `grace_` or `acquisition_`. It writes rows it cannot remove: drop the
 * database afterwards. CI runs it in the database gates (`deploy/ci-database-gates.sh`).
 */

const ROOT_URL = process.env.ACQUISITION_ROOT_URL ?? '';
const APP_URL = process.env.ACQUISITION_APP_URL ?? '';
const run = ROOT_URL !== '' && APP_URL !== '' ? describe : describe.skip;

jest.setTimeout(120_000);

const KEY = 'acquisition-mysql-spec-referral-key-32-chars!';
const PORTAL = 'https://dukan.example.test';
const config = { referralKey: KEY, portalOrigin: PORTAL };
const ADMIN = { id: newUuidV7Bin(), email: `acquisition-${Date.now().toString(36)}@example.test`, name: 'Acquisition' };

let root: PrismaClient;
const apps: PrismaClient[] = [];
let seq = 0;
const tag = () => `${Date.now().toString(36)}${seq++}`.toUpperCase().slice(-10);
const number = () => `+2224${(Date.now() % 1_000_000).toString().padStart(6, '0')}${(seq++ % 100).toString().padStart(2, '0')}`;

/** A collision on demand: the draw hands out the queued codes first, then the CSPRNG's. */
class ScriptedPromoters extends PromoterService {
  queue: string[] = [];
  protected override draw = () => this.queue.shift() ?? `${Math.floor(Math.random() * 1e6)}`.padStart(6, '0');
}

function servicesOn(client: PrismaClient) {
  const limiter = new LookupLimiter(systemClock);
  const acquisition = new AcquisitionService(client as never, config as never, limiter);
  const audit = new PlatformAuditService(client as never);
  const promoters = new ScriptedPromoters(client as never, config as never, audit, acquisition);
  const registration = new RegistrationService(client as never, new HashingService(), systemClock, acquisition);
  return { acquisition, promoters, registration, limiter };
}

/** The invitation service for one signed-in person, its audit row written in the business's own trail. */
function invitationsOn(client: PrismaClient, companyId: Buffer, userId: Buffer) {
  const audit = {
    recordTx: (tx: Prisma.TransactionClient, e: { entityType: string; entityId?: Buffer; action: string; after?: object }) =>
      tx.auditLog.create({ data: { companyId, userId, entityType: e.entityType, entityId: e.entityId ?? null, action: e.action as never, after: e.after ?? Prisma.JsonNull } }),
  };
  const acquisition = new AcquisitionService(client as never, config as never, new LookupLimiter(systemClock));
  return { service: new ReferralInvitationService(client as never, config as never, acquisition, audit as never), principal: { companyId, userId } };
}

let attempt = 0;
function registrationOf(extra: Record<string, unknown> = {}) {
  const t = tag();
  return {
    idempotencyKey: `acq-${t}-${attempt++}`,
    ownerName: `Owner ${t}`,
    businessName: `Shop ${t}`,
    branchName: 'Main',
    phone: number(),
    password: 'password-1',
    language: 'en' as const,
    trialEligible: true,
    ...extra,
  };
}

async function companyOf(attemptKey: string): Promise<Buffer | null> {
  const row = await root.registrationAttempt.findUnique({ where: { idempotencyKey: attemptKey }, select: { companyId: true } });
  return row?.companyId ?? null;
}

async function trigger(client: PrismaClient, sql: Prisma.Sql): Promise<string> {
  try {
    await client.$executeRaw(sql);
    return 'allowed';
  } catch (e) {
    return String((e as Error).message);
  }
}

run('promoter attribution and user invitations on real MySQL (0103)', () => {
  beforeAll(async () => {
    const name = new URL(ROOT_URL).pathname.slice(1);
    if (!/^(grace_|acquisition_)/.test(name)) throw new Error(`refusing to run on "${name}": a disposable grace_* or acquisition_* database only`);
    root = new PrismaClient({ datasources: { db: { url: ROOT_URL } } });
    apps.push(new PrismaClient({ datasources: { db: { url: APP_URL } } }), new PrismaClient({ datasources: { db: { url: APP_URL } } }));
    await root.$executeRaw`INSERT INTO platform_admins (id, email, name, password_hash, updated_at) VALUES (${ADMIN.id}, ${ADMIN.email}, ${ADMIN.name}, 'x', NOW(6))`;
  });

  afterAll(async () => {
    await Promise.all([root?.$disconnect(), ...apps.map((a) => a.$disconnect())]);
  });

  async function promoterWithCode(name = `Promoter ${tag()}`) {
    const { promoters } = servicesOn(apps[0]);
    const created = await promoters.create({ displayName: name, whatsappNumber: number(), note: 'Met at the market' }, { admin: ADMIN });
    const issued = await promoters.issueCode(created.id, { regenerate: false }, { admin: ADMIN });
    return issued;
  }

  describe('a promoter’s code', () => {
    it('is issued once, explicitly, with its QR link — and a second "generate" is refused', async () => {
      const { promoters } = servicesOn(apps[0]);
      const created = await promoters.create({ displayName: `Aminata ${tag()}`, whatsappNumber: '36 00 00 11', note: '' }, { admin: ADMIN });
      expect(created.code).toBeNull();
      expect(created.qrLink).toBeNull();
      expect(created.whatsappNumber).toBe('+22236000011');
      expect(created.note).toBeNull();
      const issued = await promoters.issueCode(created.id, { regenerate: false }, { admin: ADMIN });
      expect(issued.code?.code).toMatch(/^[0-9]{6}$/);
      expect(issued.code?.version).toBe(1);
      expect(issued.qrLink).toMatch(new RegExp(`^${PORTAL}/join\\?r=[A-Za-z0-9_-]{50}$`));
      await expect(promoters.issueCode(created.id, { regenerate: false }, { admin: ADMIN })).rejects.toMatchObject({ response: { code: 'promoter_code_exists' } });
    });

    it('regenerating retires the old code and its QR, keeps the history, and the old code never opens again', async () => {
      const { promoters, acquisition } = servicesOn(apps[0]);
      const first = await promoterWithCode();
      const oldCode = first.code!.code;
      const oldLink = new URL(first.qrLink!).searchParams.get('r')!;
      const second = await promoters.issueCode(first.id, { regenerate: true }, { admin: ADMIN });
      expect(second.code!.version).toBe(2);
      expect(second.code!.code).not.toBe(oldCode);
      expect(second.codeHistory.map((h) => [h.version, h.retiredAt !== null])).toEqual([[2, false], [1, true]]);
      expect(await acquisition.lookupCode(oldCode, null)).toStrictEqual({ usable: false });
      expect(await acquisition.lookupLink(oldLink, null)).toStrictEqual({ usable: false });
      const newLink = new URL(second.qrLink!).searchParams.get('r')!;
      expect(await acquisition.lookupLink(newLink, null)).toMatchObject({ usable: true, code: second.code!.code });
    });

    it('a collision is retried with a fresh draw in the same transaction; a code is never issued twice, even retired', async () => {
      const { promoters } = servicesOn(apps[0]);
      const taken = await promoterWithCode();
      const retired = taken.code!.code;
      await promoters.issueCode(taken.id, { regenerate: true }, { admin: ADMIN });
      const other = await promoters.create({ displayName: `Other ${tag()}`, whatsappNumber: number() }, { admin: ADMIN });
      promoters.queue = [retired, retired];
      const issued = await promoters.issueCode(other.id, { regenerate: false }, { admin: ADMIN });
      expect(issued.code!.code).not.toBe(retired);
      expect(await root.promoterCode.count({ where: { code: retired } })).toBe(1);

      const stuck = await promoters.create({ displayName: `Stuck ${tag()}`, whatsappNumber: number() }, { admin: ADMIN });
      promoters.queue = Array(8).fill(retired);
      await expect(promoters.issueCode(stuck.id, { regenerate: false }, { admin: ADMIN })).rejects.toMatchObject({ response: { code: 'promoter_code_unavailable' } });
      // Nothing was left half-done: no code, no current code.
      expect(await root.promoterCode.count({ where: { promoterId: Buffer.from(stuck.id.replace(/-/g, ''), 'hex') } })).toBe(0);
    });

    it('two administrators regenerating at once are serialised: distinct versions, exactly one usable code', async () => {
      const first = await promoterWithCode();
      const a = servicesOn(apps[0]).promoters;
      const b = servicesOn(apps[1]).promoters;
      await Promise.all([a.issueCode(first.id, { regenerate: true }, { admin: ADMIN }), b.issueCode(first.id, { regenerate: true }, { admin: ADMIN })]);
      const id = Buffer.from(first.id.replace(/-/g, ''), 'hex');
      const codes = await root.promoterCode.findMany({ where: { promoterId: id }, orderBy: { version: 'asc' } });
      expect(codes.map((c) => c.version)).toEqual([1, 2, 3]);
      expect(codes.filter((c) => c.retiredAt === null)).toHaveLength(1);
      const promoter = await root.promoter.findUniqueOrThrow({ where: { id } });
      expect(promoter.currentCodeId!.equals(codes[2].id)).toBe(true);
    });

    it('deactivating stops the code and QR without retiring them; reactivating brings the same code back', async () => {
      const { promoters, acquisition } = servicesOn(apps[0]);
      const p = await promoterWithCode();
      await promoters.setActive(p.id, false, { admin: ADMIN });
      expect(await acquisition.lookupCode(p.code!.code, null)).toStrictEqual({ usable: false });
      await promoters.setActive(p.id, true, { admin: ADMIN });
      expect(await acquisition.lookupCode(p.code!.code, null)).toMatchObject({ usable: true, promoterName: p.displayName });
    });

    it('the audit trail records every change without the number, the note or the digits', async () => {
      const { promoters } = servicesOn(apps[0]);
      const p = await promoterWithCode();
      await promoters.update(p.id, { whatsappNumber: number(), note: 'A private note' }, { admin: ADMIN });
      const id = Buffer.from(p.id.replace(/-/g, ''), 'hex');
      const events = await root.platformAuditEvent.findMany({ where: { targetId: id }, orderBy: { createdAt: 'asc' } });
      expect(events.map((e) => e.action)).toEqual(['promoter.create', 'promoter.code_issued', 'promoter.update']);
      const written = JSON.stringify(events);
      const detail = await promoters.detail(p.id);
      expect(written).not.toContain(detail.whatsappNumber);
      expect(written).not.toContain(detail.whatsappNumber.slice(1));
      expect(written).not.toContain('A private note');
      expect(written).not.toContain('Met at the market');
      expect(written).not.toContain(p.code!.code);
    });

    it('the list masks the number and finds a promoter by name or by code', async () => {
      const { promoters } = servicesOn(apps[0]);
      const p = await promoterWithCode(`Findable ${tag()}`);
      const byCode = await promoters.list({ q: p.code!.code });
      expect(byCode.rows.map((r) => r.id)).toEqual([p.id]);
      expect(byCode.rows[0].whatsappMasked).toMatch(/^\+\d{3}\*\*\*\d{2}$/);
      expect(JSON.stringify(byCode)).not.toContain((await promoters.detail(p.id)).whatsappNumber);
      expect((await promoters.list({ q: p.displayName })).rows.map((r) => r.id)).toEqual([p.id]);
    });
  });

  describe('a registration’s attribution', () => {
    it('a promo code: the business and its one attribution commit together, with the name as it was', async () => {
      const { registration } = servicesOn(apps[0]);
      const p = await promoterWithCode();
      const input = registrationOf({ acquisition: { promoCode: p.code!.code } });
      const result = await registration.register(input);
      const companyId = await companyOf(input.idempotencyKey);
      const a = await root.businessAcquisition.findUniqueOrThrow({ where: { companyId: companyId! } });
      expect(result.created).toBe(true);
      expect(a).toMatchObject({ source: 'promoter', mechanism: 'promo_code', codeVersion: 1, promoterName: p.displayName, invitationId: null });
      // No contact is snapshotted: the row has no column for one.
      expect(Object.keys(a).some((k) => /phone|whatsapp|number/i.test(k))).toBe(false);
    });

    it('a replay of the same registration never attributes twice, whatever it carries the second time', async () => {
      const { registration } = servicesOn(apps[0]);
      const p = await promoterWithCode();
      const q = await promoterWithCode();
      const input = registrationOf({ acquisition: { promoCode: p.code!.code } });
      await registration.register(input);
      const again = await registration.register({ ...input, acquisition: { promoCode: q.code!.code } });
      expect(again.created).toBe(false);
      const companyId = await companyOf(input.idempotencyKey);
      const rows = await root.businessAcquisition.findMany({ where: { companyId: companyId! } });
      expect(rows).toHaveLength(1);
      expect(rows[0].promoterName).toBe(p.displayName);
    });

    it('two racing submissions of one registration make one business and one attribution', async () => {
      const p = await promoterWithCode();
      const input = registrationOf({ acquisition: { promoCode: p.code!.code } });
      const results = await Promise.all([servicesOn(apps[0]).registration.register(input), servicesOn(apps[1]).registration.register(input)]);
      expect(results.map((r) => r.created).sort()).toEqual([false, true]);
      const companyId = await companyOf(input.idempotencyKey);
      expect(await root.businessAcquisition.count({ where: { companyId: companyId! } })).toBe(1);
    });

    it('a source that became unavailable refuses the registration and saves nothing at all', async () => {
      const { registration, promoters } = servicesOn(apps[0]);
      const p = await promoterWithCode();
      await promoters.setActive(p.id, false, { admin: ADMIN });
      const before = await root.company.count();
      const input = registrationOf({ acquisition: { promoCode: p.code!.code } });
      await expect(registration.register(input)).rejects.toBeInstanceOf(AcquisitionUnavailableException);
      expect(await root.company.count()).toBe(before);
      expect(await companyOf(input.idempotencyKey)).toBeNull();
      // Retried without the code, the same key registers normally, with no source.
      const plain = await registration.register({ ...input, acquisition: null });
      expect(plain.created).toBe(true);
      expect(await root.businessAcquisition.count({ where: { companyId: (await companyOf(input.idempotencyKey))! } })).toBe(0);
    });

    it('a QR link attributes by QR; a link from before a regeneration is refused', async () => {
      const { registration, promoters } = servicesOn(apps[0]);
      const p = await promoterWithCode();
      const token = new URL(p.qrLink!).searchParams.get('r')!;
      const input = registrationOf({ acquisition: { referralToken: token } });
      await registration.register(input);
      const a = await root.businessAcquisition.findUniqueOrThrow({ where: { companyId: (await companyOf(input.idempotencyKey))! } });
      expect(a).toMatchObject({ source: 'promoter', mechanism: 'promoter_qr', codeVersion: 1 });
      await promoters.issueCode(p.id, { regenerate: true }, { admin: ADMIN });
      await expect(registration.register(registrationOf({ acquisition: { referralToken: token } }))).rejects.toMatchObject({ source: 'promoter' });
    });

    it('a registration without a source is unchanged: no attribution row', async () => {
      const { registration } = servicesOn(apps[0]);
      const input = registrationOf();
      await registration.register(input);
      expect(await root.businessAcquisition.count({ where: { companyId: (await companyOf(input.idempotencyKey))! } })).toBe(0);
    });
  });

  describe('user invitations', () => {
    async function inviter() {
      const { registration } = servicesOn(apps[0]);
      const input = registrationOf();
      const r = await registration.register(input);
      return { companyId: Buffer.from(r.companyId.replace(/-/g, ''), 'hex'), userId: Buffer.from(r.ownerUserId.replace(/-/g, ''), 'hex') };
    }

    it('one live link per person and language, under racing taps, handed back after that', async () => {
      const who = await inviter();
      const a = invitationsOn(apps[0], who.companyId, who.userId);
      const b = invitationsOn(apps[1], who.companyId, who.userId);
      const [x, y] = await Promise.all([a.service.createOrGet(a.principal, 'fr'), b.service.createOrGet(b.principal, 'fr')]);
      expect(x.id).toBe(y.id);
      expect(x.link).toBe(y.link);
      const ar = await a.service.createOrGet(a.principal, 'ar');
      expect(ar.id).not.toBe(x.id);
      expect((await a.service.mine(a.principal)).invitations.map((i) => i.language).sort()).toEqual(['ar', 'fr']);
      expect(await root.referralInvitation.count({ where: { createdByUserId: who.userId, revokedAt: null } })).toBe(2);
    });

    it('attributes the invited business to the inviting business, with the person for the audit', async () => {
      const who = await inviter();
      const inv = invitationsOn(apps[0], who.companyId, who.userId);
      const link = await inv.service.createOrGet(inv.principal, 'en');
      const token = new URL(link.link).searchParams.get('r')!;
      const { registration, acquisition } = servicesOn(apps[0]);
      expect(await acquisition.lookupLink(token, null)).toStrictEqual({ usable: true, source: 'user_invite' });
      const input = registrationOf({ acquisition: { referralToken: token } });
      await registration.register(input);
      const a = await root.businessAcquisition.findUniqueOrThrow({ where: { companyId: (await companyOf(input.idempotencyKey))! } });
      expect(a).toMatchObject({ source: 'user_invite', mechanism: 'user_invite', promoterId: null, promoterName: null });
      expect(a.inviterCompanyId!.equals(who.companyId)).toBe(true);
      expect(a.inviterUserId!.equals(who.userId)).toBe(true);
    });

    it('revoking stops the link for good; only its maker can; a new link is a new token', async () => {
      const who = await inviter();
      const other = await inviter();
      const mine = invitationsOn(apps[0], who.companyId, who.userId);
      const theirs = invitationsOn(apps[0], other.companyId, other.userId);
      const link = await mine.service.createOrGet(mine.principal, 'en');
      await expect(theirs.service.revoke(theirs.principal, link.id)).rejects.toMatchObject({ status: 404 });
      await mine.service.revoke(mine.principal, link.id);
      const token = new URL(link.link).searchParams.get('r')!;
      expect(await servicesOn(apps[0]).acquisition.lookupLink(token, null)).toStrictEqual({ usable: false });
      const fresh = await mine.service.createOrGet(mine.principal, 'en');
      expect(fresh.link).not.toBe(link.link);
      // Another business never sees this person's links.
      expect((await theirs.service.mine(theirs.principal)).invitations).toEqual([]);
    });
  });

  describe('reporting', () => {
    it('counts self-registrations by source and filters the rows', async () => {
      const { acquisition, registration } = servicesOn(apps[0]);
      const p = await promoterWithCode();
      const before = await acquisition.summary({});
      await registration.register(registrationOf({ acquisition: { promoCode: p.code!.code } }));
      await registration.register(registrationOf());
      const after = await acquisition.summary({});
      expect(after.promoter - before.promoter).toBe(1);
      expect(after.none - before.none).toBe(1);
      const promoterRows = await acquisition.report({ source: 'promoter', promoterId: Buffer.from(p.id.replace(/-/g, ''), 'hex') });
      expect(promoterRows.rows).toHaveLength(1);
      expect(promoterRows.rows[0]).toMatchObject({ source: 'promoter', mechanism: 'promo_code', status: 'pending_activation', completed: false });
      expect(promoterRows.rows[0].promoter).toMatchObject({ nameSnapshot: p.displayName, codeVersion: 1 });
      const counts = await acquisition.promoterCounts([Buffer.from(p.id.replace(/-/g, ''), 'hex')]);
      expect(counts.get(p.id)).toEqual({ registrations: 1, completed: 0 });
    });
  });

  describe('what the application account cannot do', () => {
    it('rewrite or delete an attribution', async () => {
      const { registration } = servicesOn(apps[0]);
      const p = await promoterWithCode();
      const input = registrationOf({ acquisition: { promoCode: p.code!.code } });
      await registration.register(input);
      const companyId = (await companyOf(input.idempotencyKey))!;
      expect(await trigger(apps[0], Prisma.sql`UPDATE business_acquisitions SET promoter_name = 'Someone else' WHERE company_id = ${companyId}`)).toMatch(/immutable/);
      expect(await trigger(apps[0], Prisma.sql`DELETE FROM business_acquisitions WHERE company_id = ${companyId}`)).toMatch(/immutable/);
    });

    it('change a code’s digits, un-retire one, or delete a code or a promoter', async () => {
      const { promoters } = servicesOn(apps[0]);
      const p = await promoterWithCode();
      const id = Buffer.from(p.id.replace(/-/g, ''), 'hex');
      expect(await trigger(apps[0], Prisma.sql`UPDATE promoter_codes SET code = '000000' WHERE promoter_id = ${id}`)).toMatch(/keeps its promoter/);
      await promoters.issueCode(p.id, { regenerate: true }, { admin: ADMIN });
      expect(await trigger(apps[0], Prisma.sql`UPDATE promoter_codes SET retired_at = NULL, retired_by = NULL WHERE promoter_id = ${id} AND version = 1`)).toMatch(/retired code is never changed/);
      expect(await trigger(apps[0], Prisma.sql`DELETE FROM promoter_codes WHERE promoter_id = ${id}`)).toMatch(/never deleted/);
      expect(await trigger(apps[0], Prisma.sql`DELETE FROM promoters WHERE id = ${id}`)).toMatch(/never deleted/);
      expect(await trigger(apps[0], Prisma.sql`UPDATE promoters SET public_ref = ${Buffer.alloc(16, 1)} WHERE id = ${id}`)).toMatch(/keeps its reference/);
    });

    it('re-point or reopen an invitation', async () => {
      const who = await (async () => {
        const r = await servicesOn(apps[0]).registration.register(registrationOf());
        return { companyId: Buffer.from(r.companyId.replace(/-/g, ''), 'hex'), userId: Buffer.from(r.ownerUserId.replace(/-/g, ''), 'hex') };
      })();
      const inv = invitationsOn(apps[0], who.companyId, who.userId);
      const link = await inv.service.createOrGet(inv.principal, 'en');
      const id = Buffer.from(link.id.replace(/-/g, ''), 'hex');
      expect(await trigger(apps[0], Prisma.sql`UPDATE referral_invitations SET language = 'fr' WHERE id = ${id}`)).toMatch(/keeps its business/);
      await inv.service.revoke(inv.principal, link.id);
      expect(await trigger(apps[0], Prisma.sql`UPDATE referral_invitations SET revoked_at = NULL, revoked_by_user_id = NULL WHERE id = ${id}`)).toMatch(/never changed/);
      expect(await trigger(apps[0], Prisma.sql`DELETE FROM referral_invitations WHERE id = ${id}`)).toMatch(/never deleted/);
    });

    it('write an attribution with both sources, or none, or a business inviting itself (CHECKs)', async () => {
      const p = await promoterWithCode();
      const pid = Buffer.from(p.id.replace(/-/g, ''), 'hex');
      const code = await root.promoterCode.findFirstOrThrow({ where: { promoterId: pid } });
      const r = await servicesOn(apps[0]).registration.register(registrationOf());
      const companyId = Buffer.from(r.companyId.replace(/-/g, ''), 'hex');
      const attemptId = (await root.registrationAttempt.findFirstOrThrow({ where: { companyId } })).id;
      const userId = Buffer.from(r.ownerUserId.replace(/-/g, ''), 'hex');
      const r2 = await servicesOn(apps[0]).registration.register(registrationOf());
      const other = { companyId: Buffer.from(r2.companyId.replace(/-/g, ''), 'hex'), userId: Buffer.from(r2.ownerUserId.replace(/-/g, ''), 'hex') };
      const both = await trigger(root, Prisma.sql`INSERT INTO business_acquisitions (id, company_id, registration_attempt_id, source, mechanism, promoter_id, promoter_code_id, code_version, promoter_name, inviter_company_id, inviter_user_id, invitation_id)
        VALUES (${newUuidV7Bin()}, ${companyId}, ${attemptId}, 'promoter', 'promo_code', ${pid}, ${code.id}, 1, 'x', ${other.companyId}, ${other.userId}, NULL)`);
      expect(both).toMatch(/ck_business_acquisition_shape/);
      const own = invitationsOn(apps[0], companyId, userId);
      const invitationId = Buffer.from((await own.service.createOrGet(own.principal, 'en')).id.replace(/-/g, ''), 'hex');
      const self = await trigger(root, Prisma.sql`INSERT INTO business_acquisitions (id, company_id, registration_attempt_id, source, mechanism, invitation_id, inviter_company_id, inviter_user_id)
        VALUES (${newUuidV7Bin()}, ${companyId}, ${attemptId}, 'user_invite', 'user_invite', ${invitationId}, ${companyId}, ${userId})`);
      expect(self).toMatch(/ck_business_acquisition_not_self/);
      const none = await trigger(root, Prisma.sql`INSERT INTO business_acquisitions (id, company_id, registration_attempt_id, source, mechanism) VALUES (${newUuidV7Bin()}, ${companyId}, ${attemptId}, 'promoter', 'promo_code')`);
      expect(none).toMatch(/ck_business_acquisition_shape/);
      expect(await trigger(root, Prisma.sql`INSERT INTO promoter_codes (id, promoter_id, code, version, issued_by) VALUES (${newUuidV7Bin()}, ${pid}, '12a456', 9, 'x')`)).toMatch(/ck_promoter_code_digits/);
      expect(await trigger(root, Prisma.sql`INSERT INTO promoter_codes (id, promoter_id, code, version, issued_by) VALUES (${newUuidV7Bin()}, ${pid}, '123457', 9, 'x')`)).toMatch(/Duplicate entry .* for key 'promoter_codes.ux_promoter_codes_live'/);
    });
  });

  it('a token signed by another key, or for a row that does not exist, opens nothing', async () => {
    const { acquisition } = servicesOn(apps[0]);
    const p = await promoterWithCode();
    const ref = (await root.promoter.findUniqueOrThrow({ where: { id: Buffer.from(p.id.replace(/-/g, ''), 'hex') } })).publicRef;
    expect(await acquisition.lookupLink(signReferralToken(`${KEY}-other`, { kind: 'promoter', ref, version: 1 }), null)).toStrictEqual({ usable: false });
    expect(await acquisition.lookupLink(signReferralToken(KEY, { kind: 'promoter', ref: Buffer.alloc(16, 0xee), version: 1 }), null)).toStrictEqual({ usable: false });
  });
});
