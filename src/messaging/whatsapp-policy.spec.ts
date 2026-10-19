import {
  ConsentGatedWhatsAppChannel,
  consentRefusal,
  GovernedWhatsAppChannel,
  parseTestRecipients,
  policyRefusal,
  SendPacer,
  type WhatsAppSendControls,
} from './whatsapp-policy';
import { WhatsAppRecords } from './whatsapp-records';
import { recipientHash } from './recipient-hash';
import { ProvenWhatsAppChannel } from './delivery-readiness';
import type { DeliveryResult, WhatsAppChannel, WhatsAppMessage } from './whatsapp-channel';
import { fakeMessagingPrisma } from './__testing__/fake-messaging-prisma';
import { WHATSAPP_CONSENT_VERSION } from './whatsapp-consent';

/**
 * What may leave the server by WhatsApp (D181 §4; D213): test and live sending are independent controls, test mode
 * reaches only its exact allowlist, live sends are off until enabled, every message needs the operational consent in
 * force — in every mode — and every decision is recorded without the variables.
 */

const KEY = 'test-messaging-hash-key-of-32-characters!';
const TEST_NUMBER = '+22236963839';
const CUSTOMER = '+22244556677';
const COMPANY = Buffer.alloc(16, 1);
const USER = Buffer.alloc(16, 2);

/** The number's owner ticks the consent in force, as registration does. */
async function consent(records: WhatsAppRecords, number: string) {
  await records.recordConsent({ number, version: WHATSAPP_CONSENT_VERSION, locale: 'en', companyId: COMPANY, userId: USER, source: 'mobile_registration' });
}

function inner(result: DeliveryResult = { status: 'accepted', providerMessageId: 'wamid.X', provider: 'cloud-api' }) {
  const calls: WhatsAppMessage[] = [];
  let next: DeliveryResult = result;
  const channel: WhatsAppChannel & { calls: WhatsAppMessage[]; set(r: DeliveryResult): void } = {
    name: 'cloud-api',
    isEnabled: true,
    calls,
    set(r) {
      next = r;
    },
    async send(m) {
      calls.push(m);
      return next;
    },
  };
  return channel;
}

function controls(over: Partial<WhatsAppSendControls> = {}): WhatsAppSendControls {
  return {
    mode: 'test',
    testRecipients: new Set([TEST_NUMBER]),
    liveSends: false,
    phoneNumberId: '1297799316760335',
    maxPerSecond: 100,
    recipientMinIntervalMs: 0,
    ...over,
  };
}

function governed(c: Partial<WhatsAppSendControls> = {}, result?: DeliveryResult) {
  const db = fakeMessagingPrisma();
  const records = new WhatsAppRecords(db as never, { hash: (n: string) => recipientHash(n, KEY) } as never);
  const raw = inner(result);
  const channel = new GovernedWhatsAppChannel(raw, controls(c), records);
  return { channel, raw, db, records };
}

/** A governed channel whose test recipient and customer both consented, as registration leaves them. */
async function consented(c: Partial<WhatsAppSendControls> = {}, result?: DeliveryResult) {
  const g = governed(c, result);
  await consent(g.records, TEST_NUMBER);
  await consent(g.records, CUSTOMER);
  return g;
}

const otp = (to: string, key = `k-${Math.random()}`): WhatsAppMessage => ({
  to,
  template: 'auth.otp',
  language: 'en',
  variables: { code: '482913', ttlMinutes: '5' },
  idempotencyKey: key,
});
const closing = (to: string): WhatsAppMessage => ({
  to,
  template: 'closing.sale',
  language: 'fr',
  variables: { branch: 'Tevragh Zeina', time: '22:10', date: '17/10', item: 'iPhone 15', money: '25 000 MRU' },
  idempotencyKey: `c-${Math.random()}`,
});
const proof = (to: string): WhatsAppMessage => ({ to, template: 'delivery.check', language: 'ar', variables: { reference: 'A1B2C3' }, idempotencyKey: `p-${Math.random()}` });

describe('the test allowlist', () => {
  it('takes exact E.164 numbers, comma- or space-separated, and refuses anything else', () => {
    expect(parseTestRecipients('+22236963839, +15556628062')).toEqual(['+22236963839', '+15556628062']);
    expect(parseTestRecipients('')).toEqual([]);
    expect(() => parseTestRecipients('22236963839')).toThrow(/E\.164/);
    expect(() => parseTestRecipients('+222 36 96 38 39')).toThrow(/E\.164/);
  });
});

describe('the decision', () => {
  const granted = { optOutScope: 'none' as const, consented: true, consent: 'granted' as const, undeliverableAt: null };
  const none = { ...granted, consented: false, consent: 'none' as const };
  const outdated = { ...granted, consented: false, consent: 'outdated' as const };
  const withdrawn = { optOutScope: 'all' as const, consented: false, consent: 'withdrawn' as const, undeliverableAt: null };

  it('test mode reaches ONLY the allowlist — never a number merely because the application has it', () => {
    const c = controls();
    expect(policyRefusal(c, 'essential', TEST_NUMBER, granted)).toBeNull();
    expect(policyRefusal(c, 'essential', CUSTOMER, granted)).toEqual({ reason: 'channel_unavailable', detail: expect.stringMatching(/not an allowlisted test recipient/) });
    // Live sends being enabled changes nothing in test mode.
    expect(policyRefusal({ ...c, liveSends: true }, 'essential', CUSTOMER, granted)).not.toBeNull();
  });

  it('live mode sends nothing while WHATSAPP_LIVE_SENDS is disabled — not even a sign-in code', () => {
    const c = controls({ mode: 'live', liveSends: false });
    for (const use of ['essential', 'optional', 'operator'] as const) expect(policyRefusal(c, use, CUSTOMER, granted)).not.toBeNull();
    expect(policyRefusal(c, 'essential', CUSTOMER, granted)?.reason).toBe('channel_unavailable');
  });

  it('live mode with live sends enabled: a consented number receives its messages; the delivery check never goes', () => {
    const c = controls({ mode: 'live', liveSends: true });
    expect(policyRefusal(c, 'essential', CUSTOMER, granted)).toBeNull();
    expect(policyRefusal(c, 'optional', CUSTOMER, granted)).toBeNull();
    expect(policyRefusal(c, 'operator', CUSTOMER, granted)).toEqual({ reason: 'rejected', detail: 'The delivery check is sent in test mode only' });
  });

  it('a missing or outdated consent refuses every message, in test mode as in live mode', () => {
    for (const c of [controls(), controls({ mode: 'live', liveSends: true })]) {
      const to = c.mode === 'test' ? TEST_NUMBER : CUSTOMER;
      for (const contact of [none, outdated]) {
        expect(policyRefusal(c, 'optional', to, contact)?.detail).toBe('No current operational WhatsApp consent');
        expect(policyRefusal(c, 'essential', to, contact)?.detail).toBe('No current operational WhatsApp consent');
      }
    }
  });

  it('the code that verifies a number not yet verified is the one message that goes before a consent', () => {
    const c = controls({ mode: 'live', liveSends: true });
    expect(policyRefusal(c, 'essential', CUSTOMER, none, true)).toBeNull();
    // Never a proactive message, and never once the number withdrew.
    expect(policyRefusal(c, 'optional', CUSTOMER, none, true)).not.toBeNull();
    expect(policyRefusal(c, 'essential', CUSTOMER, withdrawn, true)?.detail).toMatch(/withdrew operational WhatsApp consent/);
  });

  it('a withdrawal stops everything, codes included — nothing pretends it still works', () => {
    expect(policyRefusal(controls({ mode: 'live', liveSends: true }), 'essential', CUSTOMER, withdrawn)?.detail).toMatch(/withdrew/);
    expect(policyRefusal(controls(), 'essential', TEST_NUMBER, withdrawn)).not.toBeNull();
    expect(consentRefusal('essential', { ...granted, consent: 'withdrawn' })).not.toBeNull();
  });

  it('a STOP recorded before D213 still stops proactive messages, not the codes a consented person asks for', () => {
    const stopped = { ...granted, optOutScope: 'optional' as const };
    expect(consentRefusal('optional', stopped)?.detail).toMatch(/opted out/);
    expect(consentRefusal('essential', stopped)).toBeNull();
  });

  it('a number the provider called undeliverable gets no proactive message from the policy', () => {
    expect(consentRefusal('optional', { ...granted, undeliverableAt: new Date() })?.detail).toMatch(/cannot receive/);
    expect(consentRefusal('essential', { ...granted, undeliverableAt: new Date() })).toBeNull();
  });

  it('the operator delivery check is decided by the test-mode controls alone', () => {
    expect(consentRefusal('operator', withdrawn)).toBeNull();
  });
});

describe('the governed channel', () => {
  it('is open in test mode only with an allowlist, and in live mode only once live sends are enabled', () => {
    expect(governed().channel.isEnabled).toBe(true);
    expect(governed({ testRecipients: new Set() }).channel.isEnabled).toBe(false);
    expect(governed({ mode: 'live', liveSends: false }).channel.isEnabled).toBe(false);
    expect(governed({ mode: 'live', liveSends: true }).channel.isEnabled).toBe(true);
  });

  it('says which numbers it would send to, so nothing is created for somebody who will never get a code', () => {
    const { channel } = governed();
    expect(channel.accepts(TEST_NUMBER)).toBe(true);
    expect(channel.accepts(CUSTOMER)).toBe(false);
    expect(governed({ mode: 'live', liveSends: true }).channel.accepts(CUSTOMER)).toBe(true);
  });

  it('refuses before the provider is called, records the refusal, and never falls back anywhere', async () => {
    const { channel, raw, db } = governed();
    const result = await channel.send(otp(CUSTOMER, 'k-refused'));
    expect(result).toMatchObject({ status: 'failed', reason: 'channel_unavailable' });
    expect(raw.calls).toHaveLength(0);
    expect(db.whatsAppMessage.rows).toEqual([expect.objectContaining({ idempotencyKey: 'k-refused', status: 'refused', template: 'auth.otp', mode: 'test' })]);
  });

  it('records an accepted send without the code, the variables or the complete number', async () => {
    const { channel, raw, db } = await consented();
    const result = await channel.send(otp(TEST_NUMBER, 'k-ok'));
    expect(result).toEqual({ status: 'accepted', providerMessageId: 'wamid.X', provider: 'cloud-api' });
    expect(raw.calls).toHaveLength(1);
    const row = db.whatsAppMessage.rows[0];
    expect(row).toMatchObject({ status: 'accepted', providerMessageId: 'wamid.X', templateUse: 'essential', recipientHash: recipientHash(TEST_NUMBER, KEY), recipientMasked: '+222***39', phoneNumberId: '1297799316760335' });
    expect(JSON.stringify(row)).not.toMatch(/482913|36963839/);
  });

  it('holds every send when the records cannot be read: an opt-out that cannot be checked is not honoured by guessing', async () => {
    const { channel, raw, db } = governed();
    db.whatsAppContact.failing.add('findUnique');
    const result = await channel.send(otp(TEST_NUMBER));
    expect(result).toMatchObject({ status: 'failed', reason: 'temporary', detail: 'Message records are unavailable' });
    expect(raw.calls).toHaveLength(0);
  });

  it('a record that cannot be written after the send never turns a sent message into a failure', async () => {
    const { channel, db } = await consented();
    db.whatsAppMessage.failing.add('create');
    expect((await channel.send(otp(TEST_NUMBER))).status).toBe('accepted');
  });

  it('remembers a number the provider calls undeliverable (131026), and retries nothing', async () => {
    const { channel, raw, records } = await consented({}, { status: 'failed', reason: 'rejected', detail: 'Provider answered HTTP 400 (code 131026)', provider: 'cloud-api', providerCode: 131026 });
    const result = await channel.send(otp(TEST_NUMBER));
    expect(result).toMatchObject({ status: 'failed', reason: 'rejected', providerCode: 131026 });
    expect(raw.calls).toHaveLength(1);
    expect((await records.contactState(TEST_NUMBER)).undeliverableAt).toBeInstanceOf(Date);
  });

  it('records a refusal for the 24-hour window (131047) with its code, as a refusal, not a retry', async () => {
    const { channel, db } = await consented({}, { status: 'failed', reason: 'rejected', detail: 'outside the 24-hour customer-service window', provider: 'cloud-api', providerCode: 131047 });
    await channel.send(otp(TEST_NUMBER, 'k-window'));
    expect(db.whatsAppMessage.rows[0]).toMatchObject({ status: 'failed', failureReason: 'rejected', errorCode: 131047 });
  });

  it('a retry of a failed message (same key) is one record with two attempts, and may then be accepted', async () => {
    const { channel, raw, db } = await consented({}, { status: 'failed', reason: 'temporary', detail: 'timeout', provider: 'cloud-api' });
    await channel.send(otp(TEST_NUMBER, 'k-retry'));
    raw.set({ status: 'accepted', providerMessageId: 'wamid.R', provider: 'cloud-api' });
    await channel.send(otp(TEST_NUMBER, 'k-retry'));
    expect(db.whatsAppMessage.rows).toHaveLength(1);
    expect(db.whatsAppMessage.rows[0]).toMatchObject({ status: 'accepted', attempts: 2, providerMessageId: 'wamid.R' });
  });

  it('sends to a consented number, refuses a withdrawn one, and sends again only after a new consent', async () => {
    const { channel, raw, records } = governed();
    expect((await channel.send(closing(TEST_NUMBER))).status).toBe('failed');
    expect((await channel.send(otp(TEST_NUMBER))).status).toBe('failed');
    await consent(records, TEST_NUMBER);
    expect((await channel.send(closing(TEST_NUMBER))).status).toBe('accepted');
    expect((await channel.send(otp(TEST_NUMBER))).status).toBe('accepted');
    await records.withdrawConsent({ number: TEST_NUMBER, companyId: COMPANY, userId: USER, source: 'account_settings' });
    expect((await channel.send(otp(TEST_NUMBER))).status).toBe('failed');
    expect((await channel.send(closing(TEST_NUMBER))).status).toBe('failed');
    await consent(records, TEST_NUMBER);
    expect((await channel.send(closing(TEST_NUMBER))).status).toBe('accepted');
    expect(raw.calls).toHaveLength(3);
  });

  it('a verification code goes to a number without a consent, and records nothing but the send', async () => {
    const { channel, raw, db } = governed();
    expect((await channel.send({ ...otp(TEST_NUMBER), verifiesContact: true })).status).toBe('accepted');
    expect(raw.calls).toHaveLength(1);
    expect(db.whatsAppConsent.rows).toHaveLength(0);
  });

  it('the delivery check goes in test mode to an allowlisted number, and never in live mode', async () => {
    // No consent needed: the operator proves the sending number to their own allowlisted phone.
    expect((await governed().channel.send(proof(TEST_NUMBER))).status).toBe('accepted');
    const live = governed({ mode: 'live', liveSends: true });
    expect((await live.channel.send(proof(CUSTOMER))).status).toBe('failed');
    expect(live.raw.calls).toHaveLength(0);
  });

  it('is still closed in production until delivery is proven, whatever the policy allows (D166)', async () => {
    const { channel, raw } = governed();
    const proven = new ProvenWhatsAppChannel(channel, { isProven: false, missing: ['ar'] });
    expect(proven.isEnabled).toBe(false);
    expect(proven.accepts(TEST_NUMBER)).toBe(false);
    expect(await proven.send(otp(TEST_NUMBER))).toMatchObject({ status: 'failed', reason: 'channel_unavailable' });
    expect(raw.calls).toHaveLength(0);
  });
});

describe('pacing', () => {
  it('limits the sending number per second and keeps a gap per recipient, except for a retry of the same message', () => {
    let now = 0;
    const pacer = new SendPacer(2, 1000, () => now);
    expect(pacer.take('a', false)).toBe('ok');
    expect(pacer.take('a', false)).toBe('recipient');
    expect(pacer.take('a', true)).toBe('ok');
    expect(pacer.take('b', false)).toBe('sender');
    now = 1000;
    expect(pacer.take('b', false)).toBe('ok');
    expect(pacer.take('a', false)).toBe('ok');
  });

  it('a paced send is a temporary failure, recorded, and the provider is not called', async () => {
    const { channel, raw, db } = await consented({ recipientMinIntervalMs: 60_000 });
    await channel.send(otp(TEST_NUMBER));
    const second = await channel.send(otp(TEST_NUMBER));
    expect(second).toMatchObject({ status: 'failed', reason: 'temporary', detail: expect.stringMatching(/Too soon/) });
    expect(raw.calls).toHaveLength(1);
    expect(db.whatsAppMessage.rows[1]).toMatchObject({ status: 'refused', failureReason: 'temporary' });
  });
});

describe('the development log under the same consent rule', () => {
  function gated() {
    const db = fakeMessagingPrisma();
    const records = new WhatsAppRecords(db as never, { hash: (n: string) => recipientHash(n, KEY) } as never);
    const raw = inner({ status: 'accepted', providerMessageId: null, provider: 'development-log' });
    return { channel: new ConsentGatedWhatsAppChannel(raw, records), raw, records, db };
  }

  it('refuses what a real server would refuse, and passes what it would send', async () => {
    const { channel, raw, records, db } = gated();
    expect(await channel.send(closing(CUSTOMER))).toMatchObject({ status: 'failed', reason: 'rejected', detail: 'No current operational WhatsApp consent' });
    expect((await channel.send({ ...otp(CUSTOMER), verifiesContact: true })).status).toBe('accepted');
    await consent(records, CUSTOMER);
    expect((await channel.send(closing(CUSTOMER))).status).toBe('accepted');
    expect(raw.calls).toHaveLength(2);
    // Nothing is recorded as a provider message: the log is not a provider.
    expect(db.whatsAppMessage.rows).toHaveLength(0);
  });

  it('holds a send when the records cannot be read', async () => {
    const { channel, raw, db } = gated();
    db.whatsAppContact.failing.add('findUnique');
    expect(await channel.send(otp(CUSTOMER))).toMatchObject({ status: 'failed', reason: 'temporary' });
    expect(raw.calls).toHaveLength(0);
  });
});
