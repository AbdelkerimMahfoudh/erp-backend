import { composeEmail, senderFor } from './email-channel';
import { EMAIL_PROOF_REPLY_TO, EMAIL_PROOF_SENDER, emailProofConfig, proofReference, readProofRecipient } from './email-delivery-proof';
import { SmtpEmailChannel, smtpTransportOptions, type SmtpTransport } from './smtp-email-channel';
import type { MessageLanguage } from './whatsapp-channel';

/**
 * The operator's SMTP delivery proof (D200): what it sends, to whom, from whom, and what it may log. The message is
 * the reviewed `delivery.check` template, so these pin its content as much as the proof's own rules.
 */
const LANGUAGES: MessageLanguage[] = ['en', 'fr', 'ar'];

describe('the delivery.check email', () => {
  it.each(LANGUAGES)('says what it is and that nothing is required, with no code, link, image or data (%s)', (language) => {
    const { subject, text, html } = composeEmail({ template: 'delivery.check', language, variables: {} });
    expect(subject).toMatch(/Dukan ERP/);
    expect(text).toMatch({ en: /delivery test\. No action is required/, fr: /test de distribution .* Aucune action n’est requise/, ar: /اختبار إيصال .* لا يلزم القيام بأي إجراء/ }[language]);
    // No code: no run of digits at all. No link, no address, no remote content, no tracking of ours.
    expect(text).not.toMatch(/\d{3,}/);
    expect(`${text}\n${html}`).not.toMatch(/https?:|www\.|@|<a\b|<img\b|src=|url\(/i);
  });

  it('takes no variable, so nothing from a customer or a business can ever be put into it', () => {
    expect(() => composeEmail({ template: 'delivery.check', language: 'en', variables: { business: 'x' } })).toThrow(/needs exactly/);
  });

  it('comes from the verification sender', () => {
    expect(senderFor('delivery.check', { verification: EMAIL_PROOF_SENDER, notifications: 'n@tsxmr.com', reports: '', receipts: '', fallback: 'f@tsxmr.com' })).toBe(EMAIL_PROOF_SENDER);
  });
});

describe('readProofRecipient', () => {
  it('reads the one address, whatever its case and surrounding whitespace', () => {
    expect(readProofRecipient('  Someone.Test@Example.com \n')).toBe('someone.test@example.com');
  });

  it.each([
    ['an empty file', ''],
    ['two addresses on two lines', 'a@example.com\nb@example.com\n'],
    ['two addresses on one line', 'a@example.com, b@example.com'],
    ['a display name', 'Someone <a@example.com>'],
    ['no domain', 'someone@'],
    ['no address at all', 'not an address'],
  ])('refuses %s', (_label, content) => {
    expect(() => readProofRecipient(content)).toThrow();
  });
});

describe('proofReference', () => {
  it('is a short one-way reference, stable for one id and different for another', () => {
    const id = '<202610181030.123456789@smtp-relay.mailin.fr>';
    const ref = proofReference(id);
    expect(ref).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(ref).not.toContain('smtp-relay');
    expect(proofReference(id)).toBe(ref);
    expect(proofReference(`${id}x`)).not.toBe(ref);
    expect(proofReference(null)).toBe('none');
  });
});

describe('emailProofConfig', () => {
  const ENV = { SMTP_HOST: 'smtp-relay.brevo.com', SMTP_PORT: '587', SMTP_USERNAME: 'login@smtp-brevo.com', SMTP_PASSWORD: 'k' };

  it('uses the approved sender and Reply-To whatever the environment says', () => {
    const cfg = emailProofConfig({ ...ENV, EMAIL_FROM_VERIFICATION: 'someone@else.example', EMAIL_REPLY_TO: 'x@else.example' });
    expect(cfg.senders.verification).toBe('Dukan ERP <verification@tsxmr.com>');
    expect(cfg.replyTo).toBe(EMAIL_PROOF_REPLY_TO);
    expect(EMAIL_PROOF_REPLY_TO).toBe('support@tsxmr.com');
  });

  it('runs on 587 with STARTTLS required and the transport\'s debug logging off', () => {
    const options = smtpTransportOptions(emailProofConfig(ENV));
    expect(options).toMatchObject({ port: 587, secure: false, requireTLS: true, ignoreTLS: false, logger: false, debug: false });
    expect(options.tls).toMatchObject({ rejectUnauthorized: true, minVersion: 'TLSv1.2' });
  });

  it.each([
    ['another port', { SMTP_PORT: '465' }, /SMTP_PORT must be 587/],
    ['no host', { SMTP_HOST: '' }, /SMTP_HOST is not set/],
    ['no key', { SMTP_PASSWORD: '' }, /login and key are not available/],
  ])('refuses %s', (_label, change, message) => {
    expect(() => emailProofConfig({ ...ENV, ...change })).toThrow(message);
  });

  it('hands the provider the message and nothing else, and keeps the provider\'s reply text out of any result', async () => {
    const sent: unknown[] = [];
    const transport: SmtpTransport = {
      sendMail: async (mail) => {
        sent.push(mail);
        return { messageId: '<id@relay>' };
      },
    };
    const channel = new SmtpEmailChannel(emailProofConfig(ENV), transport);
    const result = await channel.send({ to: 'someone@example.com', template: 'delivery.check', language: 'en', variables: {}, idempotencyKey: 'proof-1' });
    expect(result).toMatchObject({ status: 'accepted' });
    expect(sent).toEqual([expect.objectContaining({ from: EMAIL_PROOF_SENDER, to: 'someone@example.com', replyTo: 'support@tsxmr.com' })]);
    const failing: SmtpTransport = { sendMail: async () => Promise.reject(Object.assign(new Error('535 5.7.8 login@smtp-brevo.com bad credentials'), { code: 'EAUTH', responseCode: 535 })) };
    const refused = await new SmtpEmailChannel(emailProofConfig(ENV), failing).send({ to: 'someone@example.com', template: 'delivery.check', language: 'en', variables: {}, idempotencyKey: 'proof-2' });
    expect(refused).toMatchObject({ status: 'failed', reason: 'not_authorized' });
    expect(JSON.stringify(refused)).not.toMatch(/login@smtp-brevo\.com|bad credentials/);
  });
});
