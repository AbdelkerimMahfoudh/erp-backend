import { FakePrisma } from '../account/testing/fake-prisma';
import { PlatformAdminService } from './platform-admin.service';
import { PlatformAuditService } from './platform-audit.service';
import { MFA_MAX_FAILURES, PlatformMfaService, STEP_UP_TTL_MS } from './platform-mfa.service';
import { stepAt, totpForStep } from './mfa/totp';

/**
 * Mandatory TOTP for platform administrators (0094), end to end against an in-memory database: sign-in, the
 * pending session, enrolment with the server's token, verification, replay, the lock, recovery codes, step-up
 * and the reset — and that no secret, code or token reaches an audit row.
 */

const KEY = Buffer.alloc(32, 3).toString('base64');
const ADMIN = Buffer.alloc(16, 1);
const OTHER = Buffer.alloc(16, 2);
const T0 = new Date('2026-10-12T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

function harness() {
  const prisma = new FakePrisma();
  const config = { platformMfaKey: KEY };
  const hashing = { verify: async (hash: string, plain: string) => hash === `hash:${plain}`, verifyDummy: async () => false };
  const cls = new Map<string, unknown>();
  const audit = new PlatformAuditService(prisma as never);
  const mfa = new PlatformMfaService(prisma as never, config as never, audit, hashing as never);
  const admins = new PlatformAdminService(prisma as never, hashing as never, { get: (k: string) => cls.get(k) } as never);
  admins.useStepUpCheck(mfa);
  const blank = { passwordHash: 'hash:admin-pw', isActive: true, deletedAt: null, lastLoginAt: null, mfaSecretEnc: null, mfaEnabledAt: null, mfaLastStep: null, mfaPendingSecretEnc: null, mfaEnrolmentTokenHash: null, mfaEnrolmentExpiresAt: null, mfaFailedCount: 0, mfaLockedUntil: null };
  prisma.seed('platformAdmin', { id: ADMIN, email: 'ops@tsx.mr', name: 'Ops', ...blank }, { id: OTHER, email: 'other@tsx.mr', name: 'Other', ...blank });
  const identity = { id: ADMIN, email: 'ops@tsx.mr', name: 'Ops' };
  const session = async (token: string) => (await admins.resolveSession(token))!;
  const signIn = async () => {
    const r = await admins.signIn('ops@tsx.mr', 'admin-pw', {});
    return { ...r, s: await session(r.sessionToken) };
  };
  /** Sign in, enrol with a server token, and return the secret — what every later test starts from. */
  const enrolled = async () => {
    const { token } = await mfa.issueEnrolmentToken('ops@tsx.mr', T0);
    const first = await signIn();
    const { secret } = await mfa.startEnrolment(identity, token, null, T0);
    const { recoveryCodes } = await mfa.confirmEnrolment(identity, first.s.sessionId, totpForStep(secret, stepAt(T0.getTime())), null, T0);
    return { secret, recoveryCodes, first };
  };
  const code = (secret: string, when: Date) => totpForStep(secret, stepAt(when.getTime()));
  const row = () => prisma.rows('platformAdmin').find((r) => (r.id as Buffer).equals(ADMIN))!;
  return { prisma, mfa, admins, cls, identity, session, signIn, enrolled, code, row };
}

describe('a password opens a pending session — never the platform (0094)', () => {
  it('sign-in says what the session still needs; the session resolves to no administrator until then', async () => {
    const h = harness();
    const r = await h.admins.signIn('ops@tsx.mr', 'admin-pw', {});
    expect(r.mfa).toBe('enrolment_required');
    expect((await h.admins.resolveSession(r.sessionToken))!.mfaVerified).toBe(false);
    await expect(h.admins.resolve(r.sessionToken)).resolves.toBeNull();
  });

  it('a password alone cannot enrol: without the server’s token there is no secret to bind', async () => {
    const h = harness();
    await h.signIn();
    await expect(h.mfa.startEnrolment(h.identity, 'a-token-nobody-issued-at-all', null, T0)).rejects.toMatchObject({ response: { code: 'enrolment_token_invalid' } });
    // Nor another administrator's token, nor an expired one.
    const other = await h.mfa.issueEnrolmentToken('other@tsx.mr', T0);
    await expect(h.mfa.startEnrolment(h.identity, other.token, null, T0)).rejects.toMatchObject({ response: { code: 'enrolment_token_invalid' } });
    const mine = await h.mfa.issueEnrolmentToken('ops@tsx.mr', T0);
    await expect(h.mfa.startEnrolment(h.identity, mine.token, null, at(31 * 60_000))).rejects.toMatchObject({ response: { code: 'enrolment_token_invalid' } });
    expect(h.row().mfaPendingSecretEnc).toBeNull();
  });
});

describe('enrolment', () => {
  it('is confirmed by the first code before it counts; the secret is sealed; ten recovery codes are shown once', async () => {
    const h = harness();
    const { token } = await h.mfa.issueEnrolmentToken('ops@tsx.mr', T0);
    const { s, sessionToken } = await h.signIn();
    const { secret, otpauthUri } = await h.mfa.startEnrolment(h.identity, token, null, T0);
    expect(otpauthUri).toContain(`secret=${secret}`);
    expect(h.row().mfaEnabledAt).toBeNull();
    expect(h.row().mfaPendingSecretEnc).not.toContain(secret);
    await expect(h.mfa.confirmEnrolment(h.identity, s.sessionId, '000000' === h.code(secret, T0) ? '111111' : '000000', null, T0)).rejects.toMatchObject({ response: { code: 'mfa_code_invalid' } });
    const { recoveryCodes } = await h.mfa.confirmEnrolment(h.identity, s.sessionId, h.code(secret, T0), null, T0);
    expect(recoveryCodes).toHaveLength(10);
    expect(h.row()).toMatchObject({ mfaEnabledAt: T0, mfaPendingSecretEnc: null, mfaEnrolmentTokenHash: null });
    expect(String(h.row().mfaSecretEnc)).toMatch(/^v1:/);
    expect(String(h.row().mfaSecretEnc)).not.toContain(secret);
    expect(h.prisma.rows('platformAdminRecoveryCode').every((c) => !recoveryCodes.some((code) => String(c.codeHash).includes(code.replace('-', ''))))).toBe(true);
    // This session is now verified: it resolves to the administrator.
    await expect(h.admins.resolve(sessionToken)).resolves.toMatchObject({ email: 'ops@tsx.mr' });
    expect(h.prisma.rows('platformAdminSession').find((x) => (x.id as Buffer).equals(s.sessionId))!.mfaVerifiedAt).toEqual(T0);
  });
});

describe('completing a sign-in', () => {
  it('a code from the authenticator verifies the session; the same code again is a replay', async () => {
    const h = harness();
    const { secret } = await h.enrolled();
    const later = at(60_000);
    const second = await h.signIn();
    expect(second.mfa).toBe('required');
    await h.mfa.verify(h.identity, second.s.sessionId, { code: h.code(secret, later) }, '10.0.0.1', later);
    await expect(h.admins.resolve(second.sessionToken)).resolves.toMatchObject({ email: 'ops@tsx.mr' });
    const third = await h.signIn();
    await expect(h.mfa.verify(h.identity, third.s.sessionId, { code: h.code(secret, later) }, null, later)).rejects.toMatchObject({ response: { code: 'mfa_code_invalid' } });
    await expect(h.admins.resolve(third.sessionToken)).resolves.toBeNull();
  });

  it(`${MFA_MAX_FAILURES} wrong codes lock the factor — even the right code then waits — and every failure is audited`, async () => {
    const h = harness();
    const { secret } = await h.enrolled();
    const { s } = await h.signIn();
    const when = at(5 * 60_000);
    for (let i = 0; i < MFA_MAX_FAILURES; i++) {
      await expect(h.mfa.verify(h.identity, s.sessionId, { code: '000000' === h.code(secret, when) ? '111111' : '000000' }, null, when)).rejects.toMatchObject({ response: { code: 'mfa_code_invalid' } });
    }
    await expect(h.mfa.verify(h.identity, s.sessionId, { code: h.code(secret, when) }, null, when)).rejects.toMatchObject({ response: { code: 'mfa_locked' } });
    const actions = h.prisma.rows('platformAuditEvent').map((e) => e.action);
    expect(actions.filter((a) => a === 'admin.mfa.failed')).toHaveLength(MFA_MAX_FAILURES - 1);
    expect(actions).toContain('admin.mfa.locked');
    // Fifteen minutes later the right code works again.
    const after = at(21 * 60_000);
    await expect(h.mfa.verify(h.identity, s.sessionId, { code: h.code(secret, after) }, null, after)).resolves.toBeUndefined();
  });

  it('a recovery code works once; a used one, or one from an older set, never again', async () => {
    const h = harness();
    const { recoveryCodes } = await h.enrolled();
    const a = await h.signIn();
    await h.mfa.verify(h.identity, a.s.sessionId, { recoveryCode: recoveryCodes[0].toLowerCase() }, null, at(60_000));
    expect(h.prisma.rows('platformAuditEvent').some((e) => e.action === 'admin.mfa.recovery_used')).toBe(true);
    const b = await h.signIn();
    await expect(h.mfa.verify(h.identity, b.s.sessionId, { recoveryCode: recoveryCodes[0] }, null, at(60_000))).rejects.toMatchObject({ response: { code: 'recovery_code_invalid' } });
  });
});

describe('step-up: the password and a fresh code, on this session, for five minutes', () => {
  it('a high-impact action refuses a password alone; after a step-up it runs; five minutes later it refuses again', async () => {
    const h = harness();
    const { secret, first } = await h.enrolled();
    h.cls.set('platformSessionId', first.s.sessionId);
    await expect(h.admins.confirmPassword(ADMIN, 'admin-pw')).rejects.toMatchObject({ response: { code: 'step_up_required' } });
    const now = new Date();
    await expect(h.mfa.stepUp(h.identity, first.s.sessionId, 'wrong-pw', h.code(secret, now), null, now)).rejects.toMatchObject({ response: { code: 'step_up_failed' } });
    await h.mfa.stepUp(h.identity, first.s.sessionId, 'admin-pw', h.code(secret, now), null, now);
    await expect(h.admins.confirmPassword(ADMIN, 'admin-pw')).resolves.toBeUndefined();
    // The existing password check stays: a step-up does not excuse a wrong password.
    await expect(h.admins.confirmPassword(ADMIN, 'wrong-pw')).rejects.toMatchObject({ response: { code: 'password_confirmation_failed' } });
    await expect(h.mfa.assertFreshStepUp(first.s.sessionId, new Date(now.getTime() + STEP_UP_TTL_MS + 1))).rejects.toMatchObject({ response: { code: 'step_up_required' } });
    // Bound to the session: another session of the same administrator holds no step-up.
    const other = await h.signIn();
    await expect(h.mfa.assertFreshStepUp(other.s.sessionId, now)).rejects.toMatchObject({ response: { code: 'step_up_required' } });
  });

  it('new recovery codes need a fresh step-up, and revoke the old set', async () => {
    const h = harness();
    const { secret, recoveryCodes, first } = await h.enrolled();
    await expect(h.mfa.regenerateRecoveryCodes(h.identity, first.s.sessionId, null)).rejects.toMatchObject({ response: { code: 'step_up_required' } });
    const now = new Date();
    await h.mfa.stepUp(h.identity, first.s.sessionId, 'admin-pw', h.code(secret, now), null, now);
    const fresh = await h.mfa.regenerateRecoveryCodes(h.identity, first.s.sessionId, null, now);
    expect(fresh.recoveryCodes).toHaveLength(10);
    const b = await h.signIn();
    await expect(h.mfa.verify(h.identity, b.s.sessionId, { recoveryCode: recoveryCodes[1] }, null, now)).rejects.toMatchObject({ response: { code: 'recovery_code_invalid' } });
    await expect(h.mfa.verify(h.identity, b.s.sessionId, { recoveryCode: fresh.recoveryCodes[0] }, null, now)).resolves.toBeUndefined();
  });
});

describe('a reset, from the server only', () => {
  it('voids the factor, every session and every recovery code; the administrator must enrol again', async () => {
    const h = harness();
    const { first } = await h.enrolled();
    const later = at(60 * 60_000);
    await h.mfa.issueEnrolmentToken('ops@tsx.mr', later);
    await expect(h.admins.resolve(first.sessionToken)).resolves.toBeNull();
    expect(h.row()).toMatchObject({ mfaSecretEnc: null, mfaEnabledAt: null });
    expect(h.prisma.rows('platformAdminRecoveryCode').every((c) => c.revokedAt !== null || c.usedAt !== null)).toBe(true);
    expect((await h.signIn()).mfa).toBe('enrolment_required');
    expect(h.prisma.rows('platformAuditEvent').find((e) => e.action === 'admin.mfa.reset')).toMatchObject({ actor: 'cli' });
  });

  it('nothing administrative opens without the sealing key', async () => {
    const h = harness();
    const keyless = new PlatformMfaService(h.prisma as never, { platformMfaKey: '' } as never, new PlatformAuditService(h.prisma as never), {} as never);
    await expect(keyless.issueEnrolmentToken('ops@tsx.mr')).rejects.toMatchObject({ response: { code: 'mfa_unavailable' } });
  });
});

describe('what the audit keeps', () => {
  it('enrolment, verification, failures and step-ups are recorded — never a secret, a code, a recovery code or a token', async () => {
    const h = harness();
    const { secret, recoveryCodes, first } = await h.enrolled();
    const now = new Date();
    await h.mfa.stepUp(h.identity, first.s.sessionId, 'admin-pw', h.code(secret, now), null, now);
    const audit = JSON.stringify(h.prisma.rows('platformAuditEvent'));
    for (const action of ['admin.mfa.reset', 'admin.mfa.enrolment_started', 'admin.mfa.enrolled', 'admin.step_up']) expect(audit).toContain(action);
    expect(audit).not.toContain(secret);
    for (const c of recoveryCodes) expect(audit).not.toContain(c);
    expect(audit).not.toContain(h.code(secret, now));
  });
});

describe('the lock and the replay guard hold under concurrency (BE1-03)', () => {
  it(`a burst of wrong codes compares no more than ${MFA_MAX_FAILURES}, counts every one, and locks the factor`, async () => {
    const h = harness();
    const { secret } = await h.enrolled();
    const { s } = await h.signIn();
    const when = at(5 * 60_000);
    const right = h.code(secret, when);
    const wrong = (i: number) => String((Number(right) + 7 + i * 13) % 1_000_000).padStart(6, '0');
    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => h.mfa.verify(h.identity, s.sessionId, { code: wrong(i) }, null, when)));
    const codes = outcomes.map((o) => (o as PromiseRejectedResult).reason?.response?.code);
    expect(codes.filter((c) => c === 'mfa_code_invalid')).toHaveLength(MFA_MAX_FAILURES);
    expect(codes.filter((c) => c === 'mfa_locked')).toHaveLength(10 - MFA_MAX_FAILURES);
    expect(h.row().mfaLockedUntil).toBeInstanceOf(Date);
    // Locked: the right code now waits too.
    await expect(h.mfa.verify(h.identity, s.sessionId, { code: right }, null, when)).rejects.toMatchObject({ response: { code: 'mfa_locked' } });
    expect(h.prisma.rows('platformAuditEvent').filter((e) => e.action === 'admin.mfa.locked')).toHaveLength(1);
  });

  it('one code presented by two sessions at once verifies exactly one of them', async () => {
    const h = harness();
    const { secret } = await h.enrolled();
    const later = at(60_000);
    const a = await h.signIn();
    const b = await h.signIn();
    const outcomes = await Promise.allSettled([a, b].map((x) => h.mfa.verify(h.identity, x.s.sessionId, { code: h.code(secret, later) }, null, later)));
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const verified = await Promise.all([a, b].map((x) => h.admins.resolve(x.sessionToken)));
    expect(verified.filter((v) => v !== null)).toHaveLength(1);
  });

  it('a step-up and a sign-in racing with one code: exactly one is honoured', async () => {
    const h = harness();
    const { secret, first } = await h.enrolled();
    const later = at(60_000);
    const b = await h.signIn();
    const code = h.code(secret, later);
    const outcomes = await Promise.allSettled([
      h.mfa.stepUp(h.identity, first.s.sessionId, 'admin-pw', code, null, later),
      h.mfa.verify(h.identity, b.s.sessionId, { code }, null, later),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  });
});
