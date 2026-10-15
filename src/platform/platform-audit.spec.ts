import { PlatformAuditService, redact } from './platform-audit.service';

/**
 * What may never reach the platform audit log.
 *
 * An audit log is exactly the place a careless spread of a request body goes
 * unnoticed for a long time: the record looks fine, and the password is three
 * levels down inside it. So the redaction is tested directly rather than
 * trusted to callers being careful.
 */
describe('the audit log never keeps a secret', () => {
  it('drops a password at the top level', () => {
    expect(redact({ reason: 'testing', password: 'hunter2' })).toEqual({
      reason: 'testing',
      password: '[redacted]',
    });
  });

  it('drops one buried several levels down', () => {
    const out = redact({
      action: 'suspend',
      request: { body: { admin: { confirmPassword: 'hunter2', email: 'a@b.mr' } } },
    }) as Record<string, never>;
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(JSON.stringify(out)).toContain('a@b.mr');
  });

  it('drops every credential shape, whatever it is called', () => {
    const out = JSON.stringify(
      redact({
        password: 'p',
        currentPassword: 'p',
        confirmPassword: 'p',
        passwordHash: 'p',
        token: 'p',
        sessionToken: 'p',
        accessToken: 'p',
        refreshToken: 'p',
        refreshTokenHash: 'p',
        code: 'p',
        codeHash: 'p',
        verificationCode: 'p',
        secret: 'p',
        deviceSecret: 'p',
        recoveryCode: 'p',
        recoveryCodes: ['p'],
        enrolmentToken: 'p',
        continuation: 'p',
        pin: 'p',
      }),
    );
    expect(out).not.toContain('"p"');
  });

  it('ignores case, because a caller will eventually use a different one', () => {
    const out = redact({ PassWord: 'hunter2' }) as Record<string, unknown>;
    expect(out.PassWord).toBe('[redacted]');
  });

  it('walks arrays too', () => {
    const out = JSON.stringify(redact({ attempts: [{ password: 'a' }, { password: 'b' }] }));
    expect(out).not.toContain('"a"');
    expect(out).not.toContain('"b"');
  });

  it('keeps everything that is not a secret', () => {
    // A log that redacted too much would be useless, which is its own failure.
    const out = redact({
      status: 'suspended',
      periodEnd: '2026-01-01T00:00:00.000Z',
      version: 3,
      reason: 'non-payment',
    });
    expect(out).toEqual({
      status: 'suspended',
      periodEnd: '2026-01-01T00:00:00.000Z',
      version: 3,
      reason: 'non-payment',
    });
  });

  it('stops rather than recursing forever on a deep structure', () => {
    let deep: Record<string, unknown> = { password: 'x' };
    for (let i = 0; i < 40; i++) deep = { nested: deep };
    expect(() => redact(deep)).not.toThrow();
  });
});

describe('a record written inside the caller’s transaction (0095)', () => {
  it('goes through the client it is given, stamped with the instant it is given', async () => {
    const own: Record<string, unknown>[] = [];
    const inTx: Record<string, unknown>[] = [];
    const service = new PlatformAuditService({ platformAuditEvent: { create: async ({ data }: never) => own.push(data) } } as never);
    const tx = { platformAuditEvent: { create: async ({ data }: { data: Record<string, unknown> }) => inTx.push(data) } };
    const at = new Date('2026-10-13T10:00:00.123Z');

    await service.record({ admin: null, actor: 'user:x', action: 'trial.claim', targetType: 'Company', after: { token: 't' }, at }, tx as never);
    expect(own).toHaveLength(0);
    expect(inTx).toEqual([expect.objectContaining({ actor: 'user:x', action: 'trial.claim', createdAt: at, afterJson: { token: '[redacted]' } })]);

    // Without either, the service's own client and the column's default — exactly as before.
    await service.record({ admin: null, action: 'x', targetType: 'Company' });
    expect(own).toEqual([expect.objectContaining({ action: 'x', actor: 'system', createdAt: undefined })]);
  });
});
