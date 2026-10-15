import { readFileSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { binToUuid } from '../../common/utils/uuid.util';
import { DisabledWhatsAppChannel, TestWhatsAppChannel } from '../../messaging/channels';
import { ProvenWhatsAppChannel } from '../../messaging/delivery-readiness';
import { DevelopmentLogEmailChannel, DisabledEmailChannel } from '../../messaging/email-channel';
import { NOW, SITE_ORIGIN, TestEmailChannel, makeTrialWorld, type Business, type TrialWorld, type WorldOptions } from '../__testing__/trial-world';
import { TrialRefusal } from './trial-refusal';
import { TRIAL_TERMS_VERSION, setupTokenHash } from './trial-rules';

/**
 * The free trial's setup instructions (0095; docs/76; the owner's correction of 2026-10-13), over the in-memory world
 * that locks, rolls back and refuses duplicates like the database — with the real setup service, the real claim, and
 * recording providers.
 *
 * What is proven: the instructions go automatically, once, as soon as every contact given at registration is
 * verified — to verified contacts whose channel can carry them, decided at that moment — and never again on their
 * own; the website alone may ask again, throttled; the app is told where things stand and nothing it could act on;
 * delivery is never a condition for claiming; and no audit, log or row holds a contact, a token or a code.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

function world(options: WorldOptions = {}): TrialWorld {
  return makeTrialWorld(options);
}

/** The refusal a call ends in: its code, its status, and the body a client receives. */
async function refusal(promise: Promise<unknown>): Promise<{ code: string; status: number; body: Record<string, unknown> }> {
  const e = await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (err: unknown) => err,
  );
  if (!(e instanceof TrialRefusal)) throw e;
  return { code: e.code, status: e.getStatus(), body: e.getResponse() as Record<string, unknown> };
}

/** The token a setup email carried, read from its link the way the website reads it. */
function emailedToken(w: TrialWorld): string {
  const link = (w.email as TestEmailChannel).sent.at(-1)!.variables.link;
  return link.slice(link.indexOf('#t=') + 3);
}

const verifiedNow = (w: TrialWorld, b: Business) => w.setup.onContactsVerified(b.companyId, b.ownerId);
const actorOf = (b: Business) => `user:${binToUuid(b.ownerId)}`;

describe('sent automatically once the contacts given at registration are verified', () => {
  it('email only: one email in the business’s language with the website link, one link, one attempt, one audit', async () => {
    const w = world();
    const shop = w.business({ contacts: 'email', language: 'fr' });
    await verifiedNow(w, shop);

    const email = w.email as TestEmailChannel;
    expect(email.sent).toHaveLength(1);
    const token = emailedToken(w);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(email.sent[0]).toMatchObject({
      to: 'owner1@shop.test',
      template: 'trial.setup',
      language: 'fr',
      variables: { business: 'Shop 1', link: `${SITE_ORIGIN}/account/trial#t=${token}` },
    });
    expect((w.whatsapp as TestWhatsAppChannel).messages).toHaveLength(0);

    const [link] = w.links(shop);
    expect(w.links(shop)).toHaveLength(1);
    expect(link).toMatchObject({
      tokenHash: setupTokenHash(token),
      bindingDigest: w.service.bindingDigestFor(w.owner(shop) as never),
      expiresAt: new Date(NOW.getTime() + 24 * HOUR),
      createdAt: NOW,
      consumedAt: null,
      revokedAt: null,
    });
    expect(link.userId.equals(shop.ownerId)).toBe(true);

    expect(w.messages(shop)).toEqual([
      expect.objectContaining({
        trigger: 'verified',
        requestedByUserId: null,
        linkId: link.id,
        emailOutcome: 'accepted',
        whatsappOutcome: 'not_applicable',
        createdAt: NOW,
      }),
    ]);
    expect(w.audits(shop)).toEqual([
      expect.objectContaining({
        action: 'trial.setup_sent',
        actor: 'system',
        adminId: null,
        targetType: 'Company',
        afterJson: { trigger: 'verified', email: 'accepted', whatsapp: 'not_applicable' },
        createdAt: NOW,
      }),
    ]);
    // The token is a working link for its Owner — a convenience on the website, never a key.
    expect((await w.service.checkLink(shop.owner, token)).link).toBe('valid');
  });

  it('WhatsApp only: the approved template, the business in its body and the token as its button — in Arabic', async () => {
    const w = world();
    const shop = w.business({ contacts: 'phone', language: 'ar' });
    await verifiedNow(w, shop);

    const sent = (w.whatsapp as TestWhatsAppChannel).messages;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: shop.phone, template: 'trial.setup', language: 'ar' });
    expect(Object.keys(sent[0].variables).sort()).toEqual(['business', 'token']);
    expect(sent[0].variables.business).toBe('Shop 1');
    expect(w.link(sent[0].variables.token)).toBeDefined();
    expect((w.email as TestEmailChannel).sent).toHaveLength(0);
    expect(w.messages(shop)).toEqual([expect.objectContaining({ emailOutcome: 'not_applicable', whatsappOutcome: 'accepted' })]);
  });

  it('both: nothing while the number waits to be verified; then both channels carry the same link, once', async () => {
    const w = world();
    const shop = w.business({ contacts: 'both', verified: ['email'] });
    // The registration verified the email (email first); the number is verified later in the app.
    await verifiedNow(w, shop);
    expect((w.email as TestEmailChannel).sent).toHaveLength(0);
    expect(w.messages(shop)).toHaveLength(0);
    expect(w.links(shop)).toHaveLength(0);
    expect(await w.setup.appStatus(shop.owner)).toMatchObject({ delivery: 'waiting_for_contact', missingContacts: ['phone'] });

    w.owner(shop).phoneVerifiedAt = NOW;
    await verifiedNow(w, shop);
    const token = emailedToken(w);
    expect((w.whatsapp as TestWhatsAppChannel).last!.variables.token).toBe(token);
    expect(w.messages(shop)).toEqual([expect.objectContaining({ trigger: 'verified', emailOutcome: 'accepted', whatsappOutcome: 'accepted' })]);
    expect(await w.setup.appStatus(shop.owner)).toMatchObject({ delivery: 'sent', sentTo: ['email', 'whatsapp'], missingContacts: [] });
  });

  it('once: a later verification sends nothing again', async () => {
    const w = world();
    const shop = w.business();
    await verifiedNow(w, shop);
    w.clock.advance(HOUR);
    await verifiedNow(w, shop);
    expect((w.email as TestEmailChannel).sent).toHaveLength(1);
    expect(w.messages(shop)).toHaveLength(1);
    expect(w.links(shop)).toHaveLength(1);
  });

  it('never retried on its own: an automatic send that found nothing to carry it is not repeated when a channel opens', async () => {
    const closed = new ProvenWhatsAppChannel(new TestWhatsAppChannel(), { isProven: false, missing: ['en', 'fr', 'ar'] });
    const w = world({ whatsapp: closed });
    const shop = w.business({ contacts: 'phone' });
    await verifiedNow(w, shop);
    expect(w.messages(shop)).toEqual([expect.objectContaining({ trigger: 'verified', linkId: null, whatsappOutcome: 'unavailable' })]);
    expect(await w.setup.appStatus(shop.owner)).toMatchObject({ delivery: 'unavailable' });

    // The proofs load: the channel opens. Another verification still sends nothing — the Owner signs in on the website.
    Object.assign(closed, { readiness: { isProven: true, missing: [] } });
    w.owner(shop).phoneVerifiedAt = new Date(NOW.getTime() + HOUR);
    w.clock.advance(2 * HOUR);
    await verifiedNow(w, shop);
    expect(w.messages(shop)).toHaveLength(1);
  });

  it.each([
    ['a business the console created (never eligible)', { eligible: false }],
    ['an approved business (eligibility closed)', { eligibilityClosed: 'approved' as const, status: 'activated' as const, currentPeriodEnd: new Date(NOW.getTime() + 30 * 24 * HOUR) }],
    ['a suspended business', { status: 'suspended' as const }],
    ['a refused business', { status: 'rejected' as const, eligibilityClosed: 'refused' as const }],
    ['a closed business', { closed: true }],
  ])('nothing for %s', async (_name, opts) => {
    const w = world();
    const shop = w.business(opts);
    w.owner(shop).isActive = true;
    await verifiedNow(w, shop);
    expect(w.messages(shop)).toHaveLength(0);
    expect(w.links(shop)).toHaveLength(0);
    expect((w.email as TestEmailChannel).sent).toHaveLength(0);
  });

  it('nothing once the trial is claimed, and nothing for a Manager verifying their own number', async () => {
    const w = world();
    const claimed = w.business();
    await w.service.claim(claimed.owner, { idempotencyKey: 'k-1', termsVersion: TRIAL_TERMS_VERSION });
    await verifiedNow(w, claimed);
    expect(w.messages(claimed)).toHaveLength(0);

    const shop = w.business();
    const manager = w.staff(shop, 'store_manager');
    await w.setup.onContactsVerified(shop.companyId, manager.userId);
    expect(w.messages(shop)).toHaveLength(0);
    expect((w.email as TestEmailChannel).sent).toHaveLength(0);
  });

  it('never throws into the verification that called it — a database that fails is logged and left alone', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const w = world();
      const shop = w.business();
      w.db.$transaction = () => Promise.reject(new Error('connection lost'));
      await expect(verifiedNow(w, shop)).resolves.toBeUndefined();
      expect(warn.mock.calls.map(([m]) => String(m)).join('\n')).toMatch(/not sent for company .*connection lost/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('only verified contacts, only channels that can carry it — decided when it is sent', () => {
  it('a number that is set but not verified receives nothing', async () => {
    const w = world();
    const shop = w.business({ contacts: 'email' });
    w.owner(shop).phone = '+22236999999';
    await verifiedNow(w, shop);
    expect((w.whatsapp as TestWhatsAppChannel).messages).toHaveLength(0);
    expect(w.messages(shop)).toEqual([expect.objectContaining({ emailOutcome: 'accepted', whatsappOutcome: 'not_applicable' })]);
  });

  it('no approved WhatsApp setup template: WhatsApp is unavailable for it; the email still goes', async () => {
    const w = world({ whatsappTemplate: '' });
    const shop = w.business({ contacts: 'both' });
    await verifiedNow(w, shop);
    expect((w.whatsapp as TestWhatsAppChannel).messages).toHaveLength(0);
    expect(w.messages(shop)).toEqual([expect.objectContaining({ emailOutcome: 'accepted', whatsappOutcome: 'unavailable' })]);
    expect(await w.setup.appStatus(shop.owner)).toMatchObject({ delivery: 'sent', sentTo: ['email'] });
  });

  it('no website origin: no link can be built, so nothing is sent and nothing issued — recorded as unavailable', async () => {
    const w = world({ siteOrigin: '' });
    const shop = w.business({ contacts: 'both' });
    await verifiedNow(w, shop);
    expect(w.links(shop)).toHaveLength(0);
    expect((w.email as TestEmailChannel).sent).toHaveLength(0);
    expect(w.messages(shop)).toEqual([
      expect.objectContaining({ trigger: 'verified', linkId: null, emailOutcome: 'unavailable', whatsappOutcome: 'unavailable' }),
    ]);
    expect(w.audits(shop)).toEqual([
      expect.objectContaining({ action: 'trial.setup_unavailable', actor: 'system', afterJson: { trigger: 'verified', email: 'unavailable', whatsapp: 'unavailable' } }),
    ]);
  });

  it('a WhatsApp channel proven after boot carries the next send — read at send time, no restart', async () => {
    const readiness = { isProven: false, missing: ['en', 'fr', 'ar'] as ('en' | 'fr' | 'ar')[] };
    const sender = new TestWhatsAppChannel();
    const w = world({ whatsapp: new ProvenWhatsAppChannel(sender, readiness) });
    const shop = w.business({ contacts: 'phone' });
    await verifiedNow(w, shop);
    expect(w.messages(shop)[0]).toMatchObject({ whatsappOutcome: 'unavailable' });

    Object.assign(readiness, { isProven: true, missing: [] });
    w.clock.advance(MINUTE);
    const setup = await w.setup.resend(shop.owner);
    expect(setup).toMatchObject({ delivery: 'sent', sentTo: ['whatsapp'] });
    expect(sender.messages).toHaveLength(1);
  });

  it('the development logs carry it only where the development outbox is allowed — never in production', async () => {
    const dev = world({ email: new DevelopmentLogEmailChannel(), whatsapp: new DisabledWhatsAppChannel() });
    const shop = dev.business();
    await verifiedNow(dev, shop);
    expect(dev.messages(shop)).toEqual([expect.objectContaining({ emailOutcome: 'accepted' })]);

    const saved = process.env.APP_ENV;
    process.env.APP_ENV = 'production';
    try {
      const prod = world({ email: new DevelopmentLogEmailChannel(), whatsapp: new DisabledWhatsAppChannel() });
      const other = prod.business();
      await verifiedNow(prod, other);
      expect(prod.messages(other)).toEqual([expect.objectContaining({ linkId: null, emailOutcome: 'unavailable' })]);
    } finally {
      if (saved === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = saved;
    }
  });
});

describe('a provider’s answer is reported as it was', () => {
  it('refused: failed — tried once, never claimed as sent', async () => {
    const email = new TestEmailChannel();
    email.next = { status: 'failed', reason: 'rejected', detail: '422', provider: 'resend' };
    const w = world({ email });
    const shop = w.business();
    await verifiedNow(w, shop);
    expect(email.sent).toHaveLength(1);
    expect(w.messages(shop)).toEqual([expect.objectContaining({ emailOutcome: 'failed' })]);
    expect(w.audits(shop)[0]).toMatchObject({ action: 'trial.setup_sent', afterJson: { email: 'failed' } });
    expect(await w.setup.appStatus(shop.owner)).toMatchObject({ delivery: 'failed', sentTo: [] });
  });

  it('a temporary failure is tried once more under the same key', async () => {
    const answers = [
      { status: 'failed' as const, reason: 'temporary' as const, detail: '503', provider: 'resend' },
      { status: 'accepted' as const, providerMessageId: 'em-2', provider: 'resend' },
    ];
    const email = new TestEmailChannel();
    email.send = async function (this: TestEmailChannel, message) {
      this.sent.push(message);
      return answers.shift()!;
    };
    const w = world({ email });
    const shop = w.business();
    await verifiedNow(w, shop);
    expect(email.sent).toHaveLength(2);
    expect(email.sent[0].idempotencyKey).toBe(email.sent[1].idempotencyKey);
    expect(w.messages(shop)[0]).toMatchObject({ emailOutcome: 'accepted' });
  });

  it('a channel found closed at the moment of sending is unavailable; a provider that throws has failed', async () => {
    const whatsapp = new TestWhatsAppChannel();
    whatsapp.nextResult = { status: 'failed', reason: 'channel_unavailable', detail: 'closed', provider: 'test' };
    const email = new TestEmailChannel();
    email.send = async () => {
      throw new Error('socket hang up');
    };
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const w = world({ email, whatsapp });
      const shop = w.business({ contacts: 'both' });
      await verifiedNow(w, shop);
      expect(w.messages(shop)).toEqual([expect.objectContaining({ emailOutcome: 'failed', whatsappOutcome: 'unavailable' })]);
      expect(await w.setup.appStatus(shop.owner)).toMatchObject({ delivery: 'failed' });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the website’s resend — after the Owner signs in, never from the app', () => {
  let w: TrialWorld;
  let shop: Business;
  beforeEach(async () => {
    w = world();
    shop = w.business();
    await verifiedNow(w, shop);
  });

  it('only the Owner: a Manager, an Employee and a legacy administrator are refused before anything is read', async () => {
    for (const role of ['store_manager', 'store_employee', 'administrator'] as const) {
      w.clock.advance(MINUTE);
      expect(await refusal(w.setup.resend(w.staff(shop, role)))).toMatchObject({ code: 'owner_only', status: 403 });
    }
    expect(w.messages(shop)).toHaveLength(1);
  });

  it('a minute after the automatic send, it sends again: a new link, the old one retired as reissued', async () => {
    const first = emailedToken(w);
    w.clock.advance(MINUTE);
    const setup = await w.setup.resend(shop.owner);
    const second = emailedToken(w);

    expect(second).not.toBe(first);
    expect(w.link(first)).toMatchObject({ revokedAt: new Date(NOW.getTime() + MINUTE), revokedReason: 'reissued' });
    expect(w.link(second)).toMatchObject({ revokedAt: null, consumedAt: null });
    expect(w.messages(shop).at(-1)).toMatchObject({ trigger: 'resend', requestedByUserId: shop.ownerId });
    expect(w.audits(shop).at(-1)).toMatchObject({ action: 'trial.setup_sent', actor: actorOf(shop), afterJson: { trigger: 'resend' } });
    expect((await w.service.checkLink(shop.owner, first)).link).toBe('revoked');
    expect((await w.service.checkLink(shop.owner, second)).link).toBe('valid');

    const resent = new Date(NOW.getTime() + MINUTE).toISOString();
    expect(setup).toEqual({
      delivery: 'sent',
      sentTo: ['email'],
      destinations: [{ channel: 'email', masked: 'o•••@shop.test' }],
      lastAttemptAt: resent,
      canResendNow: false,
      resendAvailableAt: new Date(NOW.getTime() + 2 * MINUTE).toISOString(),
      history: [
        { at: resent, trigger: 'resend', email: 'accepted', whatsapp: 'not_applicable' },
        { at: NOW.toISOString(), trigger: 'automatic', email: 'accepted', whatsapp: 'not_applicable' },
      ],
    });
  });

  it('throttled: 60 s, then 3 in 15 minutes, each refusal saying exactly when', async () => {
    const t0 = NOW.getTime();
    w.clock.set(new Date(t0 + 30 * SECOND));
    expect(await refusal(w.setup.resend(shop.owner))).toMatchObject({
      code: 'too_many_requests',
      status: 429,
      body: { resendAvailableAt: new Date(t0 + MINUTE).toISOString() },
    });

    w.clock.set(new Date(t0 + MINUTE));
    await w.setup.resend(shop.owner);
    w.clock.set(new Date(t0 + 2 * MINUTE));
    await w.setup.resend(shop.owner);
    // Three in fifteen minutes — the automatic send counts like any other.
    w.clock.set(new Date(t0 + 3 * MINUTE));
    expect(await refusal(w.setup.resend(shop.owner))).toMatchObject({
      code: 'too_many_requests',
      body: { resendAvailableAt: new Date(t0 + 15 * MINUTE).toISOString() },
    });
    w.clock.set(new Date(t0 + 15 * MINUTE));
    await expect(w.setup.resend(shop.owner)).resolves.toMatchObject({ delivery: 'sent' });
    expect(w.messages(shop)).toHaveLength(4);
  });

  it('throttled: 10 in a day', async () => {
    const t0 = NOW.getTime();
    for (let k = 1; k <= 9; k += 1) {
      w.clock.set(new Date(t0 + k * 16 * MINUTE));
      await w.setup.resend(shop.owner);
    }
    expect(w.messages(shop)).toHaveLength(10);
    w.clock.set(new Date(t0 + 10 * 16 * MINUTE));
    expect(await refusal(w.setup.resend(shop.owner))).toMatchObject({
      code: 'too_many_requests',
      body: { resendAvailableAt: new Date(t0 + 24 * HOUR).toISOString() },
    });
    w.clock.set(new Date(t0 + 24 * HOUR));
    await expect(w.setup.resend(shop.owner)).resolves.toMatchObject({ delivery: 'sent' });
  });

  it('two at once send once: the second sees the first in flight', async () => {
    w.clock.advance(MINUTE);
    const before = (w.email as TestEmailChannel).sent.length;
    const results = await Promise.allSettled([w.setup.resend(shop.owner), w.setup.resend(shop.owner)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const lost = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
    expect((lost.reason as TrialRefusal).code).toBe('too_many_requests');
    expect((w.email as TestEmailChannel).sent.length - before).toBe(1);
    expect(w.links(shop).filter((l) => l.revokedAt === null)).toHaveLength(1);
  });

  it('refused when the business cannot claim, or a required contact is unverified', async () => {
    await w.service.claim(shop.owner, { idempotencyKey: 'k-1', termsVersion: TRIAL_TERMS_VERSION });
    w.clock.advance(MINUTE);
    expect(await refusal(w.setup.resend(shop.owner))).toMatchObject({ code: 'trial_not_available', status: 409 });

    const both = w.business({ contacts: 'both', verified: ['email'] });
    expect(await refusal(w.setup.resend(both.owner))).toMatchObject({
      code: 'contact_unverified',
      status: 409,
      body: { missingContacts: ['phone'] },
    });
    expect(w.messages(both)).toHaveLength(0);
  });

  it('nothing can carry it: 503 setup_delivery_unavailable — the attempt recorded, and counted', async () => {
    const off = world({ email: new DisabledEmailChannel(), whatsapp: new DisabledWhatsAppChannel() });
    const b = off.business();
    await verifiedNow(off, b);
    off.clock.advance(MINUTE);
    expect(await refusal(off.setup.resend(b.owner))).toMatchObject({ code: 'setup_delivery_unavailable', status: 503 });
    expect(off.messages(b).at(-1)).toMatchObject({ trigger: 'resend', requestedByUserId: b.ownerId, linkId: null, emailOutcome: 'unavailable' });
    expect(off.audits(b).at(-1)).toMatchObject({ action: 'trial.setup_unavailable', actor: actorOf(b) });
    expect(off.links(b)).toHaveLength(0);
    // It counts: asking again at once is too soon.
    expect(await refusal(off.setup.resend(b.owner))).toMatchObject({ code: 'too_many_requests' });
  });
});

describe('the app is told where things stand, and nothing it could act on', () => {
  it('eligible: exactly the display fields — duration, contacts, masked destinations, delivery, the business’s zone', async () => {
    const w = world();
    const shop = w.business({ contacts: 'both', timezone: 'Asia/Dubai' });
    await verifiedNow(w, shop);
    const status = await w.setup.appStatus(shop.owner);
    expect(status).toEqual({
      state: 'trial_available',
      eligible: true,
      durationHours: 168,
      durationDays: 7,
      requiredContacts: ['email', 'phone'],
      missingContacts: [],
      destinations: [
        { channel: 'email', masked: 'o•••@shop.test' },
        { channel: 'whatsapp', masked: '+222••••0001' },
      ],
      delivery: 'sent',
      sentTo: ['email', 'whatsapp'],
      lastAttemptAt: NOW.toISOString(),
      timeZone: 'Asia/Dubai',
    });
    // No action data: nothing to resend, no time to ask again, no link, no token, no route, no website.
    const json = JSON.stringify(status);
    for (const banned of ['canResend', 'canSend', 'resendAvailableAt', 'history', 'link', 'token', 'url', 'http', '#t=', '/platform/', 'claim', emailedToken(w)]) {
      expect({ banned, present: json.includes(banned) }).toEqual({ banned, present: false });
    }
  });

  it.each([
    ['not sent yet (contacts complete, nothing recorded)', 'not_sent'],
    ['waiting for the number', 'waiting_for_contact'],
  ])('%s → %s', async (_name, delivery) => {
    const w = world();
    const shop = delivery === 'waiting_for_contact' ? w.business({ contacts: 'both', verified: ['email'] }) : w.business();
    expect(await w.setup.appStatus(shop.owner)).toMatchObject({ delivery, lastAttemptAt: null, sentTo: [] });
  });

  it('a business that may not claim is told only its state — no card', async () => {
    const w = world();
    const claimed = w.business();
    await w.service.claim(claimed.owner, { idempotencyKey: 'k-1', termsVersion: TRIAL_TERMS_VERSION });
    expect(await w.setup.appStatus(claimed.owner)).toEqual({ state: 'trial_active', eligible: false });
    expect(await w.setup.appStatus(w.business({ eligible: false }).owner)).toEqual({ state: 'pending', eligible: false });
    expect(await w.setup.appStatus(w.business({ status: 'suspended' }).owner)).toEqual({ state: 'suspended', eligible: false });
  });

  it('only to the Owner: staff are refused owner_only', async () => {
    const w = world();
    const shop = w.business();
    for (const role of ['store_manager', 'store_employee', 'administrator'] as const) {
      expect(await refusal(w.setup.appStatus(w.staff(shop, role)))).toMatchObject({ code: 'owner_only', status: 403 });
    }
  });

  it('the zone is the business’s own; one Intl does not know reads as UTC — never a zone guessed for the country', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const w = world();
      expect(await w.setup.appStatus(w.business({ timezone: 'Africa/Nouakchott' }).owner)).toMatchObject({ timeZone: 'Africa/Nouakchott' });
      expect(await w.setup.appStatus(w.business({ timezone: 'Mars/Olympus' }).owner)).toMatchObject({ timeZone: 'UTC' });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('delivery is never a condition for claiming', () => {
  it('failed, or nothing could carry it: the website shows the same offer, and the Owner claims without any link', async () => {
    for (const options of [{ email: Object.assign(new TestEmailChannel(), { next: { status: 'failed', reason: 'rejected', detail: 'x', provider: 'resend' } }) }, { siteOrigin: '' }] as WorldOptions[]) {
      const w = world(options);
      const shop = w.business();
      await verifiedNow(w, shop);
      const card = await w.service.status(shop.owner);
      expect(card.offer).toMatchObject({ available: true, reason: null });
      expect(card.setup?.delivery).toMatch(/failed|unavailable/);
      await expect(w.service.claim(shop.owner, { idempotencyKey: 'k-1', termsVersion: TRIAL_TERMS_VERSION })).resolves.toMatchObject({ state: 'trial_active' });
    }
  });

  it('the website card shows the setup only while the trial can be claimed', async () => {
    const w = world();
    const shop = w.business();
    await verifiedNow(w, shop);
    expect((await w.service.status(shop.owner)).setup).toMatchObject({ delivery: 'sent', history: [expect.objectContaining({ trigger: 'automatic' })] });
    const token = emailedToken(w);
    // The token a message carried is the one the website may claim with: it is consumed, the claim says so.
    await w.service.claim(shop.owner, { idempotencyKey: 'k-1', termsVersion: TRIAL_TERMS_VERSION, token });
    expect(w.link(token).consumedAt).toEqual(NOW);
    expect((await w.service.status(shop.owner)).setup).toBeNull();
  });
});

describe('instants and secrets', () => {
  it('every instant is the server clock’s: the link when it was issued, the attempt when it was recorded', async () => {
    const email = new TestEmailChannel();
    const w = world({ email });
    const send = email.send.bind(email);
    // The provider takes three seconds to answer.
    email.send = async (message) => {
      w.clock.advance(3 * SECOND);
      return send(message);
    };
    const shop = w.business();
    await verifiedNow(w, shop);
    expect(w.links(shop)[0]).toMatchObject({ createdAt: NOW, expiresAt: new Date(NOW.getTime() + 24 * HOUR) });
    expect(w.messages(shop)[0].createdAt).toEqual(new Date(NOW.getTime() + 3 * SECOND));
  });

  it('no audit, row or log line holds a contact, the token, the link or a code', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      const email = new TestEmailChannel();
      const w = world({ email });
      const shop = w.business({ contacts: 'both' });
      await verifiedNow(w, shop);
      const token = emailedToken(w);
      email.next = { status: 'failed', reason: 'rejected', detail: 'x', provider: 'resend' };
      w.clock.advance(MINUTE);
      await w.setup.resend(shop.owner);

      const written = JSON.stringify([w.audits(shop), w.messages(shop), w.links(shop)], (_k, v) => (Buffer.isBuffer(v) ? 'id' : v));
      const logged = [...warn.mock.calls, ...log.mock.calls].map(([m]) => String(m)).join('\n');
      for (const secret of [token, shop.email!, shop.phone!, SITE_ORIGIN, '#t=']) {
        expect({ secret, written: written.includes(secret), logged: logged.includes(secret) }).toEqual({ secret, written: false, logged: false });
      }
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it('on a development machine the link is also printed to the console, under the banner — and never otherwise', async () => {
    const print = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const saved = process.env.NODE_ENV;
    const savedAppEnv = process.env.APP_ENV;
    try {
      const w = world();
      const quiet = w.business();
      await verifiedNow(w, quiet);
      expect(print).not.toHaveBeenCalled();

      process.env.NODE_ENV = 'development';
      const shop = w.business();
      await verifiedNow(w, shop);
      expect(print).toHaveBeenCalledTimes(1);
      const banner = String(print.mock.calls[0][0]);
      expect(banner).toContain('=== LOCAL DEV ONLY — NOT A REAL MESSAGE ===');
      expect(banner).toContain(`${SITE_ORIGIN}/account/trial#t=${emailedToken(w)}`);

      // Staging and production never print it, whatever NODE_ENV says (C16): a deployed console is a log.
      for (const appEnv of ['staging', 'production']) {
        process.env.APP_ENV = appEnv;
        await verifiedNow(w, w.business());
      }
      expect(print).toHaveBeenCalledTimes(1);
    } finally {
      process.env.NODE_ENV = saved;
      if (savedAppEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = savedAppEnv;
      print.mockRestore();
    }
  });

  it('reads no clock but the injected one, and nothing a request says about where it came from', () => {
    for (const file of ['src/platform/trial/trial-setup.service.ts', 'src/platform/trial/trial-setup-rules.ts']) {
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect({ file, clock: code.match(/new Date\(\)|Date\.now\(/g) }).toEqual({ file, clock: null });
      expect({ file, request: code.match(/referer|referrer|headers|@Req|@Headers|req\./gi) }).toEqual({ file, request: null });
    }
  });
});
