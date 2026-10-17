import { GovernedWhatsAppChannel, parseTestRecipients, policyRefusal, SendPacer, type WhatsAppSendControls } from './whatsapp-policy';
import { WhatsAppRecords } from './whatsapp-records';
import { recipientHash } from './recipient-hash';
import { ProvenWhatsAppChannel } from './delivery-readiness';
import type { DeliveryResult, WhatsAppChannel, WhatsAppMessage } from './whatsapp-channel';
import { fakeMessagingPrisma } from './__testing__/fake-messaging-prisma';

/**
 * What may leave the server by WhatsApp (D181 §4, §5): test and live sending are independent controls, test mode
 * reaches only its exact allowlist, live sends are off until enabled, a person's opt-out and consent are honoured,
 * and every decision is recorded without the variables.
 */

const KEY = 'test-messaging-hash-key-of-32-characters!';
const TEST_NUMBER = '+22236963839';
const CUSTOMER = '+22244556677';

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
  const none = { optOutScope: 'none' as const, consented: false };

  it('test mode reaches ONLY the allowlist — never a number merely because the application has it', () => {
    const c = controls();
    expect(policyRefusal(c, 'essential', TEST_NUMBER, none)).toBeNull();
    expect(policyRefusal(c, 'essential', CUSTOMER, none)).toEqual({ reason: 'channel_unavailable', detail: expect.stringMatching(/not an allowlisted test recipient/) });
    // Live sends being enabled changes nothing in test mode.
    expect(policyRefusal({ ...c, liveSends: true }, 'essential', CUSTOMER, none)).not.toBeNull();
  });

  it('live mode sends nothing while WHATSAPP_LIVE_SENDS is disabled — not even a sign-in code', () => {
    const c = controls({ mode: 'live', liveSends: false });
    for (const use of ['essential', 'optional', 'operator'] as const) expect(policyRefusal(c, use, CUSTOMER, { ...none, consented: true })).not.toBeNull();
    expect(policyRefusal(c, 'essential', CUSTOMER, none)?.reason).toBe('channel_unavailable');
  });

  it('live mode with live sends enabled: essential messages go; the delivery check never does', () => {
    const c = controls({ mode: 'live', liveSends: true });
    expect(policyRefusal(c, 'essential', CUSTOMER, none)).toBeNull();
    expect(policyRefusal(c, 'operator', CUSTOMER, none)).toEqual({ reason: 'rejected', detail: 'The delivery check is sent in test mode only' });
  });

  it('an opt-out of optional notices stops closing notices but not the codes a person asks for', () => {
    const c = controls({ mode: 'live', liveSends: true });
    const optedOut = { optOutScope: 'optional' as const, consented: true };
    expect(policyRefusal(c, 'optional', CUSTOMER, optedOut)?.detail).toMatch(/opted out of optional/);
    expect(policyRefusal(c, 'essential', CUSTOMER, optedOut)).toBeNull();
  });

  it('a withdrawn account channel stops everything, essential included — nothing pretends it still works', () => {
    const withdrawn = { optOutScope: 'all' as const, consented: false };
    expect(policyRefusal(controls({ mode: 'live', liveSends: true }), 'essential', CUSTOMER, withdrawn)?.detail).toMatch(/withdrew WhatsApp/);
    expect(policyRefusal(controls(), 'essential', TEST_NUMBER, withdrawn)).not.toBeNull();
  });

  it('in live mode an optional notice needs a recorded consent; an essential one does not', () => {
    const c = controls({ mode: 'live', liveSends: true });
    expect(policyRefusal(c, 'optional', CUSTOMER, none)?.detail).toMatch(/No recorded WhatsApp consent/);
    expect(policyRefusal(c, 'optional', CUSTOMER, { optOutScope: 'none', consented: true })).toBeNull();
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
    const { channel, raw, db } = governed();
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
    const { channel, db } = governed();
    db.whatsAppMessage.failing.add('create');
    expect((await channel.send(otp(TEST_NUMBER))).status).toBe('accepted');
  });

  it('remembers a number the provider calls undeliverable (131026), and retries nothing', async () => {
    const { channel, raw, records } = governed({}, { status: 'failed', reason: 'rejected', detail: 'Provider answered HTTP 400 (code 131026)', provider: 'cloud-api', providerCode: 131026 });
    const result = await channel.send(otp(TEST_NUMBER));
    expect(result).toMatchObject({ status: 'failed', reason: 'rejected', providerCode: 131026 });
    expect(raw.calls).toHaveLength(1);
    expect((await records.contactState(TEST_NUMBER)).undeliverableAt).toBeInstanceOf(Date);
  });

  it('records a refusal for the 24-hour window (131047) with its code, as a refusal, not a retry', async () => {
    const { channel, db } = governed({}, { status: 'failed', reason: 'rejected', detail: 'outside the 24-hour customer-service window', provider: 'cloud-api', providerCode: 131047 });
    await channel.send(otp(TEST_NUMBER, 'k-window'));
    expect(db.whatsAppMessage.rows[0]).toMatchObject({ status: 'failed', failureReason: 'rejected', errorCode: 131047 });
  });

  it('a retry of a failed message (same key) is one record with two attempts, and may then be accepted', async () => {
    const { channel, raw, db } = governed({}, { status: 'failed', reason: 'temporary', detail: 'timeout', provider: 'cloud-api' });
    await channel.send(otp(TEST_NUMBER, 'k-retry'));
    raw.set({ status: 'accepted', providerMessageId: 'wamid.R', provider: 'cloud-api' });
    await channel.send(otp(TEST_NUMBER, 'k-retry'));
    expect(db.whatsAppMessage.rows).toHaveLength(1);
    expect(db.whatsAppMessage.rows[0]).toMatchObject({ status: 'accepted', attempts: 2, providerMessageId: 'wamid.R' });
  });

  it('honours an opt-out recorded for the number, and a withdrawal for everything', async () => {
    const { channel, raw, records } = governed();
    await records.optOut({ number: TEST_NUMBER, scope: 'optional', companyId: Buffer.alloc(16, 1), userId: Buffer.alloc(16, 2) });
    expect((await channel.send(closing(TEST_NUMBER))).status).toBe('failed');
    expect((await channel.send(otp(TEST_NUMBER))).status).toBe('accepted');
    await records.optOut({ number: TEST_NUMBER, scope: 'all', companyId: Buffer.alloc(16, 1), userId: Buffer.alloc(16, 2) });
    expect((await channel.send(otp(TEST_NUMBER))).status).toBe('failed');
    expect(raw.calls).toHaveLength(1);
  });

  it('the delivery check goes in test mode to an allowlisted number, and never in live mode', async () => {
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
    const { channel, raw, db } = governed({ recipientMinIntervalMs: 60_000 });
    await channel.send(otp(TEST_NUMBER));
    const second = await channel.send(otp(TEST_NUMBER));
    expect(second).toMatchObject({ status: 'failed', reason: 'temporary', detail: expect.stringMatching(/Too soon/) });
    expect(raw.calls).toHaveLength(1);
    expect(db.whatsAppMessage.rows[1]).toMatchObject({ status: 'refused', failureReason: 'temporary' });
  });
});
