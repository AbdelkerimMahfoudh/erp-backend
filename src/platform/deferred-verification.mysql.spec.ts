import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { BillingService } from '../billing/billing.service';
import { HashingService } from '../common/security/hashing.service';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { EntitlementService } from '../entitlement/entitlement.service';
import { AccountSetupCodeService } from './account-setup-code.service';
import { OwnerInvitationService } from './owner-invitation.service';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformMfaService } from './platform-mfa.service';
import { RegistrationService } from './registration.service';
import { SeatAllocationService } from './seat-allocation.service';
import { StaffActivationService } from './staff-activation.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { AccountProvisioningService, type ProvisioningActor } from './account-provisioning.service';

/**
 * Deferred WhatsApp verification for platform-provisioned test accounts (0109, D224, docs/109) on REAL MySQL — what an
 * in-memory world cannot show: the state's CHECK and triggers, the live-row UNIQUE columns, one winner when a setup
 * code is spent twice at once across two connection pools, and the audit as rows.
 *
 * Env-gated, and skipped otherwise: PROVISIONING_ROOT_URL (root: fixtures and reads) and PROVISIONING_APP_URL (the
 * services under test) on a DISPOSABLE database with 0109 applied, whose name starts with `grace_` or `provisioning_`.
 * It writes businesses it never removes: drop the database afterwards. CI runs it in the database gates.
 */

const ROOT_URL = process.env.PROVISIONING_ROOT_URL ?? '';
const APP_URL = process.env.PROVISIONING_APP_URL ?? '';
const run = ROOT_URL !== '' && APP_URL !== '' ? describe : describe.skip;

jest.setTimeout(180_000);

const KEY = 'deferred-verification-spec-key-of-32-chars!';
const clock = { now: () => new Date() };
let root: PrismaClient;
const apps: PrismaClient[] = [];
let seq = 0;
const tag = () => `${Date.now().toString(36)}${seq++}`.toUpperCase().slice(-10);
const phone = () => `+2223${(Date.now() % 1_000_000).toString().padStart(6, '0')}${(seq++ % 100).toString().padStart(2, '0')}`;
const ADMIN = { id: newUuidV7Bin(), email: `deferral-${Date.now().toString(36)}@example.test`, name: 'Deferral' };
const NO_MFA = { id: newUuidV7Bin(), email: `nomfa-${Date.now().toString(36)}@example.test`, name: 'No MFA' };
const hex = (u: string) => Buffer.from(u.replace(/-/g, ''), 'hex');
const codeOf = (e: unknown) => ((e as { getResponse(): { code?: string } }).getResponse?.() ?? {}).code;

function processOn(client: PrismaClient, deferral: { on: boolean }) {
  const db = client as never;
  const config = {
    get phoneVerificationDeferralEnabled() {
      return deferral.on;
    },
    staffInvitationKey: KEY,
    customerActivationOpen: false,
  } as never;
  const hashing = new HashingService();
  const audit = new PlatformAuditService(db);
  const billing = new BillingService(db, clock);
  const seats = new SeatAllocationService(db, audit, billing, clock, { recordTx: async () => undefined } as never);
  const activation = new StaffActivationService(db, seats, clock);
  const sessions = { revokeAll: async () => 0 } as never;
  const codes = new AccountSetupCodeService(db, config, hashing, sessions, activation, audit);
  const mfa = new PlatformMfaService(db, config, audit, hashing);
  const entitlement = new EntitlementService(db, { companyId: () => null } as never, clock);
  return {
    registration: new RegistrationService(db, hashing, clock),
    lifecycle: new SubscriptionLifecycleService(db, audit, billing, clock),
    codes,
    invitations: new OwnerInvitationService(db, hashing, sessions, audit, codes),
    provisioning: new AccountProvisioningService(db, config, hashing, audit, mfa, entitlement, sessions, codes),
    hashing,
  };
}

/** An administrator's session with its second factor, stepped up `ageMs` ago (null: never stepped up). */
async function session(adminId: Buffer, ageMs: number | null): Promise<Buffer> {
  const id = newUuidV7Bin();
  const stepUp = ageMs === null ? null : new Date(Date.now() - ageMs);
  await root.$executeRaw`INSERT INTO platform_admin_sessions (id, admin_id, refresh_token_hash, expires_at, mfa_verified_at, step_up_at)
    VALUES (${id}, ${adminId}, 'x', NOW(6) + INTERVAL 1 HOUR, NOW(6), ${stepUp})`;
  return id;
}

run('deferred WhatsApp verification on real MySQL (0109)', () => {
  const flag = { on: true };
  let a: ReturnType<typeof processOn>;
  let b: ReturnType<typeof processOn>;
  let actor: ProvisioningActor;

  /**
   * An ordinary paying business (the owner's decision, 2026-10-29): activated, its period running, with `extraSeats`
   * pooled seats bought on top of the one each store includes. Nothing about it is a test business.
   */
  async function business(extraSeats = 10) {
    const key = tag();
    const made = await a.registration.register({
      idempotencyKey: `admin:${key}`,
      ownerName: 'Store Owner',
      businessName: `Store ${key}`,
      branchName: '',
      city: 'Nouakchott',
      phone: phone(),
      password: 'unusable-password-for-the-spec',
      language: 'en',
      actor: ADMIN.email,
    });
    await root.$executeRaw`UPDATE subscriptions SET status = 'activated', additional_seats = ${extraSeats}, current_period_end = NOW(6) + INTERVAL 30 DAY WHERE company_id = ${hex(made.companyId)}`;
    const branch = await root.branch.findFirstOrThrow({ where: { companyId: hex(made.companyId) }, select: { id: true } });
    return { ...made, branchId: binToUuid(branch.id) };
  }

  const deferral = { reason: 'WhatsApp Business API not live yet', confirmUnverified: true, reviewAt: new Date(Date.now() + 7 * 86_400_000).toISOString() };

  beforeAll(async () => {
    const name = new URL(ROOT_URL).pathname.slice(1);
    if (!/^(grace_|provisioning_)/.test(name)) throw new Error(`refusing to run on "${name}": a disposable grace_* or provisioning_* database only`);
    root = new PrismaClient({ datasources: { db: { url: ROOT_URL } } });
    apps.push(new PrismaClient({ datasources: { db: { url: APP_URL } } }), new PrismaClient({ datasources: { db: { url: APP_URL } } }));
    a = processOn(apps[0], flag);
    b = processOn(apps[1], flag);
    await root.$executeRaw`INSERT INTO platform_admins (id, email, name, password_hash, mfa_enabled_at, updated_at) VALUES (${ADMIN.id}, ${ADMIN.email}, 'Deferral', 'x', NOW(6), NOW(6))`;
    await root.$executeRaw`INSERT INTO platform_admins (id, email, name, password_hash, updated_at) VALUES (${NO_MFA.id}, ${NO_MFA.email}, 'No MFA', 'x', NOW(6))`;
    actor = { admin: ADMIN, sessionId: await session(ADMIN.id, 0), ip: '127.0.0.1' };
  });

  beforeEach(() => {
    flag.on = true;
  });

  afterAll(async () => {
    await Promise.all([root, ...apps].map((c) => c?.$disconnect()));
  });

  it('the database will not store a deferred or required account as verified, and derives verified from the timestamp', async () => {
    const lab = await business();
    const id = newUuidV7Bin();
    const t = tag();
    await root.$executeRaw`INSERT INTO users (id, company_id, name, login, personal_id, password_hash, phone, phone_verification, updated_at)
      VALUES (${id}, ${hex(lab.companyId)}, 'Probe', ${`pr-${t}`}, ${t.padStart(10, '0')}, 'x', ${phone()}, 'deferred_by_platform', NOW(6))`;
    // "Verified" without a verification: the trigger refuses to keep it.
    await root.$executeRaw`UPDATE users SET phone_verification = 'verified' WHERE id = ${id}`;
    expect((await root.user.findUniqueOrThrow({ where: { id }, select: { phoneVerification: true } })).phoneVerification).toBe('required');
    // A real verification (the timestamp) is what makes it verified, and clearing it undoes that.
    await root.$executeRaw`UPDATE users SET phone_verified_at = NOW(6) WHERE id = ${id}`;
    expect((await root.user.findUniqueOrThrow({ where: { id }, select: { phoneVerification: true } })).phoneVerification).toBe('verified');
    await root.$executeRaw`UPDATE users SET phone_verified_at = NULL WHERE id = ${id}`;
    expect((await root.user.findUniqueOrThrow({ where: { id }, select: { phoneVerification: true } })).phoneVerification).toBe('required');
    const bad = await root.$executeRaw`UPDATE users SET phone_verification = 'confirmed' WHERE id = ${id}`.catch((e: unknown) => e);
    expect(String(bad)).toMatch(/ck_users_phone_verification|3819/);
  });

  it('defaults to Required: a staff account provisioned without a deferral waits for its number to be verified', async () => {
    const lab = await business();
    const made = await a.provisioning.createStaff(lab.companyId, { name: 'Manager R', phone: phone(), role: 'store_manager', branchIds: [lab.branchId], verification: 'required' }, actor);
    expect(made.user.phoneVerification).toBe('required');
    const spent = await a.codes.spend(made.setupCode.token, 'a-new-password-1', {});
    expect(spent).toMatchObject({ spent: true, activated: false });
    const row = await root.user.findUniqueOrThrow({ where: { id: hex(made.user.id) }, select: { isActive: true, activatedAt: true, phoneVerification: true, phoneVerifiedAt: true } });
    expect(row).toEqual({ isActive: false, activatedAt: null, phoneVerification: 'required', phoneVerifiedAt: null });
  });

  it('a deferred employee: no verified timestamp, no consent, no message, a single-use code, then a usable account', async () => {
    const lab = await business();
    const number = phone();
    const made = await a.provisioning.createStaff(lab.companyId, { name: 'Employee D', phone: number, role: 'store_employee', branchIds: [lab.branchId], verification: 'deferred_by_platform', deferral }, actor);
    expect(made.setupCode.delivery).toBe('manual');
    const id = hex(made.user.id);
    expect(await root.user.findUniqueOrThrow({ where: { id }, select: { phoneVerification: true, phoneVerifiedAt: true, isActive: true } })).toEqual({ phoneVerification: 'deferred_by_platform', phoneVerifiedAt: null, isActive: false });
    // Nothing WhatsApp: no consent of any state, no verification challenge, nothing queued for the number.
    expect(await root.whatsAppConsent.count({ where: { OR: [{ actorUserId: id }, { numberMasked: { endsWith: number.slice(-2) }, actorCompanyId: hex(lab.companyId) }] } })).toBe(0);
    expect(await root.contactVerification.count({ where: { destination: number } })).toBe(0);
    // The code is stored only as its keyed hash.
    const stored = await root.accountSetupCode.findFirstOrThrow({ where: { userId: id } });
    expect(stored.tokenHash).toBe(a.codes.hash(made.setupCode.token));
    expect(stored.tokenHash).not.toContain(made.setupCode.token);

    // Spent twice at the same instant across two pools: one winner.
    const [one, two] = await Promise.all([
      a.invitations.accept(made.setupCode.token, 'own-password-1', {}).then(() => 'ok', () => 'refused'),
      b.invitations.accept(made.setupCode.token, 'own-password-2', {}).then(() => 'ok', () => 'refused'),
    ]);
    expect([one, two].sort()).toEqual(['ok', 'refused']);
    const after = await root.user.findUniqueOrThrow({ where: { id }, select: { passwordHash: true, isActive: true, activatedAt: true, phoneVerification: true, phoneVerifiedAt: true } });
    expect(after.isActive).toBe(true);
    expect(after.activatedAt).toBeInstanceOf(Date);
    expect(after.phoneVerification).toBe('deferred_by_platform');
    expect(after.phoneVerifiedAt).toBeNull();
    const winner = one === 'ok' ? 'own-password-1' : 'own-password-2';
    expect(await a.hashing.verify(after.passwordHash, winner)).toBe(true);
    // Used: refused with the one answer, whatever happened to it.
    await expect(a.invitations.accept(made.setupCode.token, 'own-password-3', {})).rejects.toThrow('That invitation cannot be used.');
    // The role and stores are the ones chosen, and still the business's own.
    const ub = await root.userBranch.findMany({ where: { userId: id }, select: { branchId: true, role: { select: { key: true } } } });
    expect(ub.map((u) => [binToUuid(u.branchId), u.role.key])).toEqual([[lab.branchId, 'store_employee']]);
    // The subscription event says what happened, not "verified".
    const event = await root.subscriptionEvent.findFirstOrThrow({ where: { companyId: hex(lab.companyId), kind: 'staff_activated' }, orderBy: { createdAt: 'desc' } });
    expect(event.note).toContain('WhatsApp verification deferred for testing');
    expect(event.note).not.toContain('number verified');
  });

  it('refuses a deferral with the switch off, without MFA, and without a fresh step-up — each audited', async () => {
    const lab = await business();
    const input = (n: string) => ({ name: n, phone: phone(), role: 'store_employee' as const, branchIds: [lab.branchId], verification: 'deferred_by_platform' as const, deferral });

    flag.on = false;
    expect(codeOf(await a.provisioning.createStaff(lab.companyId, input('F'), actor).catch((e: unknown) => e))).toBe('deferral_disabled');
    expect(codeOf(await a.provisioning.assertMayDefer(actor, { id: null, name: 'New business' }, 'phone_verification.defer').catch((e: unknown) => e))).toBe('deferral_disabled');
    flag.on = true;

    const noMfa = { admin: NO_MFA, sessionId: await session(NO_MFA.id, 0), ip: '127.0.0.1' };
    expect(codeOf(await a.provisioning.createStaff(lab.companyId, input('M'), noMfa).catch((e: unknown) => e))).toBe('deferral_mfa_required');

    const stale = { ...actor, sessionId: await session(ADMIN.id, 6 * 60_000) };
    expect(codeOf(await a.provisioning.createStaff(lab.companyId, input('S'), stale).catch((e: unknown) => e))).toBe('step_up_required');
    const never = { ...actor, sessionId: await session(ADMIN.id, null) };
    expect(codeOf(await a.provisioning.createStaff(lab.companyId, input('N'), never).catch((e: unknown) => e))).toBe('step_up_required');

    // Nobody was created by any of them, and every refusal is a row naming its condition.
    expect(await root.user.count({ where: { companyId: hex(lab.companyId), name: { in: ['F', 'M', 'S', 'N'] } } })).toBe(0);
    const refusals = await root.platformAuditEvent.findMany({ where: { action: { endsWith: '.refused' }, targetId: hex(lab.companyId) }, select: { afterJson: true } });
    const conditions = refusals.map((r) => (r.afterJson as { condition?: string }).condition).sort();
    expect(conditions).toEqual(expect.arrayContaining(['kill_switch', 'mfa', 'step_up', 'step_up']));
  });

  it('a deferral is per account in an ordinary business: nothing about the business changes', async () => {
    const lab = await business();
    const before = await root.company.findUniqueOrThrow({ where: { id: hex(lab.companyId) }, select: { isTest: true } });
    const sub = await root.subscription.findFirstOrThrow({ where: { companyId: hex(lab.companyId) }, select: { status: true, additionalSeats: true, isComplimentary: true } });
    await a.provisioning.createStaff(lab.companyId, { name: 'Deferred one', phone: phone(), role: 'store_employee', branchIds: [lab.branchId], verification: 'deferred_by_platform', deferral }, actor);
    await a.provisioning.createStaff(lab.companyId, { name: 'Required one', phone: phone(), role: 'store_employee', branchIds: [lab.branchId], verification: 'required' }, actor);
    expect(before.isTest).toBe(false);
    expect(await root.company.findUniqueOrThrow({ where: { id: hex(lab.companyId) }, select: { isTest: true } })).toEqual(before);
    expect(await root.subscription.findFirstOrThrow({ where: { companyId: hex(lab.companyId) }, select: { status: true, additionalSeats: true, isComplimentary: true } })).toEqual(sub);
    const states = await root.user.findMany({ where: { companyId: hex(lab.companyId), name: { in: ['Deferred one', 'Required one'] } }, select: { name: true, phoneVerification: true }, orderBy: { name: 'asc' } });
    expect(states).toEqual([
      { name: 'Deferred one', phoneVerification: 'deferred_by_platform' },
      { name: 'Required one', phoneVerification: 'required' },
    ]);
    // No seat is ever created by provisioning.
    expect(await root.seatAllocation.count({ where: { companyId: hex(lab.companyId) } })).toBe(0);
  });

  it('preserves the rules: no Owner from the console, unique numbers, the business’s own stores, the business’s own seats', async () => {
    const lab = await business();
    const other = await business();
    const number = phone();
    await a.provisioning.createStaff(lab.companyId, { name: 'First', phone: number, role: 'store_employee', branchIds: [lab.branchId], verification: 'deferred_by_platform', deferral }, actor);
    expect(codeOf(await a.provisioning.createStaff(lab.companyId, { name: 'Again', phone: number, role: 'store_employee', branchIds: [lab.branchId], verification: 'deferred_by_platform', deferral }, actor).catch((e: unknown) => e))).toBe('contact_in_use');
    expect(codeOf(await a.provisioning.createStaff(lab.companyId, { name: 'Owner2', phone: phone(), role: 'owner' as never, branchIds: [lab.branchId], verification: 'required' }, actor).catch((e: unknown) => e))).toBe('role_not_allowed');
    // Another business's store is no store of this one.
    expect(await a.provisioning.createStaff(lab.companyId, { name: 'Cross', phone: phone(), role: 'store_employee', branchIds: [other.branchId], verification: 'required' }, actor).catch((e: unknown) => e)).toBeInstanceOf(NotFoundException);
    // A full store: refused, clearly — never a seat granted, never one priced (the owner's decision, 2026-10-29).
    const tight = await business(0);
    await a.provisioning.createStaff(tight.companyId, { name: 'Takes the seat', phone: phone(), role: 'store_employee', branchIds: [tight.branchId], verification: 'deferred_by_platform', deferral }, actor);
    const full = await a.provisioning.createStaff(tight.companyId, { name: 'One too many', phone: phone(), role: 'store_employee', branchIds: [tight.branchId], verification: 'deferred_by_platform', deferral }, actor).catch((e: unknown) => e);
    expect(full).toBeInstanceOf(ConflictException);
    expect(codeOf(full)).toBe('seat_unavailable');
    expect(await root.user.count({ where: { companyId: hex(tight.companyId), name: 'One too many' } })).toBe(0);
    expect(await root.seatAllocation.count({ where: { companyId: hex(tight.companyId) } })).toBe(0);
  });

  it('a deferred Owner of a new business, its code instead of the setup invitation, and a deferred account never reads verified', async () => {
    const lab = await business();
    const out = await a.provisioning.deferOwner(lab.companyId, { reason: deferral.reason, reviewAt: null }, actor);
    const owner = await root.user.findUniqueOrThrow({ where: { id: hex(out.ownerId) }, select: { phoneVerification: true, phoneVerifiedAt: true } });
    expect(owner).toEqual({ phoneVerification: 'deferred_by_platform', phoneVerifiedAt: null });
    expect(await root.ownerInvitation.count({ where: { companyId: hex(lab.companyId) } })).toBe(0);
    await a.invitations.accept(out.setupCode.token, 'owner-own-password', {});
    const listed = await a.provisioning.listDeferred(lab.companyId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ userId: out.ownerId, phoneVerification: 'deferred_by_platform', grantedBy: ADMIN.email, reason: deferral.reason, setupCode: 'used' });
    expect(JSON.stringify(listed)).not.toMatch(/"verified"|token|password/i);
  });

  it('deferred → required sends nothing, and the person’s own verification later ends the deferral as verified', async () => {
    const lab = await business();
    const number = phone();
    const made = await a.provisioning.createStaff(lab.companyId, { name: 'Later', phone: number, role: 'store_employee', branchIds: [lab.branchId], verification: 'deferred_by_platform', deferral }, actor);
    const id = hex(made.user.id);
    await a.provisioning.updateDeferral(lab.companyId, made.user.id, { reason: 'Pilot extended by the owner' }, actor);
    const res = await a.provisioning.requireVerification(lab.companyId, made.user.id, 'WhatsApp API live', actor);
    expect(res).toEqual({ userId: made.user.id, phoneVerification: 'required', sent: 'nothing' });
    expect(await root.contactVerification.count({ where: { destination: number } })).toBe(0);
    const ended = await root.phoneVerificationDeferral.findFirstOrThrow({ where: { userId: id } });
    expect(ended).toMatchObject({ endReason: 'required', endedBy: ADMIN.email, reason: 'Pilot extended by the owner' });
    expect(codeOf(await a.provisioning.requireVerification(lab.companyId, made.user.id, 'again', actor).catch((e: unknown) => e))).toBe('not_deferred');

    // A second person, still deferred, verifies through the normal flow: the trigger ends the exception.
    const other = await a.provisioning.createStaff(lab.companyId, { name: 'Verifies', phone: phone(), role: 'store_employee', branchIds: [lab.branchId], verification: 'deferred_by_platform', deferral }, actor);
    await root.$executeRaw`UPDATE users SET phone_verified_at = NOW(6) WHERE id = ${hex(other.user.id)}`;
    const done = await root.phoneVerificationDeferral.findFirstOrThrow({ where: { userId: hex(other.user.id) } });
    expect(done).toMatchObject({ endReason: 'verified', endedBy: 'user:own-verification' });
    expect((await root.user.findUniqueOrThrow({ where: { id: hex(other.user.id) }, select: { phoneVerification: true } })).phoneVerification).toBe('verified');
  });

  it('reissue revokes the old code; revoke and cancel end it; another business’s person is nobody here', async () => {
    const lab = await business();
    const other = await business();
    const made = await a.provisioning.createStaff(lab.companyId, { name: 'Codes', phone: phone(), role: 'store_employee', branchIds: [lab.branchId], verification: 'deferred_by_platform', deferral }, actor);
    const again = await a.provisioning.reissueCode(lab.companyId, made.user.id, actor);
    await expect(a.invitations.accept(made.setupCode.token, 'old-code-password', {})).rejects.toThrow('That invitation cannot be used.');
    expect((await a.provisioning.revokeCode(lab.companyId, made.user.id, actor)).revoked).toBe(true);
    await expect(a.invitations.accept(again.setupCode.token, 'revoked-code-pass', {})).rejects.toThrow('That invitation cannot be used.');

    await expect(a.provisioning.requireVerification(other.companyId, made.user.id, 'cross', actor)).rejects.toBeInstanceOf(NotFoundException);
    await expect(a.provisioning.cancelAccount(other.companyId, made.user.id, 'cross', actor)).rejects.toBeInstanceOf(NotFoundException);

    await a.provisioning.cancelAccount(lab.companyId, made.user.id, 'Left the business', actor);
    const row = await root.user.findUniqueOrThrow({ where: { id: hex(made.user.id) }, select: { deletedAt: true, isActive: true, phone: true } });
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(row).toMatchObject({ isActive: false, phone: null });
    expect((await root.phoneVerificationDeferral.findFirstOrThrow({ where: { userId: hex(made.user.id) } })).endReason).toBe('cancelled');
    // The Owner is never cancelled from here.
    const owner = await root.user.findFirstOrThrow({ where: { companyId: hex(lab.companyId) }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    expect(codeOf(await a.provisioning.cancelAccount(lab.companyId, binToUuid(owner.id), 'no', actor).catch((e: unknown) => e))).toBe('owner_not_cancellable');
  });

  it('the kill switch off refuses new deferrals and leaves existing ones identifiable, unverified and undeleted', async () => {
    const lab = await business();
    const made = await a.provisioning.createStaff(lab.companyId, { name: 'Kept', phone: phone(), role: 'store_employee', branchIds: [lab.branchId], verification: 'deferred_by_platform', deferral }, actor);
    flag.on = false;
    expect(a.provisioning.deferralAvailable).toBe(false);
    expect(codeOf(await a.provisioning.createStaff(lab.companyId, { name: 'New', phone: phone(), role: 'store_employee', branchIds: [lab.branchId], verification: 'deferred_by_platform', deferral }, actor).catch((e: unknown) => e))).toBe('deferral_disabled');
    const listed = await a.provisioning.listDeferred(lab.companyId);
    expect(listed.map((x) => x.userId)).toEqual([made.user.id]);
    expect(await root.user.findUniqueOrThrow({ where: { id: hex(made.user.id) }, select: { phoneVerification: true, deletedAt: true } })).toEqual({ phoneVerification: 'deferred_by_platform', deletedAt: null });
  });

  it('the audit holds every outcome with actor, business, role, stores and reason — and never a code or password', async () => {
    const lab = await business();
    const made = await a.provisioning.createStaff(lab.companyId, { name: 'Audited', phone: phone(), role: 'store_manager', branchIds: [lab.branchId], verification: 'deferred_by_platform', deferral }, actor);
    await a.invitations.accept(made.setupCode.token, 'audited-password-1', {});
    const rows = await root.platformAuditEvent.findMany({ where: { targetId: hex(lab.companyId) }, orderBy: { createdAt: 'asc' } });
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['account.create', 'account_setup_code.issue', 'account_setup_code.use']));
    const create = rows.find((r) => r.action === 'account.create')!;
    expect(create).toMatchObject({ actor: ADMIN.email, reason: deferral.reason });
    expect(create.afterJson).toMatchObject({ role: 'store_manager', phoneVerification: 'deferred_by_platform', outcome: 'created' });
    expect((create.afterJson as { stores: string[] }).stores).toHaveLength(1);
    const all = JSON.stringify(rows);
    expect(all).not.toContain(made.setupCode.token);
    expect(all).not.toContain('audited-password-1');
    // The tenant's own audit trail names the platform and the policy.
    const tenant = await root.auditLog.findFirstOrThrow({ where: { companyId: hex(lab.companyId), entityType: 'User', action: 'create' }, orderBy: { at: 'desc' } });
    expect(tenant.reason).toContain('WhatsApp verification deferred');
  });
});
