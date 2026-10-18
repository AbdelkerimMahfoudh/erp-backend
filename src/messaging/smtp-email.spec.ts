import { classifySmtpFailure, messageIdFor, SmtpEmailChannel, smtpTransportOptions, type SmtpConfig, type SmtpTransport } from './smtp-email-channel';
import { composeEmail, createEmailChannel, renderEmailHtml, senderFor, type EmailMessage, type EmailSenders } from './email-channel';
import { LoggedEmailChannel, limitRefusal, utcDayStart, type EmailLimits } from './email-log';
import { recipientHash } from './recipient-hash';
import { sendWithOneRetry } from '../platform/contact-delivery';
import { fakeMessagingPrisma } from './__testing__/fake-messaging-prisma';

/**
 * Transactional email over Brevo's SMTP relay (D181 §1, §9): a fixed secure connection, a sender per message class,
 * Reply-To support, text and HTML alternatives with every variable escaped, failures classified from codes only,
 * an ambiguous timeout retried without a new code, and an internal daily safety limit with a reserve for codes.
 * No test opens a connection: the transport is a fake.
 */

const PASSWORD = 'smtp-test-password-not-real-0123';
const senders: EmailSenders = {
  verification: 'Dukan ERP <verification@tsxmr.com>',
  notifications: 'Dukan ERP <notifications@tsxmr.com>',
  reports: 'reports@tsxmr.com',
  receipts: 'receipts@tsxmr.com',
  fallback: 'Dukan ERP <no-reply@tsxmr.com>',
};
const cfg: SmtpConfig = {
  host: 'smtp-relay.brevo.com',
  port: 587,
  username: 'login@smtp-brevo.test',
  password: PASSWORD,
  senders,
  replyTo: 'support@tsxmr.com',
  timeouts: { connectionMs: 10_000, greetingMs: 10_000, socketMs: 20_000 },
};

function transport(...outcomes: (Error | { messageId?: string })[]) {
  const mails: Record<string, unknown>[] = [];
  const t: SmtpTransport = {
    sendMail: jest.fn(async (mail) => {
      mails.push(mail as Record<string, unknown>);
      const next = outcomes.shift() ?? { messageId: String((mail as { messageId?: string }).messageId) };
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  return { t, mails };
}

const smtpError = (code: string, responseCode?: number) =>
  Object.assign(new Error(`Invalid login: 535 Authentication failed for ${cfg.username} with ${PASSWORD}`), { code, responseCode });

const verification: EmailMessage = { to: 'owner@shop.mr', template: 'contact.verification', language: 'en', variables: { code: '482913', ttlMinutes: '10' }, idempotencyKey: 'key-1' };
const instructions: EmailMessage = {
  to: 'owner@shop.mr',
  template: 'portal.instructions',
  language: 'ar',
  variables: { business: 'Boutique <Aicha> & "Fils"', link: 'https://dukan.tsxmr.com/subscription' },
  idempotencyKey: 'key-2',
};

describe('the connection', () => {
  it('is port 587 with STARTTLS required, TLS 1.2 minimum, a verified certificate, finite timeouts and no debug output', () => {
    expect(smtpTransportOptions(cfg)).toMatchObject({
      host: 'smtp-relay.brevo.com',
      port: 587,
      secure: false,
      requireTLS: true,
      ignoreTLS: false,
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: 'smtp-relay.brevo.com' },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  });

  it('is never built without credentials and a sender, and never on another port in production', () => {
    expect(() => createEmailChannel({ channel: 'smtp', isProduction: false, smtp: { ...cfg, password: '' } })).toThrow(/SMTP_PASSWORD/);
    expect(() => createEmailChannel({ channel: 'smtp', isProduction: false, smtp: { ...cfg, senders: { ...senders, fallback: '', verification: '' } } })).toThrow(/needs a sender/);
    expect(() => createEmailChannel({ channel: 'smtp', isProduction: true, smtp: { ...cfg, port: 465 } })).toThrow(/587/);
    expect(createEmailChannel({ channel: 'smtp', isProduction: true, smtp: cfg }).name).toBe('smtp');
  });
});

describe('the sender', () => {
  it('follows the message class, and falls back to EMAIL_FROM', () => {
    expect(senderFor('contact.verification', senders)).toBe('Dukan ERP <verification@tsxmr.com>');
    expect(senderFor('password.recovery', senders)).toBe('Dukan ERP <verification@tsxmr.com>');
    expect(senderFor('portal.instructions', senders)).toBe('Dukan ERP <notifications@tsxmr.com>');
    expect(senderFor('subscription.grace_started', { ...senders, notifications: '' })).toBe('Dukan ERP <no-reply@tsxmr.com>');
  });
});

describe('sending', () => {
  it('hands over text AND html, the class sender, Reply-To support and a Message-ID derived from the message', async () => {
    const { t, mails } = transport();
    const result = await new SmtpEmailChannel(cfg, t).send(verification);
    expect(result).toMatchObject({ status: 'accepted', provider: 'smtp' });
    const mail = mails[0];
    expect(mail).toMatchObject({ from: senders.verification, to: 'owner@shop.mr', replyTo: 'support@tsxmr.com', subject: 'Your Dukan ERP code' });
    expect(String(mail.text)).toContain('482913');
    expect(String(mail.html)).toContain('482913');
    expect(mail.messageId).toBe(messageIdFor('key-1', senders.verification));
    expect(String(mail.messageId)).toMatch(/^<[0-9a-f]{40}@tsxmr\.com>$/);
    expect(mail.headers).toMatchObject({ 'Auto-Submitted': 'auto-generated' });
  });

  it('refuses a held or incomplete template before anything is sent', async () => {
    const { t } = transport();
    const result = await new SmtpEmailChannel(cfg, t).send({ ...verification, template: 'password.recovery' });
    expect(result).toMatchObject({ status: 'failed', reason: 'rejected' });
    expect(t.sendMail).not.toHaveBeenCalled();
  });

  it.each([
    [smtpError('EAUTH', 535), 'not_authorized'],
    [smtpError('ETIMEDOUT'), 'temporary'],
    [smtpError('ECONNECTION'), 'temporary'],
    [smtpError('ETLS'), 'temporary'],
    [smtpError('EENVELOPE', 550), 'rejected'],
    [smtpError('EMESSAGE', 552), 'rejected'],
    [Object.assign(new Error('x'), { responseCode: 421 }), 'temporary'],
    [Object.assign(new Error('x'), { responseCode: 554 }), 'rejected'],
  ])('classifies %p as %s, from codes only — never the password, the login or the address', async (error, reason) => {
    const { t } = transport(error as Error);
    const result = await new SmtpEmailChannel(cfg, t).send(verification);
    expect(result).toMatchObject({ status: 'failed', reason });
    const text = JSON.stringify(result) + JSON.stringify(classifySmtpFailure(error));
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(cfg.username);
    expect(text).not.toContain('owner@shop.mr');
    expect(text).not.toContain('482913');
  });

  it('an ambiguous timeout is retried with the SAME code and the SAME Message-ID — no new code is created', async () => {
    const { t, mails } = transport(smtpError('ETIMEDOUT'));
    const channel = new SmtpEmailChannel(cfg, t);
    const result = await sendWithOneRetry((idempotencyKey) => channel.send({ ...verification, idempotencyKey }));
    expect(result.status).toBe('accepted');
    expect(mails).toHaveLength(2);
    expect(mails[0].messageId).toBe(mails[1].messageId);
    expect(mails[0].text).toBe(mails[1].text);
  });
});

describe('the HTML alternative', () => {
  it('escapes every variable, lays Arabic out right to left, and carries no image, script, pixel or remote resource', () => {
    const { html, text } = composeEmail(instructions);
    expect(html).toMatch(/^<!doctype html><html lang="ar" dir="rtl">/);
    expect(html).toContain('text-align:right');
    expect(html).toContain('Boutique &lt;Aicha&gt; &amp; &quot;Fils&quot;');
    expect(html).not.toContain('<Aicha>');
    expect(html).not.toMatch(/<img|<script|<link|<iframe|url\(|src=/i);
    // The only link is the portal's address itself, shown as it is followed.
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('href="https://dukan.tsxmr.com/subscription"');
    expect(text).toContain('Boutique <Aicha> & "Fils"');
  });

  it('never makes a link of a value that is not an https address', () => {
    const html = renderEmailHtml('en', 's', 'Open {link}', { link: 'javascript:alert(1)' });
    expect(html).not.toContain('<a ');
    expect(html).toContain('javascript:alert(1)');
    expect(renderEmailHtml('en', 's', 'Open {link}', { link: 'https://x.test/"onmouseover="y' })).not.toContain('<a ');
  });

  it('is left to right in English and French, and keeps a code left to right inside Arabic', () => {
    expect(composeEmail(verification).html).toMatch(/dir="ltr"/);
    expect(composeEmail({ ...verification, language: 'fr' }).html).toMatch(/lang="fr" dir="ltr"/);
    expect(composeEmail({ ...verification, language: 'ar' }).html).toContain('<strong dir="ltr"');
  });
});

describe('the internal safety limit', () => {
  const limits: EmailLimits = { dailyLimit: 300, dailyReserve: 50, recipientDailyLimit: 20 };

  it('keeps the reserve for codes: non-essential email stops at the limit minus the reserve', () => {
    expect(limitRefusal({ today: 249, recipientToday: 0 }, false, limits)).toBeNull();
    expect(limitRefusal({ today: 250, recipientToday: 0 }, false, limits)).toMatch(/kept for codes/);
    expect(limitRefusal({ today: 299, recipientToday: 0 }, true, limits)).toBeNull();
    expect(limitRefusal({ today: 300, recipientToday: 0 }, true, limits)).toMatch(/Internal daily safety limit/);
    expect(limitRefusal({ today: 0, recipientToday: 20 }, true, limits)).toMatch(/this recipient/);
  });

  it('counts from 00:00 UTC', () => {
    expect(utcDayStart(new Date('2026-10-17T23:59:59+02:00')).toISOString()).toBe('2026-10-17T00:00:00.000Z');
  });
});

describe('the email record', () => {
  const KEY = 'test-messaging-hash-key-of-32-characters!';
  function logged(limits: EmailLimits = { dailyLimit: 300, dailyReserve: 50, recipientDailyLimit: 20 }, ...outcomes: (Error | { messageId?: string })[]) {
    const db = fakeMessagingPrisma();
    const { t, mails } = transport(...outcomes);
    const channel = new LoggedEmailChannel(new SmtpEmailChannel(cfg, t), db as never, { hash: (a: string) => recipientHash(a, KEY) }, limits, (tpl) => senderFor(tpl, senders));
    return { db, mails, channel };
  }

  it('records one row per message: class, sender, outcome — never the body, the code, the link or the address', async () => {
    const { db, channel } = logged();
    await channel.send(verification);
    await channel.send(instructions);
    expect(db.emailMessage.rows).toEqual([
      expect.objectContaining({ template: 'contact.verification', category: 'verification', essential: true, sender: senders.verification, status: 'accepted', attempts: 1, recipientMasked: 'o***@shop.mr', recipientHash: recipientHash('owner@shop.mr', KEY) }),
      expect.objectContaining({ template: 'portal.instructions', category: 'notifications', essential: false, sender: senders.notifications, status: 'accepted' }),
    ]);
    const stored = JSON.stringify(db.emailMessage.rows);
    expect(stored).not.toMatch(/482913|owner@shop\.mr|Zp3k9QeR7xVb|Aicha/);
  });

  it('refuses honestly once the internal limit is reached, keeping the reserve for codes', async () => {
    const { db, mails, channel } = logged({ dailyLimit: 2, dailyReserve: 1, recipientDailyLimit: 20 });
    expect((await channel.send(instructions)).status).toBe('accepted');
    // One sent; the second non-essential message would eat the reserve.
    expect(await channel.send({ ...instructions, idempotencyKey: 'key-3' })).toMatchObject({ status: 'failed', reason: 'rejected', detail: expect.stringMatching(/kept for codes/) });
    expect((await channel.send(verification)).status).toBe('accepted');
    expect(await channel.send({ ...verification, idempotencyKey: 'key-4' })).toMatchObject({ status: 'failed', detail: 'Internal daily safety limit reached' });
    expect(mails).toHaveLength(2);
    expect(db.emailMessage.rows.filter((r) => r.status === 'refused')).toHaveLength(2);
  });

  it('limits one recipient per day', async () => {
    const { channel } = logged({ dailyLimit: 300, dailyReserve: 50, recipientDailyLimit: 1 });
    await channel.send(verification);
    expect(await channel.send({ ...verification, idempotencyKey: 'key-5' })).toMatchObject({ status: 'failed', detail: expect.stringMatching(/this recipient/) });
  });

  it('a retry of the same message is one row with two attempts, counted once; an accepted message is never sent twice', async () => {
    const { db, mails, channel } = logged(undefined, smtpError('ETIMEDOUT'));
    const result = await sendWithOneRetry((idempotencyKey) => channel.send({ ...verification, idempotencyKey }));
    expect(result.status).toBe('accepted');
    expect(db.emailMessage.rows).toHaveLength(1);
    expect(db.emailMessage.rows[0]).toMatchObject({ status: 'accepted', attempts: 2 });
    const key = String(db.emailMessage.rows[0].idempotencyKey);
    expect(await channel.send({ ...verification, idempotencyKey: key })).toMatchObject({ status: 'accepted' });
    expect(mails).toHaveLength(2);
  });

  it('sends nothing when the records cannot be read: a limit that cannot be checked is not a limit', async () => {
    const { db, mails, channel } = logged();
    db.emailMessage.failing.add('count');
    expect(await channel.send(verification)).toMatchObject({ status: 'failed', reason: 'temporary', detail: 'Email records are unavailable' });
    expect(mails).toHaveLength(0);
  });
});
