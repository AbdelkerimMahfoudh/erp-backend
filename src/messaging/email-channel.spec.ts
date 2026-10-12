import { composeEmail, createEmailChannel, maskEmail, ResendEmailChannel, type ResendConfig } from './email-channel';

/**
 * The email boundary (correction phase, 2026-10-12): approved text only, every failure classified, nothing
 * claimed that did not happen, and no provider connected without its credentials.
 */

const config: ResendConfig = { baseUrl: 'https://api.resend.test', apiKey: 're_test_key', from: 'Dukan ERP <no-reply@mail.dukan.test>', replyTo: '', timeoutMs: 1_000 };
const message = { to: 'owner@shop.mr', template: 'contact.verification' as const, language: 'fr' as const, variables: { code: '123456', ttlMinutes: '10' }, idempotencyKey: 'k-1' };

describe('composing an email from approved text', () => {
  it('fills the template in the asked language, naming the product and who runs it', () => {
    const { subject, text } = composeEmail(message);
    expect(subject).toBe('Votre code Dukan ERP');
    expect(text).toContain('123456');
    expect(text).toContain('Dukan ERP est développé et exploité par TSX-MR.');
  });

  it('refuses a missing, extra or empty variable, and a template held for a flow that does not exist', () => {
    expect(() => composeEmail({ ...message, variables: { code: '123456' } })).toThrow(/needs exactly/);
    expect(() => composeEmail({ ...message, variables: { code: '1', ttlMinutes: '10', extra: 'x' } })).toThrow(/needs exactly/);
    expect(() => composeEmail({ ...message, variables: { code: ' ', ttlMinutes: '10' } })).toThrow(/needs exactly/);
    for (const held of ['password.recovery', 'security.alert', 'staff.invitation'] as const) {
      expect(() => composeEmail({ ...message, template: held })).toThrow(/not wired/);
    }
  });
});

describe('the Resend adapter', () => {
  const answer = (status: number, body: unknown = {}) => jest.fn(async () => ({ status, json: async () => body }));

  it('sends the composed text with the key in a header, the idempotency key passed through, and records the id', async () => {
    const fetch = answer(200, { id: 'em_123' });
    const result = await new ResendEmailChannel(config, fetch as never).send(message);
    expect(result).toEqual({ status: 'accepted', providerMessageId: 'em_123', provider: 'resend' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe('https://api.resend.test/emails');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer re_test_key', 'Idempotency-Key': 'k-1' });
    expect(JSON.parse(init.body)).toMatchObject({ from: config.from, to: ['owner@shop.mr'], subject: 'Votre code Dukan ERP' });
  });

  it('classifies every failure, and never claims a send', async () => {
    const cases: [number, string][] = [
      [401, 'not_authorized'],
      [403, 'not_authorized'],
      [422, 'rejected'],
      [429, 'temporary'],
      [503, 'temporary'],
    ];
    for (const [status, reason] of cases) {
      await expect(new ResendEmailChannel(config, answer(status) as never).send(message)).resolves.toMatchObject({ status: 'failed', reason });
    }
    const unreachable = jest.fn(async () => Promise.reject(new Error('ECONNREFUSED')));
    await expect(new ResendEmailChannel(config, unreachable as never).send(message)).resolves.toMatchObject({ status: 'failed', reason: 'temporary' });
    const held = await new ResendEmailChannel(config, answer(200) as never).send({ ...message, template: 'password.recovery' });
    expect(held).toMatchObject({ status: 'failed', reason: 'rejected' });
  });
});

describe('choosing the channel', () => {
  it('disabled by default; the development log never in production; resend never without its key and sender', () => {
    expect(createEmailChannel({ channel: '', isProduction: true }).isEnabled).toBe(false);
    expect(createEmailChannel({ channel: 'development-log', isProduction: false }).name).toBe('development-log');
    expect(() => createEmailChannel({ channel: 'development-log', isProduction: true })).toThrow(/not permitted in production/);
    expect(() => createEmailChannel({ channel: 'resend', isProduction: false, resend: { ...config, apiKey: '' } })).toThrow(/RESEND_API_KEY and EMAIL_FROM/);
    expect(() => createEmailChannel({ channel: 'resend', isProduction: true, resend: { ...config, baseUrl: 'http://api.resend.test' } })).toThrow(/https/);
    expect(createEmailChannel({ channel: 'resend', isProduction: true, resend: config }).name).toBe('resend');
    expect(() => createEmailChannel({ channel: 'smtp', isProduction: false })).toThrow(/Unknown EMAIL_CHANNEL/);
  });

  it('a log line names a masked address, never the address', () => {
    expect(maskEmail('owner@shop.mr')).toBe('o***@shop.mr');
    expect(maskEmail('nonsense')).toBe('***');
  });
});
