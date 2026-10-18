import { composeEmail, createEmailChannel, maskEmail, ResendEmailChannel, type ResendConfig, type SubscriptionEmailKey } from './email-channel';
import { SUBSCRIPTION_TEMPLATES } from './templates';

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
    // D181: smtp exists now, and refuses to be built without its credentials.
    expect(() => createEmailChannel({ channel: 'smtp', isProduction: false })).toThrow(/SMTP_HOST, SMTP_USERNAME and SMTP_PASSWORD/);
    expect(() => createEmailChannel({ channel: 'postmark', isProduction: false })).toThrow(/Unknown EMAIL_CHANNEL/);
  });

  it('a log line names a masked address, never the address', () => {
    expect(maskEmail('owner@shop.mr')).toBe('o***@shop.mr');
    expect(maskEmail('nonsense')).toBe('***');
  });
});

describe('the portal instructions and the subscription messages (0099; docs/101 §7)', () => {
  const link = 'https://dukan.tsxmr.com/subscription';
  const LANGUAGES = ['en', 'fr', 'ar'] as const;
  const sample: Record<string, string> = {
    business: 'Boutique Aicha',
    remaining: '3 days',
    ends: '21 October 2026, 14:00 (Greenwich Mean Time)',
    ended: '21 October 2026, 14:00 (Greenwich Mean Time)',
    graceEnds: '24 October 2026, 14:00 (Greenwich Mean Time)',
    usesLeft: '2',
  };
  const keys = SUBSCRIPTION_TEMPLATES.map((t) => t.key as SubscriptionEmailKey);
  const compose = (template: SubscriptionEmailKey, language: (typeof LANGUAGES)[number]) => {
    const t = SUBSCRIPTION_TEMPLATES.find((x) => x.key === template)!;
    return composeEmail({ template, language, variables: { ...Object.fromEntries(t.variables.map((v) => [v, sample[v]])), link } });
  };

  it('exists for every WhatsApp template, takes its variables and the portal’s address, and says who runs Dukan ERP', () => {
    expect(keys).toHaveLength(8);
    for (const key of keys) {
      for (const language of LANGUAGES) {
        const { subject, text, html } = compose(key, language);
        expect({ key, language, links: text.split(link).length - 1, business: text.includes('Boutique Aicha') }).toEqual({ key, language, links: 1, business: true });
        expect(subject).not.toContain('{');
        expect(text).not.toMatch(/\{\w+\}/);
        expect(text).toMatch(/TSX-MR/);
        expect(html).toContain(`href="${link}"`);
      }
    }
  });

  it('pins the approved English instructions: eligible, not started, sign in on the portal, starts on confirming, exactly 7 days, no pause, no restart', () => {
    expect(compose('portal.instructions', 'en')).toMatchObject({
      subject: 'Start your Dukan ERP free trial',
      text:
        'Boutique Aicha can start one 7-day free trial of Dukan ERP. It has not started yet.\n\n' +
        `To start it, go to ${link}, sign in with the same details you use in the Dukan ERP app, and confirm.\n\n` +
        'The trial starts as soon as you confirm and lasts exactly 7 days (168 hours). It cannot be paused or restarted. ' +
        'No payment is required. If you did not create this account, ignore this email.\n\n' +
        'Need help? Contact Dukan ERP support.\n\n' +
        'Dukan ERP is developed and operated by TSX-MR.',
    });
    expect(compose('portal.instructions', 'fr').text).toContain('dure exactement 7 jours (168 heures). Il ne peut être ni mis en pause ni redémarré.');
    expect(compose('portal.instructions', 'ar').text).toContain('تستمر 7 أيام بالضبط (168 ساعة)، ولا يمكن إيقافها مؤقتًا أو إعادة بدئها');
  });

  it('names no price, no amount and no way to pay — the instructions’ one sentence about money says none is required', () => {
    const negation = { en: 'No payment is required.', fr: 'Aucun paiement n’est demandé.', ar: 'لا يلزم أي دفع.' };
    for (const key of keys) {
      for (const language of LANGUAGES) {
        // Placeholder-like values, so the words left are the template's own.
        const t = SUBSCRIPTION_TEMPLATES.find((x) => x.key === key)!;
        const { subject, text } = composeEmail({ template: key, language, variables: { ...Object.fromEntries(t.variables.map((v) => [v, `<${v}>`])), link } });
        let words = `${subject}\n${text}`.replace(link, '');
        for (const v of t.variables) words = words.split(`<${v}>`).join('');
        if (key === 'portal.instructions') {
          expect(words.includes(negation[language])).toBe(true);
          words = words.replace(negation[language], '');
        }
        expect({ key, language, money: words.match(/\bpay|paie|payer|دفع|سداد|price|prix|tarif|سعر|MRU|\bUM\b|ouguiya|أوقية|bankily|masrivi|sedad|virement|transfer|تحويل/gi) }).toEqual({ key, language, money: null });
        // The only numbers are the rules' own: 7 days, 168 hours, 72 hours, 3 grace periods in 12 months.
        expect({ key, language, other: [...new Set(words.match(/\d+/g) ?? [])].filter((n) => !['7', '168', '72', '3', '12'].includes(n)) }).toEqual({ key, language, other: [] });
      }
    }
  });

  it('never suggests grace for a free trial: its messages mention grace only to say there is none', () => {
    const none = { en: 'Free trials have no grace period', fr: 'Les essais gratuits n’ont pas de période de grâce', ar: 'لا توجد فترة سماح للفترات التجريبية المجانية' };
    for (const key of ['portal.instructions', 'subscription.trial_reminder', 'subscription.trial_expired'] as const) {
      for (const language of LANGUAGES) {
        const { subject, text } = compose(key, language);
        if (key !== 'portal.instructions') expect(text).toContain(none[language]);
        expect({ key, language, grace: `${subject}\n${text}`.replace(none[language], '').match(/grace|grâce|سماح/gi) }).toEqual({ key, language, grace: null });
      }
    }
  });

  it('tells a paid expiry with grace from one without: the exact end and the uses left, or the allowance used', () => {
    for (const language of LANGUAGES) {
      const started = compose('subscription.grace_started', language).text;
      expect(started).toContain(sample.graceEnds);
      expect(started).toMatch(/: 2\./);
      expect(started).toContain('72');
      const none = compose('subscription.no_grace', language).text;
      expect(none).not.toContain(sample.graceEnds);
      expect(none).toMatch(/12/);
    }
    expect(compose('subscription.no_grace', 'en').text).toContain('There is no grace period this time: this business has already used its 3 grace periods of the last 12 months.');
  });

  it('refuses anything but the template’s own variables and the link', () => {
    expect(() => composeEmail({ template: 'portal.instructions', language: 'en', variables: { business: 'B' } })).toThrow(/needs exactly: business, link/);
    expect(() => composeEmail({ template: 'portal.instructions', language: 'en', variables: { business: 'B', link, token: 't' } })).toThrow(/needs exactly/);
    expect(() => composeEmail({ template: 'subscription.no_grace', language: 'en', variables: { business: 'B', ended: ' ', link } })).toThrow(/needs exactly/);
  });
});
