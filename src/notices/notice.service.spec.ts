import { TestWhatsAppChannel } from '../messaging/channels';
import { NOW, PORTAL_URL, TestEmailChannel, makeTrialWorld, type Business, type TrialWorld } from '../platform/__testing__/trial-world';
import { TRIAL_TERMS_VERSION } from '../platform/trial/trial-rules';

/**
 * The subscription messages' outbox over a business's timeline (0099; docs/101 §6), on the in-memory world that
 * refuses duplicates like the database — the real NoticeService, the real rules, recording providers.
 *
 * What is proven: the one message that applies is created once and sent once, by WhatsApp first, with what it must
 * say in the business's zone and language; what a later slot replaces is superseded, never sent late; a renewal, a
 * suspension or a cancellation retires what it made obsolete, and a reinstatement revives what a suspension stopped;
 * a paid end says whether grace started — with its exact end and the uses left — or why not; a trial's messages never
 * offer grace; and a grant, or paid access after a trial, sends nothing it should not.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const sent = (w: TrialWorld) => (w.whatsapp as TestWhatsAppChannel).messages;
const states = (w: TrialWorld, b: Business) => w.noticesOf(b).map((n) => `${n.kind}:${n.threshold}:${n.state}`);

async function tick(w: TrialWorld, b: Business): Promise<void> {
  await w.notices.refresh(b.companyId);
  await w.notices.deliverNow();
}

/** A business with a paid period ending at `end`, its Owner's number verified. */
function paidBusiness(w: TrialWorld, end: Date, extra: Parameters<TrialWorld['business']>[0] = {}): Business {
  return w.business({ status: 'activated', currentPeriodEnd: end, eligibilityClosed: 'approved', timezone: 'UTC', ...extra });
}

describe('a paid period’s reminders', () => {
  it('72 hours before the end: one WhatsApp message saying 3 days and the exact end in the business’s zone', async () => {
    const w = makeTrialWorld();
    const end = new Date(NOW.getTime() + 71 * HOUR);
    const shop = paidBusiness(w, end, { name: 'Boutique Aicha', timezone: 'Asia/Dubai' });
    await tick(w, shop);
    await tick(w, shop);

    expect(sent(w)).toEqual([
      expect.objectContaining({
        to: shop.phone,
        template: 'subscription.paid_reminder',
        variables: { business: 'Boutique Aicha', remaining: '3 days', ends: '16 October 2026, 13:00 (Gulf Standard Time)' },
      }),
    ]);
    expect(states(w, shop)).toEqual(['paid_reminder:h72:accepted']);
    expect(w.noticesOf(shop)[0]).toMatchObject({ periodKey: `paid:${end.getTime()}`, channel: 'whatsapp', dueAt: new Date(end.getTime() - 72 * HOUR) });
  });

  it('no backlog burst: a 72-hour reminder still waiting when the 48-hour one applies is superseded, and only that one goes', async () => {
    const whatsapp = new TestWhatsAppChannel();
    const w = makeTrialWorld({ whatsapp });
    const end = new Date(NOW.getTime() + 71 * HOUR);
    const shop = paidBusiness(w, end);
    whatsapp.nextResult = { status: 'failed', reason: 'temporary', detail: 'Provider unavailable (503)', provider: 'test' };
    await tick(w, shop);
    expect(states(w, shop)).toEqual(['paid_reminder:h72:pending']);

    whatsapp.nextResult = null;
    w.clock.advance(24 * HOUR);
    await tick(w, shop);
    expect(states(w, shop)).toEqual(['paid_reminder:h72:superseded', 'paid_reminder:h48:accepted']);
    expect(sent(w).filter((m) => m.variables.remaining === '2 days')).toHaveLength(1);
  });

  it('a renewal retires what it made obsolete — the waiting reminder is cancelled; a reminder already going out is re-checked first', async () => {
    const whatsapp = new TestWhatsAppChannel();
    const w = makeTrialWorld({ whatsapp });
    const shop = paidBusiness(w, new Date(NOW.getTime() + 23 * HOUR));
    whatsapp.nextResult = { status: 'failed', reason: 'temporary', detail: 'busy', provider: 'test' };
    await tick(w, shop);
    whatsapp.nextResult = null;
    // Renewed: the period now ends a month later.
    w.subscription(shop).currentPeriodEnd = new Date(NOW.getTime() + 30 * DAY);
    w.clock.advance(HOUR);
    await w.notices.deliverNow();
    expect(w.noticesOf(shop)[0]).toMatchObject({ state: 'cancelled', cancelReason: 'period_changed' });
    expect(sent(w).filter((m) => m.variables.remaining)).toHaveLength(1);
  });

  it('a suspension cancels; the reinstatement revives the same message while its slot lasts', async () => {
    const whatsapp = new TestWhatsAppChannel();
    const w = makeTrialWorld({ whatsapp });
    const shop = paidBusiness(w, new Date(NOW.getTime() + 23 * HOUR));
    whatsapp.nextResult = { status: 'failed', reason: 'temporary', detail: 'busy', provider: 'test' };
    await tick(w, shop);
    w.subscription(shop).status = 'suspended';
    await w.notices.refresh(shop.companyId);
    expect(w.noticesOf(shop)[0]).toMatchObject({ state: 'cancelled', cancelReason: 'suspended' });

    whatsapp.nextResult = null;
    w.subscription(shop).status = 'activated';
    await tick(w, shop);
    expect(states(w, shop)).toEqual(['paid_reminder:h24:accepted']);
  });

  it('once per identity, whatever refreshes run at once', async () => {
    const w = makeTrialWorld();
    const shop = paidBusiness(w, new Date(NOW.getTime() + 47 * HOUR));
    await Promise.all([w.notices.refresh(shop.companyId), w.notices.refresh(shop.companyId), w.notices.refresh(shop.companyId)]);
    await w.notices.deliverNow();
    await tick(w, shop);
    expect(w.noticesOf(shop)).toHaveLength(1);
    expect(sent(w)).toHaveLength(1);
  });

  it('nothing for an end a platform grant covers, a suspended business, or a closed one', async () => {
    const w = makeTrialWorld();
    const end = new Date(NOW.getTime() + 23 * HOUR);
    const granted = paidBusiness(w, end, { complimentaryUntil: new Date(end.getTime() + 30 * DAY) });
    const suspended = paidBusiness(w, end, { status: 'suspended' });
    const closed = paidBusiness(w, end, { closed: true });
    for (const b of [granted, suspended, closed]) await tick(w, b);
    expect(w.t.notices).toEqual([]);
    expect(sent(w)).toEqual([]);
  });
});

describe('a paid period’s end, and its grace', () => {
  it('waits for the recorded decision; with grace: the exact grace end and the uses left after this one', async () => {
    const w = makeTrialWorld();
    const end = new Date(NOW.getTime() - HOUR);
    const shop = paidBusiness(w, end, { language: 'fr' });
    await tick(w, shop);
    expect(w.noticesOf(shop)).toEqual([]);

    w.grace(shop, 'granted', 1);
    await tick(w, shop);
    expect(sent(w)).toEqual([
      expect.objectContaining({
        template: 'subscription.grace_started',
        language: 'fr',
        variables: {
          business: 'Shop 1',
          ended: '13 octobre 2026, 09:00 (temps universel coordonné)',
          graceEnds: '16 octobre 2026, 09:00 (temps universel coordonné)',
          usesLeft: '1',
        },
      }),
    ]);
    expect(w.noticesOf(shop)[0]).toMatchObject({ kind: 'paid_expired', variant: 'grace_started' });
  });

  it('without grace: the no-grace message — never one that suggests grace', async () => {
    const w = makeTrialWorld();
    const shop = paidBusiness(w, new Date(NOW.getTime() - HOUR));
    w.grace(shop, 'refused', 3);
    await tick(w, shop);
    expect(sent(w)).toEqual([expect.objectContaining({ template: 'subscription.no_grace', variables: { business: 'Shop 1', ended: '13 October 2026, 09:00 (Coordinated Universal Time)' } })]);
    w.clock.advance(30 * HOUR);
    await tick(w, shop);
    expect(sent(w)).toHaveLength(1);
  });

  it('48 and 24 hours of grace left, then its end — each once', async () => {
    const w = makeTrialWorld();
    const end = new Date(NOW.getTime() - 25 * HOUR);
    const shop = paidBusiness(w, end);
    w.grace(shop, 'granted');
    await tick(w, shop);
    w.clock.advance(24 * HOUR);
    await tick(w, shop);
    w.clock.advance(24 * HOUR);
    await tick(w, shop);
    expect(sent(w).map((m) => [m.template, m.variables.remaining ?? null])).toEqual([
      ['subscription.grace_reminder', '48 hours'],
      ['subscription.grace_reminder', '24 hours'],
      ['subscription.grace_ended', null],
    ]);
    expect(sent(w)[0].variables.graceEnds).toBe('15 October 2026, 09:00 (Coordinated Universal Time)');
    expect(states(w, shop)).toEqual(['grace_reminder:h48:accepted', 'grace_reminder:h24:accepted', 'grace_ended:end:accepted']);
  });
});

describe('a free trial’s messages', () => {
  it('72 hours before its end, the reminder; at its end, the message that it ended — neither offers grace', async () => {
    const w = makeTrialWorld();
    const shop = w.business({ timezone: 'UTC' });
    await w.service.claim(shop.owner, { idempotencyKey: 'k-1', termsVersion: TRIAL_TERMS_VERSION });
    w.clock.advance(96 * HOUR);
    await tick(w, shop);
    w.clock.advance(72 * HOUR);
    await tick(w, shop);
    expect(sent(w).map((m) => m.template)).toEqual(['subscription.trial_reminder', 'subscription.trial_expired']);
    expect(sent(w)[0].variables).toEqual({ business: 'Shop 1', remaining: '3 days', ends: '20 October 2026, 10:00 (Coordinated Universal Time)' });
    expect(w.noticesOf(shop).every((n) => n.periodKey.startsWith('trial:'))).toBe(true);
  });

  it('nothing about its end once paid access follows it', async () => {
    const w = makeTrialWorld();
    const shop = w.business({ timezone: 'UTC' });
    await w.service.claim(shop.owner, { idempotencyKey: 'k-1', termsVersion: TRIAL_TERMS_VERSION });
    const sub = w.subscription(shop);
    sub.status = 'activated';
    sub.currentPeriodEnd = new Date(NOW.getTime() + 168 * HOUR + 30 * DAY);
    w.clock.advance(150 * HOUR);
    await tick(w, shop);
    expect(sent(w)).toEqual([]);
  });
});

describe('email, when WhatsApp cannot carry a lifecycle message', () => {
  it('the same facts, with the portal’s address as its one link', async () => {
    const w = makeTrialWorld({ templates: {} });
    const shop = paidBusiness(w, new Date(NOW.getTime() + 23 * HOUR), { contacts: 'both' });
    await tick(w, shop);
    expect((w.email as TestEmailChannel).sent).toEqual([
      expect.objectContaining({
        template: 'subscription.paid_reminder',
        variables: { business: 'Shop 1', remaining: '1 day', ends: '14 October 2026, 09:00 (Coordinated Universal Time)', link: PORTAL_URL },
      }),
    ]);
    expect(w.noticesOf(shop)[0]).toMatchObject({ state: 'accepted', channel: 'email', fallbackReason: 'template_unavailable' });
  });

  it('a reminder and a read-only notice to an Owner without WhatsApp consent go by the verified email, once each — never also by WhatsApp (D213)', async () => {
    const w = makeTrialWorld();
    const shop = w.business({ timezone: 'UTC', contacts: 'both' });
    w.contact(shop.phone!, { consented: false, consent: 'none' });
    await w.service.claim(shop.owner, { idempotencyKey: 'k-1', termsVersion: TRIAL_TERMS_VERSION });
    w.clock.advance(96 * HOUR);
    await tick(w, shop);
    await tick(w, shop);
    w.clock.advance(72 * HOUR);
    await tick(w, shop);
    await tick(w, shop);
    expect(sent(w)).toEqual([]);
    expect((w.email as TestEmailChannel).sent.map((m) => m.template)).toEqual(['subscription.trial_reminder', 'subscription.trial_expired']);
    expect(w.noticesOf(shop).filter((n) => n.kind !== 'portal_instructions').map((n) => [n.kind, n.channel, n.fallbackReason])).toEqual([
      ['trial_reminder', 'email', 'consent_missing'],
      ['trial_expired', 'email', 'consent_missing'],
    ]);
  });

  it('an Owner who withdrew WhatsApp still receives the informational notices by the verified email', async () => {
    const w = makeTrialWorld();
    const shop = paidBusiness(w, new Date(NOW.getTime() + 23 * HOUR), { contacts: 'both' });
    w.contact(shop.phone!, { consented: false, consent: 'withdrawn', optOutScope: 'all' });
    await tick(w, shop);
    expect(sent(w)).toEqual([]);
    expect((w.email as TestEmailChannel).sent).toEqual([expect.objectContaining({ template: 'subscription.paid_reminder' })]);
    expect(w.noticesOf(shop)[0]).toMatchObject({ state: 'accepted', channel: 'email', fallbackReason: 'consent_withdrawn' });
  });
});

describe('the timeline as the portal and the console read it', () => {
  it('the next message as things stand, and the newest one with what became of it', async () => {
    const w = makeTrialWorld();
    const end = new Date(NOW.getTime() + 71 * HOUR);
    const shop = paidBusiness(w, end);
    expect(await w.notices.timelineOf(shop.companyId)).toEqual({
      next: { kind: 'paid_reminder', threshold: 'h48', dueAt: new Date(end.getTime() - 48 * HOUR).toISOString() },
      last: null,
    });
    await tick(w, shop);
    expect((await w.notices.timelineOf(shop.companyId)).last).toMatchObject({
      kind: 'paid_reminder',
      threshold: 'h72',
      state: 'accepted',
      channel: 'whatsapp',
      destination: '+222••••0001',
      at: NOW.toISOString(),
    });
  });
});
