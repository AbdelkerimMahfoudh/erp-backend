import { readFileSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { binToUuid } from '../../common/utils/uuid.util';
import { DisabledWhatsAppChannel, TestWhatsAppChannel } from '../../messaging/channels';
import { ProvenWhatsAppChannel } from '../../messaging/delivery-readiness';
import {
  HangingWhatsAppChannel,
  NOW,
  PORTAL_URL,
  TestEmailChannel,
  makeTrialWorld,
  type Business,
  type TrialWorld,
  type WorldOptions,
} from '../__testing__/trial-world';
import { TrialRefusal } from './trial-refusal';
import { TRIAL_TERMS_VERSION } from './trial-rules';

/**
 * The portal instructions (0095, 0099; docs/76, docs/101 §5; the owner's brief of 2026-10-18), over the in-memory world
 * that locks, rolls back and refuses duplicates like the database — with the real setup service, the real notice
 * outbox, the real claim, and recording providers.
 *
 * What is proven: ONE message goes automatically, once, as soon as the Owner's WhatsApp number is verified — by
 * WhatsApp, and by email only for a recorded reason — carrying the portal's one address and no token; it is never
 * sent again on its own; the portal alone may ask again, throttled and audited; the app is told where things stand
 * and nothing it could act on; delivery is never a condition for claiming; and no audit, row or variable holds a
 * contact, a token or an identifier.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;

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

const verifiedNow = (w: TrialWorld, b: Business) => w.setup.onContactsVerified(b.companyId, b.ownerId);
/** Queue the automatic instructions and let the outbox send them. */
async function sendAutomatic(w: TrialWorld, b: Business): Promise<void> {
  await verifiedNow(w, b);
  await w.notices.deliverNow();
}
const sentWhatsApp = (w: TrialWorld) => (w.whatsapp as TestWhatsAppChannel).messages;
const sentEmail = (w: TrialWorld) => (w.email as TestEmailChannel).sent;
const keyOf = (notice: Record<string, any>) => `notice:${binToUuid(notice.id)}:wa`;

describe('sent automatically, once, when the Owner’s WhatsApp number is verified', () => {
  it('one WhatsApp message: the approved template, the business’s name and nothing else, in the business’s language', async () => {
    const w = makeTrialWorld();
    const shop = w.business({ name: 'Boutique Aicha', language: 'ar' });
    await sendAutomatic(w, shop);

    expect(sentWhatsApp(w)).toEqual([
      expect.objectContaining({ to: shop.phone, template: 'portal.instructions', language: 'ar', variables: { business: 'Boutique Aicha' } }),
    ]);
    // Same key on every attempt: a provider never delivers it twice.
    const [notice] = w.noticesOf(shop);
    expect(sentWhatsApp(w)[0].idempotencyKey).toBe(keyOf(notice));
    expect(sentEmail(w)).toEqual([]);
    expect(w.noticesOf(shop)).toEqual([
      expect.objectContaining({
        kind: 'portal_instructions',
        threshold: 'auto',
        periodKey: `eligibility:${binToUuid(w.eligibility(shop)!.id)}`,
        state: 'accepted',
        channel: 'whatsapp',
        whatsappOutcome: 'accepted',
        fallbackReason: null,
        destinationMasked: '+222••••0001',
        requestedByUserId: null,
        language: 'ar',
        acceptedAt: NOW,
      }),
    ]);
  });

  it('carries no token, no link and no identifier: the portal’s address is in the approved text itself', async () => {
    const w = makeTrialWorld();
    const shop = w.business();
    await sendAutomatic(w, shop);
    const sent = JSON.stringify(sentWhatsApp(w)[0].variables);
    expect(sent).not.toMatch(/https?:|token|[0-9a-f]{8}-[0-9a-f]{4}/i);
  });

  it('once: a later verification, or two at once, queue nothing more', async () => {
    const w = makeTrialWorld();
    const shop = w.business();
    await Promise.all([verifiedNow(w, shop), verifiedNow(w, shop), verifiedNow(w, shop)]);
    await w.notices.deliverNow();
    await sendAutomatic(w, shop);
    expect(w.noticesOf(shop)).toHaveLength(1);
    expect(sentWhatsApp(w)).toHaveLength(1);
  });

  it('nothing while the number waits to be verified; nothing for a Manager; nothing once claimed, suspended or closed', async () => {
    const w = makeTrialWorld();
    const waiting = w.business({ verified: [] });
    const claimed = w.business();
    await w.service.claim(claimed.owner, { idempotencyKey: 'k-1', termsVersion: TRIAL_TERMS_VERSION });
    const suspended = w.business({ status: 'suspended' });
    const closedEligibility = w.business({ eligibilityClosed: 'approved', status: 'activated', currentPeriodEnd: new Date(NOW.getTime() + 30 * 24 * 3600_000) });
    const shop = w.business();
    const manager = w.staff(shop, 'store_manager');
    for (const b of [waiting, claimed, suspended, closedEligibility]) await verifiedNow(w, b);
    await w.setup.onContactsVerified(shop.companyId, manager.userId);
    expect(w.t.notices).toEqual([]);
  });

  it('never throws into the verification that called it — a database that fails is logged and left alone', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const w = makeTrialWorld();
      const shop = w.business();
      w.db.trialEligibility.findUnique = async () => {
        throw new Error('connection lost');
      };
      await expect(verifiedNow(w, shop)).resolves.toBeUndefined();
      expect(warn.mock.calls.map(([m]) => String(m))).toEqual([`Portal instructions not queued for company ${binToUuid(shop.companyId)}: Error`]);
    } finally {
      warn.mockRestore();
    }
  });

  it('never holds the verification: queued and answered at once while the provider hangs; sent when it answers (C14)', async () => {
    const whatsapp = new HangingWhatsAppChannel();
    const w = makeTrialWorld({ whatsapp });
    const shop = w.business();
    await verifiedNow(w, shop);
    await whatsapp.called;
    expect(await w.setup.appStatus(shop.owner)).toMatchObject({ delivery: 'sending' });
    whatsapp.answer();
    await w.notices.deliverNow();
    expect(await w.setup.appStatus(shop.owner)).toMatchObject({ delivery: 'sent', channel: 'whatsapp' });
  });

  it('re-validated when it goes out: a trial claimed meanwhile cancels it, and nothing is sent', async () => {
    const w = makeTrialWorld();
    const shop = w.business();
    // Queued, and not reached by the worker yet…
    await w.notices.requestInstructions(w.db as never, {
      companyId: shop.companyId,
      subscriptionId: w.subscription(shop).id,
      eligibilityId: w.eligibility(shop)!.id,
      requestedBy: null,
      now: NOW,
    });
    // …when the Owner found the portal anyway.
    await w.service.claim(shop.owner, { idempotencyKey: 'k-1', termsVersion: TRIAL_TERMS_VERSION });
    await w.notices.deliverNow();
    expect(w.noticesOf(shop)).toEqual([expect.objectContaining({ state: 'cancelled', cancelReason: 'trial_not_available' })]);
    expect(sentWhatsApp(w)).toEqual([]);
  });
});

describe('WhatsApp first; email only for a recorded reason, to a verified address', () => {
  const both = { contacts: 'both' as const };
  async function fallback(options: WorldOptions, prepare: (w: TrialWorld, b: Business) => void = () => undefined) {
    const w = makeTrialWorld(options);
    const shop = w.business(both);
    prepare(w, shop);
    await sendAutomatic(w, shop);
    return { w, shop, notice: w.noticesOf(shop)[0] };
  }

  it('the template not approved: email, with the reason — the portal’s address as its one link', async () => {
    const { w, shop, notice } = await fallback({ templates: {} });
    expect(sentWhatsApp(w)).toEqual([]);
    expect(sentEmail(w)).toEqual([
      expect.objectContaining({
        to: shop.email,
        template: 'portal.instructions',
        variables: { business: 'Shop 1', link: PORTAL_URL },
        idempotencyKey: `notice:${binToUuid(notice.id)}:email`,
      }),
    ]);
    expect(notice).toMatchObject({
      state: 'accepted',
      channel: 'email',
      whatsappOutcome: 'unavailable',
      fallbackReason: 'template_unavailable',
      emailOutcome: 'accepted',
      destinationMasked: 'o•••@shop.test',
    });
  });

  it('WhatsApp disabled, or closed until its delivery is proven: email, whatsapp_disabled', async () => {
    for (const whatsapp of [new DisabledWhatsAppChannel(), new ProvenWhatsAppChannel(new TestWhatsAppChannel(), { isProven: false, missing: ['en'] })]) {
      const { notice } = await fallback({ whatsapp });
      expect(notice).toMatchObject({ state: 'accepted', channel: 'email', fallbackReason: 'whatsapp_disabled' });
    }
  });

  it('a number the provider said cannot receive messages: email, number_undeliverable', async () => {
    const { notice } = await fallback({}, (w, b) => w.contact(b.phone!, { undeliverableAt: NOW }));
    expect(notice).toMatchObject({ state: 'accepted', channel: 'email', fallbackReason: 'number_undeliverable' });
  });

  it('an immediate refusal by the provider: email, provider_refused — the refusal recorded', async () => {
    const whatsapp = new TestWhatsAppChannel();
    whatsapp.nextResult = { status: 'failed', reason: 'rejected', detail: 'Provider rejected the message', provider: 'test' };
    const { notice } = await fallback({ whatsapp });
    expect(notice).toMatchObject({ state: 'accepted', channel: 'email', whatsappOutcome: 'failed', fallbackReason: 'provider_refused' });
  });

  it('temporary failures: retried with a growing pause under the same key, then email once retries are exhausted', async () => {
    const whatsapp = new TestWhatsAppChannel();
    whatsapp.nextResult = { status: 'failed', reason: 'temporary', detail: 'Provider unavailable (503)', provider: 'test' };
    const { w, shop } = await fallback({ whatsapp });
    expect(w.noticesOf(shop)[0]).toMatchObject({ state: 'pending', whatsappOutcome: 'temporary', attempts: 1 });
    expect(w.noticesOf(shop)[0].nextAttemptAt).toEqual(new Date(NOW.getTime() + 30 * SECOND));
    for (const pause of [30, 60, 120, 240]) {
      w.clock.advance(pause * SECOND);
      await w.notices.deliverNow();
    }
    expect(new Set(whatsapp.messages.map((m) => m.idempotencyKey)).size).toBe(1);
    expect(whatsapp.messages).toHaveLength(5);
    expect(w.noticesOf(shop)[0]).toMatchObject({ state: 'accepted', channel: 'email', fallbackReason: 'retries_exhausted' });
    expect(sentEmail(w)).toHaveLength(1);
  });

  it('the Owner’s withdrawal, an earlier STOP, or no consent in force — in any mode: not sent, and never carried another way', async () => {
    const optedOut = await fallback({}, (w, b) => w.contact(b.phone!, { optOutScope: 'optional' }));
    expect(optedOut.notice).toMatchObject({ state: 'failed', whatsappOutcome: 'refused', failureReason: 'opted_out', fallbackReason: null });
    expect(sentEmail(optedOut.w)).toEqual([]);
    const withdrawn = await fallback({}, (w, b) => w.contact(b.phone!, { consented: false, consent: 'withdrawn', optOutScope: 'all' }));
    expect(withdrawn.notice).toMatchObject({ state: 'failed', failureReason: 'opted_out' });
    expect(sentEmail(withdrawn.w)).toEqual([]);
    for (const whatsappMode of ['test', 'live'] as const) {
      for (const consent of ['none', 'outdated'] as const) {
        // An account from before D213, or a consent to an earlier copy: never opted in by anything but the person.
        const noConsent = await fallback({ whatsappMode }, (w, b) => w.contact(b.phone!, { consented: false, consent }));
        expect(noConsent.notice).toMatchObject({ state: 'failed', failureReason: 'no_consent' });
        expect(sentEmail(noConsent.w)).toEqual([]);
      }
    }
    // With the consent in force, it goes by WhatsApp only.
    const consented = await fallback({ whatsappMode: 'live' });
    expect(consented.notice).toMatchObject({ state: 'accepted', channel: 'whatsapp' });
    expect(sentEmail(consented.w)).toEqual([]);
  });

  it('a reason to fall back but no verified email, or no email to send with: failed — honestly, with the destination masked', async () => {
    const w = makeTrialWorld({ templates: {} });
    const unverified = w.business({ contacts: 'both', verified: ['phone'] });
    await sendAutomatic(w, unverified);
    expect(w.noticesOf(unverified)[0]).toMatchObject({ state: 'failed', fallbackReason: 'template_unavailable', emailOutcome: 'not_applicable', failureReason: 'no_email' });
    const noPortal = makeTrialWorld({ templates: {}, portalUrl: '' });
    const shop = noPortal.business({ contacts: 'both' });
    await sendAutomatic(noPortal, shop);
    expect(noPortal.noticesOf(shop)[0]).toMatchObject({ state: 'failed', failureReason: 'email_unavailable', destinationMasked: 'o•••@shop.test' });
    expect(sentEmail(noPortal)).toEqual([]);
  });

  it('accepted, then reported failed by the provider: one email instead — never a second, whatever replays', async () => {
    const w = makeTrialWorld();
    const shop = w.business(both);
    await sendAutomatic(w, shop);
    const [notice] = w.noticesOf(shop);
    w.whatsappStatus(keyOf(notice), 'failed');
    await w.notices.watchAccepted();
    await w.notices.deliverNow();
    await w.notices.watchAccepted();
    await w.notices.deliverNow();
    expect(sentEmail(w)).toHaveLength(1);
    expect(w.noticesOf(shop)[0]).toMatchObject({ state: 'accepted', channel: 'email', whatsappOutcome: 'failed_async', fallbackReason: 'async_failed' });
  });

  it('a receipt not yet arrived never sends the email; a delivery completes the message', async () => {
    const w = makeTrialWorld();
    const shop = w.business(both);
    await sendAutomatic(w, shop);
    const [notice] = w.noticesOf(shop);
    w.whatsappStatus(keyOf(notice), 'sent');
    await w.notices.watchAccepted();
    await w.notices.deliverNow();
    expect(sentEmail(w)).toEqual([]);
    expect(w.noticesOf(shop)[0]).toMatchObject({ state: 'accepted', completedAt: null });
    w.whatsappStatus(keyOf(notice), 'delivered');
    await w.notices.watchAccepted();
    expect(w.noticesOf(shop)[0]).toMatchObject({ state: 'delivered', whatsappOutcome: 'delivered', completedAt: NOW });
  });
});

describe('the portal’s resend — after the Owner signs in, never from the app', () => {
  it('queues a resend to the asking Owner, audited; the answer lists both requests, newest first', async () => {
    const w = makeTrialWorld();
    const shop = w.business();
    await sendAutomatic(w, shop);
    w.clock.advance(MINUTE);
    const setup = await w.setup.resend(shop.owner);

    expect(setup).toMatchObject({ delivery: 'sent', channel: 'whatsapp', destination: '+222••••0001', canResendNow: false, resendBlockedBy: 'throttle' });
    expect(setup.history.map((h) => [h.trigger, h.delivery])).toEqual([
      ['resend', 'sent'],
      ['automatic', 'sent'],
    ]);
    const resent = w.noticesOf(shop)[1];
    expect(resent.threshold).toMatch(/^resend:[0-9a-f-]{36}$/);
    expect(resent.requestedByUserId.equals(shop.ownerId)).toBe(true);
    expect(w.audits(shop)).toEqual([
      expect.objectContaining({ action: 'trial.instructions_resend', actor: `user:${binToUuid(shop.ownerId)}`, afterJson: { trigger: 'resend' } }),
    ]);
    expect(sentWhatsApp(w)).toHaveLength(2);
  });

  it('throttled: a minute after any request, three in 15 minutes — each refusal saying exactly when', async () => {
    const w = makeTrialWorld();
    const shop = w.business();
    await sendAutomatic(w, shop);
    expect(await refusal(w.setup.resend(shop.owner))).toMatchObject({
      code: 'too_many_requests',
      status: 429,
      body: { resendAvailableAt: new Date(NOW.getTime() + MINUTE).toISOString() },
    });
    w.clock.advance(MINUTE);
    await w.setup.resend(shop.owner);
    w.clock.advance(MINUTE);
    await w.setup.resend(shop.owner);
    w.clock.advance(MINUTE);
    expect(await refusal(w.setup.resend(shop.owner))).toMatchObject({
      code: 'too_many_requests',
      body: { resendAvailableAt: new Date(NOW.getTime() + 15 * MINUTE).toISOString() },
    });
    expect(w.noticesOf(shop)).toHaveLength(3);
  });

  it('refused in order: not the Owner, cannot claim, a contact unverified — before anything is queued', async () => {
    const w = makeTrialWorld();
    const shop = w.business();
    for (const role of ['store_manager', 'store_employee', 'administrator'] as const) {
      expect(await refusal(w.setup.resend(w.staff(shop, role)))).toMatchObject({ code: 'owner_only', status: 403 });
    }
    const claimed = w.business();
    await w.service.claim(claimed.owner, { idempotencyKey: 'k-1', termsVersion: TRIAL_TERMS_VERSION });
    expect(await refusal(w.setup.resend(claimed.owner))).toMatchObject({ code: 'trial_not_available', status: 409 });
    const waiting = w.business({ verified: [] });
    expect(await refusal(w.setup.resend(waiting.owner))).toMatchObject({ code: 'contact_unverified', body: { missingContacts: ['phone'] } });
    expect(w.t.notices).toEqual([]);
  });

  it('nothing can carry it: 503 setup_delivery_unavailable, nothing queued — and the card says so instead of counting down', async () => {
    const w = makeTrialWorld({ whatsapp: new DisabledWhatsAppChannel() });
    const shop = w.business();
    expect(await refusal(w.setup.resend(shop.owner))).toMatchObject({ code: 'setup_delivery_unavailable', status: 503 });
    expect(w.t.notices).toEqual([]);
    expect((await w.service.status(shop.owner)).setup).toMatchObject({ canResendNow: false, resendBlockedBy: 'unavailable' });
  });
});

describe('what the Owner is told', () => {
  it('the app: display fields only — duration, the contact, masked destinations, where the instructions stand, the zone', async () => {
    const w = makeTrialWorld();
    const shop = w.business({ timezone: 'Asia/Dubai' });
    await sendAutomatic(w, shop);
    expect(await w.setup.appStatus(shop.owner)).toEqual({
      state: 'trial_available',
      eligible: true,
      durationHours: 168,
      durationDays: 7,
      requiredContacts: ['phone'],
      missingContacts: [],
      destinations: [{ channel: 'whatsapp', masked: '+222••••0001' }],
      delivery: 'sent',
      channel: 'whatsapp',
      destination: '+222••••0001',
      fallbackReason: null,
      failureReason: null,
      lastAttemptAt: NOW.toISOString(),
      lastSentAt: NOW.toISOString(),
      timeZone: 'Asia/Dubai',
    });
  });

  it('waiting for the number before anything is sent; failed with its reason; a business that cannot claim is told only its state', async () => {
    const w = makeTrialWorld();
    const waiting = w.business({ verified: [] });
    expect(await w.setup.appStatus(waiting.owner)).toMatchObject({ delivery: 'waiting_for_contact', missingContacts: ['phone'] });
    const optedOut = w.business();
    w.contact(optedOut.phone!, { optOutScope: 'optional' });
    await sendAutomatic(w, optedOut);
    expect(await w.setup.appStatus(optedOut.owner)).toMatchObject({ delivery: 'failed', failureReason: 'opted_out', destination: '+222••••0002', lastSentAt: null });
    const claimed = w.business();
    await w.service.claim(claimed.owner, { idempotencyKey: 'k-1', termsVersion: TRIAL_TERMS_VERSION });
    expect(await w.setup.appStatus(claimed.owner)).toEqual({ state: 'trial_active', eligible: false });
    expect(await refusal(w.setup.appStatus(w.staff(claimed, 'store_manager')))).toMatchObject({ code: 'owner_only' });
  });

  it('sent only while the destination is still the Owner’s: a number replaced since reads not_sent — and when it was sent stays', async () => {
    const w = makeTrialWorld();
    const shop = w.business();
    await sendAutomatic(w, shop);
    w.owner(shop).phone = '+22236999999';
    expect(await w.setup.appStatus(shop.owner)).toMatchObject({ delivery: 'not_sent', lastSentAt: NOW.toISOString() });
  });
});

describe('delivery is never a condition for claiming', () => {
  it('failed, or nothing could carry it: the portal shows the same offer, and the Owner claims', async () => {
    const w = makeTrialWorld({ whatsapp: new DisabledWhatsAppChannel() });
    const shop = w.business();
    await sendAutomatic(w, shop);
    expect(w.noticesOf(shop)[0]).toMatchObject({ state: 'failed', failureReason: 'no_email' });
    expect((await w.service.status(shop.owner)).offer).toMatchObject({ available: true });
    await expect(w.service.claim(shop.owner, { idempotencyKey: 'k-1', termsVersion: TRIAL_TERMS_VERSION })).resolves.toMatchObject({ state: 'trial_active' });
  });
});

describe('instants and secrets', () => {
  it('no audit or row holds a contact, and no variable holds a token, an identifier or a link (except the email’s portal address)', async () => {
    const w = makeTrialWorld({ templates: {} });
    const shop = w.business({ contacts: 'both' });
    await sendAutomatic(w, shop);
    w.clock.advance(MINUTE);
    await w.setup.resend(shop.owner);
    expect(JSON.stringify(w.t.audits)).not.toMatch(/@shop\.test|\+2223/);
    for (const n of w.t.notices) {
      expect(JSON.stringify({ ...n, destinationHash: null })).not.toMatch(/owner\d+@shop\.test|\+22236\d{6}/);
    }
    for (const m of sentEmail(w)) expect(Object.values(m.variables).filter((v) => /https?:/.test(v))).toEqual([PORTAL_URL]);
  });

  it('reads no clock but the injected one, and nothing a request says about where it came from', () => {
    for (const file of ['src/platform/trial/trial-setup.service.ts', 'src/notices/notice.service.ts']) {
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect({ file, clock: /new Date\(\)|Date\.now\(/.test(code) }).toEqual({ file, clock: false });
      expect({ file, request: /origin|referer|referrer|headers|req\./i.test(code) }).toEqual({ file, request: false });
    }
  });
});
