import { FakePrisma } from '../account/testing/fake-prisma';
import { PlatformAdminService } from './platform-admin.service';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformMfaService } from './platform-mfa.service';
import { ADMIN_SETUP_CODE_TTL_MS, PlatformAdminInvitationService } from './platform-admin-invitation.service';
import { stepAt, totpForStep } from './mfa/totp';

/**
 * A second platform administrator, invited (0115), end to end against an in-memory database: the existing
 * administrator is never touched; the invited account signs in to nothing until its code is spent, then to the
 * enrolment routes only, and becomes active only with its own authenticator; every refusal is the same refusal; no
 * code, password, secret or recovery code reaches the database or an audit row.
 */
const KEY = Buffer.alloc(32, 7).toString('base64');
const EXISTING = Buffer.alloc(16, 1);
const T0 = new Date('2026-11-01T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const NEW_EMAIL = 'MedMahmoud@tsxmr.com';
const PASSWORD = 'his-own-long-password';

function harness() {
  const prisma = new FakePrisma();
  const config = { platformMfaKey: KEY };
  const hashing = {
    hash: async (plain: string) => `hash:${plain}`,
    verify: async (hash: string, plain: string) => hash === `hash:${plain}`,
    verifyDummy: async () => false,
  };
  const audit = new PlatformAuditService(prisma as never);
  const mfa = new PlatformMfaService(prisma as never, config as never, audit, hashing as never);
  const admins = new PlatformAdminService(prisma as never, hashing as never);
  admins.useStepUpCheck(mfa);
  const invitations = new PlatformAdminInvitationService(prisma as never, config as never, hashing as never, audit);
  const existing = {
    id: EXISTING,
    email: 'owner-admin@tsx.mr',
    name: 'Existing',
    passwordHash: 'hash:existing-pw',
    adminState: 'active',
    setupCodeHash: null,
    setupCodeExpiresAt: null,
    isActive: true,
    deletedAt: null,
    lastLoginAt: null,
    mfaSecretEnc: 'sealed-secret',
    mfaEnabledAt: T0,
    mfaLastStep: null,
    mfaPendingSecretEnc: null,
    mfaEnrolmentTokenHash: null,
    mfaEnrolmentExpiresAt: null,
    mfaFailedCount: 0,
    mfaLockedUntil: null,
  };
  prisma.seed('platformAdmin', { ...existing });
  const existingRow = () => JSON.stringify(prisma.rows('platformAdmin').find((r) => (r.id as Buffer).equals(EXISTING)));
  const invited = () => prisma.rows('platformAdmin').find((r) => r.email === 'medmahmoud@tsxmr.com')!;
  const auditText = () => JSON.stringify(prisma.rows('platformAuditEvent'));
  const actions = () => prisma.rows('platformAuditEvent').map((r) => r.action);
  // Defaults the database gives every row the fake does not: the platformAdmin columns `create` leaves out.
  const issue = async () => {
    const issued = await invitations.issue({ email: NEW_EMAIL, name: 'Mohamed Mahmoud' }, T0);
    Object.assign(invited(), { isActive: true, deletedAt: null, lastLoginAt: null, mfaSecretEnc: null, mfaEnabledAt: null, mfaLastStep: null, mfaPendingSecretEnc: null, mfaEnrolmentTokenHash: null, mfaEnrolmentExpiresAt: null, mfaFailedCount: 0, mfaLockedUntil: null });
    return issued;
  };
  return { prisma, mfa, admins, invitations, existingRow, invited, auditText, actions, issue };
}

const refused = { response: { code: 'admin_setup_refused' } };

describe('inviting never touches anybody else', () => {
  it('creates one invited account; the existing administrator is byte-for-byte unchanged', async () => {
    const h = harness();
    const before = h.existingRow();
    const issued = await h.issue();
    expect(h.invited()).toMatchObject({ email: 'medmahmoud@tsxmr.com', adminState: 'invited' });
    expect(h.invited().setupCodeExpiresAt).toEqual(at(ADMIN_SETUP_CODE_TTL_MS));
    expect(issued.code.length).toBeGreaterThanOrEqual(32);
    expect(h.existingRow()).toBe(before);
  });

  it('refuses an address that exists in any state — active, invited, deleted — and changes nothing', async () => {
    const h = harness();
    await expect(h.invitations.issue({ email: 'Owner-Admin@tsx.mr', name: 'X' }, T0)).rejects.toThrow(/already exists/);
    await h.issue();
    await expect(h.invitations.issue({ email: NEW_EMAIL, name: 'Again' }, T0)).rejects.toThrow(/already exists/);
    h.invited().deletedAt = T0;
    await expect(h.invitations.issue({ email: NEW_EMAIL, name: 'Again' }, T0)).rejects.toThrow(/already exists/);
    expect(h.prisma.rows('platformAdmin')).toHaveLength(2);
  });

  it('resume and revoke refuse an active administrator: nobody is reset or signed out', async () => {
    const h = harness();
    const before = h.existingRow();
    await expect(h.invitations.resume('owner-admin@tsx.mr', T0)).rejects.toThrow(/never reset/);
    await expect(h.invitations.revoke('owner-admin@tsx.mr', T0)).rejects.toThrow(/never revoked/);
    expect(h.existingRow()).toBe(before);
  });

  it('the database keeps a keyed digest of the code, never the code', async () => {
    const h = harness();
    const { code } = await h.issue();
    expect(JSON.stringify(h.prisma.rows('platformAdmin'))).not.toContain(code);
    expect(h.invited().setupCodeHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('an invited account opens nothing until it is active', () => {
  it('invited: no sign-in at all, whatever the password', async () => {
    const h = harness();
    await h.issue();
    await expect(h.admins.signIn(NEW_EMAIL, PASSWORD, {})).rejects.toThrow('Invalid credentials');
  });

  it('enrolling: the new password opens a pending session that resolves to no administrator', async () => {
    const h = harness();
    const { code } = await h.issue();
    await h.invitations.redeem({ email: NEW_EMAIL, code, password: PASSWORD }, null, at(1000));
    expect(h.invited().adminState).toBe('enrolling');
    const s = await h.admins.signIn(NEW_EMAIL, PASSWORD, {});
    expect(s.mfa).toBe('enrolment_required');
    const session = (await h.admins.resolveSession(s.sessionToken))!;
    expect(session).toMatchObject({ mfaVerified: false, state: 'enrolling' });
    await expect(h.admins.resolve(s.sessionToken)).resolves.toBeNull();
  });

  it('active only with its own authenticator, in the same transaction; recovery codes to him alone', async () => {
    const h = harness();
    const { code } = await h.issue();
    const { enrolmentToken } = await h.invitations.redeem({ email: NEW_EMAIL, code, password: PASSWORD }, null, at(1000));
    const s = await h.admins.signIn(NEW_EMAIL, PASSWORD, {});
    const session = (await h.admins.resolveSession(s.sessionToken))!;
    const { secret } = await h.mfa.startEnrolment(session.admin, enrolmentToken, null, at(2000));
    const { recoveryCodes } = await h.mfa.confirmEnrolment(session.admin, session.sessionId, totpForStep(secret, stepAt(at(2000).getTime())), null, at(2000));
    expect(h.invited().adminState).toBe('active');
    expect((await h.admins.resolveSession(s.sessionToken))!.mfaVerified).toBe(true);
    expect(recoveryCodes.length).toBeGreaterThan(0);
    for (const secretValue of [code, PASSWORD, enrolmentToken, secret, ...recoveryCodes]) expect(h.auditText()).not.toContain(secretValue);
    expect(h.actions()).toEqual(expect.arrayContaining(['admin.invitation.issued', 'admin.invitation.used', 'admin.invitation.activated']));
  });

  it('an abandoned enrolment leaves him unable to reach anything, and resume starts again without touching anybody', async () => {
    const h = harness();
    const before = h.existingRow();
    const { code } = await h.issue();
    const { enrolmentToken } = await h.invitations.redeem({ email: NEW_EMAIL, code, password: PASSWORD }, null, at(1000));
    const s = await h.admins.signIn(NEW_EMAIL, PASSWORD, {});
    const session = (await h.admins.resolveSession(s.sessionToken))!;
    // The 30-minute enrolment token has run out: it opens nothing.
    await expect(h.mfa.startEnrolment(session.admin, enrolmentToken, null, at(31 * 60 * 1000))).rejects.toMatchObject({ response: { code: 'enrolment_token_invalid' } });
    const again = await h.invitations.resume(NEW_EMAIL, at(40 * 60 * 1000));
    expect(h.invited().adminState).toBe('invited');
    await expect(h.admins.resolveSession(s.sessionToken)).resolves.toBeNull();
    await expect(h.admins.signIn(NEW_EMAIL, PASSWORD, {})).rejects.toThrow('Invalid credentials');
    await expect(h.invitations.redeem({ email: NEW_EMAIL, code, password: PASSWORD }, null, at(41 * 60 * 1000))).rejects.toMatchObject(refused);
    await h.invitations.redeem({ email: NEW_EMAIL, code: again.code, password: PASSWORD }, null, at(41 * 60 * 1000));
    expect(h.invited().adminState).toBe('enrolling');
    expect(h.existingRow()).toBe(before);
  });
});

describe('the setup code', () => {
  it('is single use: spent once, refused after, the same refusal', async () => {
    const h = harness();
    const { code } = await h.issue();
    await h.invitations.redeem({ email: NEW_EMAIL, code, password: PASSWORD }, null, at(1000));
    await expect(h.invitations.redeem({ email: NEW_EMAIL, code, password: 'another-long-password' }, null, at(2000))).rejects.toMatchObject(refused);
    expect(h.invited().passwordHash).toBe(`hash:${PASSWORD}`);
  });

  it('expires after 24 hours', async () => {
    const h = harness();
    const { code } = await h.issue();
    await expect(h.invitations.redeem({ email: NEW_EMAIL, code, password: PASSWORD }, null, at(ADMIN_SETUP_CODE_TTL_MS + 1))).rejects.toMatchObject(refused);
    expect(h.invited().adminState).toBe('invited');
    expect(h.actions()).toContain('admin.invitation.expired');
  });

  it('is void once revoked; the account is disabled and deleted', async () => {
    const h = harness();
    const { code } = await h.issue();
    await h.invitations.revoke(NEW_EMAIL, at(1000));
    await expect(h.invitations.redeem({ email: NEW_EMAIL, code, password: PASSWORD }, null, at(2000))).rejects.toMatchObject(refused);
    expect(h.invited()).toMatchObject({ isActive: false, setupCodeHash: null });
    expect(h.invited().deletedAt).toEqual(at(1000));
  });

  it('one refusal for an unknown address, a wrong code, a short password and an active administrator', async () => {
    const h = harness();
    const { code } = await h.issue();
    const tries = [
      { email: 'nobody@tsxmr.com', code, password: PASSWORD },
      { email: NEW_EMAIL, code: 'x'.repeat(32), password: PASSWORD },
      { email: NEW_EMAIL, code, password: 'short' },
      { email: 'owner-admin@tsx.mr', code, password: PASSWORD },
    ];
    for (const t of tries) await expect(h.invitations.redeem(t, null, at(1000))).rejects.toMatchObject(refused);
    expect(h.invited().adminState).toBe('invited');
  });

  it('status tells the handover sweep whether the file is still needed', async () => {
    const h = harness();
    const { adminId, code } = await h.issue();
    await expect(h.invitations.status(adminId, at(1000))).resolves.toBe('pending');
    await expect(h.invitations.status(adminId, at(ADMIN_SETUP_CODE_TTL_MS + 1))).resolves.toBe('done');
    await h.invitations.redeem({ email: NEW_EMAIL, code, password: PASSWORD }, null, at(1000));
    await expect(h.invitations.status(adminId, at(2000))).resolves.toBe('done');
    await expect(h.invitations.status('not-an-id', at(2000))).resolves.toBe('done');
  });
});
