import { ForbiddenException, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { WhatsAppWebhookController, extractItems, extractStatuses, signatureMatches } from './whatsapp-webhook.controller';
import { MAX_ATTEMPTS, UNKNOWN_MESSAGE_GRACE_MS, WhatsAppWebhookWorker } from './whatsapp-webhook.worker';
import { WhatsAppRecords } from './whatsapp-records';
import { recipientHash } from './recipient-hash';
import { fakeMessagingPrisma, type FakeMessagingPrisma } from './__testing__/fake-messaging-prisma';

/**
 * The provider's webhook (docs/64 §3; asynchronous since 0098, D181 §8).
 *
 * Two public routes, both closed by construction: the subscription check answers only with the configured verify
 * token, and a delivery is read only when its signature is the HMAC of the exact bytes received. A signed delivery is
 * stored before it is acknowledged — or refused with a 503 so the provider retries — and a leased worker applies it:
 * statuses forward only, D166's delivery proofs unchanged, opt-outs from keywords decided in memory.
 */

const SECRET = 'app-secret-for-tests';
const KEY = 'test-messaging-hash-key-of-32-characters!';
const sign = (raw: Buffer, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
const hasher = { hash: (n: string) => recipientHash(n, KEY) };

function harness(opts: { verifyToken?: string; appSecret?: string } = {}) {
  const db: FakeMessagingPrisma = fakeMessagingPrisma();
  const records = new WhatsAppRecords(db as never, hasher as never);
  const readiness = { refresh: jest.fn(async () => undefined), missing: [] as string[] };
  const config = {
    whatsappWebhookVerifyToken: opts.verifyToken ?? '',
    whatsappAppSecret: opts.appSecret ?? '',
    whatsappWebhookRetentionDays: 30,
    messageLogRetentionDays: 180,
  };
  const worker = new WhatsAppWebhookWorker(db as never, records, readiness as never, config as never);
  const controller = new WhatsAppWebhookController(config as never, hasher as never, worker);
  return { controller, worker, records, db, readiness };
}

function res() {
  const out: { status?: number; type?: string; body?: string } = {};
  const r = {
    status(code: number) {
      out.status = code;
      return r;
    },
    type(t: string) {
      out.type = t;
      return r;
    },
    send(body: string) {
      out.body = body;
      return r;
    },
  };
  return { r: r as never, out };
}

describe('the subscription check', () => {
  it('does not exist until both settings are configured', () => {
    const { controller } = harness({ verifyToken: 'v', appSecret: '' });
    const { r } = res();
    expect(() => controller.verify('subscribe', 'v', '123', r)).toThrow(NotFoundException);
  });

  it('refuses the wrong token', () => {
    const { controller } = harness({ verifyToken: 'right-token', appSecret: SECRET });
    const { r } = res();
    expect(() => controller.verify('subscribe', 'wrong-token', '123', r)).toThrow(ForbiddenException);
    expect(() => controller.verify('subscribe', undefined, '123', r)).toThrow(ForbiddenException);
    expect(() => controller.verify('unsubscribe', 'right-token', '123', r)).toThrow(ForbiddenException);
  });

  it('echoes the challenge as plain text for the right token', () => {
    const { controller } = harness({ verifyToken: 'right-token', appSecret: SECRET });
    const { r, out } = res();
    controller.verify('subscribe', 'right-token', '1158201444', r);
    expect(out).toEqual({ status: 200, type: 'text/plain', body: '1158201444' });
  });
});

describe('the signature', () => {
  const raw = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');

  it('accepts the HMAC of the exact bytes', () => {
    expect(signatureMatches(raw, sign(raw), SECRET)).toBe(true);
  });

  it('refuses a missing header, a wrong prefix, a wrong secret and a changed body', () => {
    expect(signatureMatches(raw, undefined, SECRET)).toBe(false);
    expect(signatureMatches(raw, sign(raw).replace('sha256=', 'sha1='), SECRET)).toBe(false);
    expect(signatureMatches(raw, sign(raw, 'other-secret'), SECRET)).toBe(false);
    expect(signatureMatches(Buffer.from(raw.toString() + ' '), sign(raw), SECRET)).toBe(false);
    expect(signatureMatches(raw, 'sha256=short', SECRET)).toBe(false);
  });
});

describe('what a status body yields', () => {
  it('extracts ids, statuses and the first error code, and nothing else', () => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  { id: 'wamid.A', status: 'delivered', recipient_id: '22231234567' },
                  { id: 'wamid.B', status: 'failed', errors: [{ code: 131026, title: 'Undeliverable' }] },
                  { id: 42, status: 'sent' },
                  { status: 'read' },
                ],
              },
            },
            { value: { messages: [{ from: '22231234567', text: { body: 'hello' } }] } },
          ],
        },
      ],
    };
    expect(extractStatuses(body)).toEqual([
      { id: 'wamid.A', status: 'delivered' },
      { id: 'wamid.B', status: 'failed', errorCode: 131026 },
    ]);
  });

  it('survives junk', () => {
    expect(extractStatuses(null)).toEqual([]);
    expect(extractStatuses('x')).toEqual([]);
    expect(extractStatuses({ entry: 'nope' })).toEqual([]);
    expect(extractStatuses({ entry: [{ changes: [{ value: null }] }] })).toEqual([]);
  });

  it('truncates oversized fields', () => {
    const statuses = [{ id: 'x'.repeat(500), status: 'y'.repeat(100) }];
    const out = extractStatuses({ entry: [{ changes: [{ value: { statuses } }] }] });
    expect(out[0].id).toHaveLength(120);
    expect(out[0].status).toHaveLength(40);
  });
});

const statusBody = (...statuses: object[]) => ({ entry: [{ changes: [{ value: { statuses } }] }] });
const inboundBody = (...messages: object[]) => ({ entry: [{ changes: [{ value: { messages } }] }] });
const raw = (body: object) => Buffer.from(JSON.stringify(body));

/** A message the policy recorded as accepted, as a send through the governed channel leaves it. */
async function sent(h: ReturnType<typeof harness>, providerMessageId: string, to = '+22236000001') {
  await h.records.recordSend({
    idempotencyKey: `k-${providerMessageId}`,
    to,
    template: 'auth.otp',
    use: 'essential',
    language: 'en',
    mode: 'test',
    phoneNumberId: '1297799316760335',
    result: { status: 'accepted', providerMessageId, provider: 'cloud-api' },
    refused: false,
  });
}

async function deliver(h: ReturnType<typeof harness>, body: object) {
  const r = raw(body);
  return h.controller.receive({ rawBody: r, body } as never, sign(r));
}

const messageRow = (h: ReturnType<typeof harness>, id: string) => h.db.whatsAppMessage.rows.find((r) => r.providerMessageId === id)!;

describe('every item of a delivery, and nothing more', () => {
  it('keeps a status, and an inbound message only as an id, a keyed sender hash, a masked number and an opt-out signal', () => {
    const body = {
      entry: [
        {
          changes: [
            { value: { statuses: [{ id: 'wamid.S', status: 'read', timestamp: '1760000000' }] } },
            { value: { messages: [{ id: 'wamid.M', from: '22236963839', timestamp: '1760000100', type: 'text', text: { body: 'My code is 482913, STOP please' } }] } },
            { value: { messages: [{ id: 'wamid.N', from: '22236963839', type: 'text', text: { body: ' stop! ' } }] } },
          ],
        },
      ],
    };
    const items = extractItems(body, hasher.hash);
    expect(items).toEqual([
      expect.objectContaining({ dedupeKey: 's:wamid.S:read', kind: 'status', status: 'read', occurredAt: new Date(1760000000 * 1000) }),
      expect.objectContaining({ dedupeKey: 'm:wamid.M', kind: 'inbound', senderHash: recipientHash('+22236963839', KEY), senderMasked: '+222***39', optOutSignal: null }),
      expect.objectContaining({ dedupeKey: 'm:wamid.N', kind: 'inbound', optOutSignal: 'stop' }),
    ]);
    // The text is gone: nothing of it — not the code inside it — is in any stored field.
    expect(JSON.stringify(items)).not.toMatch(/482913|please|36963839"/);
  });

  it('drops an inbound message whose sender is not a number', () => {
    expect(extractItems(inboundBody({ id: 'x', from: 'not-a-number', text: { body: 'STOP' } }), hasher.hash)).toEqual([]);
  });
});

describe('receiving a delivery', () => {
  const body = statusBody({ id: 'wamid.ok', status: 'delivered' }, { id: 'wamid.bad', status: 'failed', errors: [{ code: 131026 }] });

  it('does not exist until configured', async () => {
    const { controller } = harness();
    await expect(controller.receive({ rawBody: raw(body), body } as never, sign(raw(body)))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses an unsigned or mis-signed body before reading it, and stores nothing', async () => {
    const { controller, db } = harness({ verifyToken: 'v', appSecret: SECRET });
    const r = raw(body);
    await expect(controller.receive({ rawBody: r, body } as never, undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.receive({ rawBody: r, body } as never, sign(r, 'wrong'))).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.receive({ rawBody: r, body } as never, 'sha256=00')).rejects.toBeInstanceOf(UnauthorizedException);
    // No raw body means the signature cannot be checked, so nothing is trusted.
    await expect(controller.receive({ body } as never, sign(r))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.whatsAppWebhookEvent.createMany).not.toHaveBeenCalled();
  });

  it('stores every item durably BEFORE answering 200', async () => {
    const h = harness({ verifyToken: 'v', appSecret: SECRET });
    jest.spyOn(h.worker, 'processNow').mockResolvedValue(undefined);
    const result = await deliver(h, body);
    expect(result).toEqual({ received: 2 });
    expect(h.db.whatsAppWebhookEvent.rows.map((r) => r.dedupeKey)).toEqual(['s:wamid.ok:delivered', 's:wamid.bad:failed']);
    expect(h.db.whatsAppWebhookEvent.rows.every((r) => r.state === 'pending')).toBe(true);
  });

  it('answers a retryable 503 when the items cannot be stored, so the provider sends the delivery again', async () => {
    const h = harness({ verifyToken: 'v', appSecret: SECRET });
    h.db.whatsAppWebhookEvent.failing.add('createMany');
    await expect(deliver(h, body)).rejects.toBeInstanceOf(ServiceUnavailableException);
    h.db.whatsAppWebhookEvent.failing.clear();
    jest.spyOn(h.worker, 'processNow').mockResolvedValue(undefined);
    await expect(deliver(h, body)).resolves.toEqual({ received: 2 });
  });

  it('collapses a provider retry of the same delivery: each item is stored once', async () => {
    const h = harness({ verifyToken: 'v', appSecret: SECRET });
    jest.spyOn(h.worker, 'processNow').mockResolvedValue(undefined);
    await deliver(h, body);
    await deliver(h, body);
    await deliver(h, statusBody({ id: 'wamid.ok', status: 'delivered' }, { id: 'wamid.ok', status: 'read' }));
    expect(h.db.whatsAppWebhookEvent.rows.map((r) => r.dedupeKey)).toEqual(['s:wamid.ok:delivered', 's:wamid.bad:failed', 's:wamid.ok:read']);
  });
});

describe('the worker', () => {
  it('records the delivery state on the code the message carried, scoped to the provider id (existing behaviour)', async () => {
    const h = harness({ verifyToken: 'v', appSecret: SECRET });
    jest.spyOn(h.worker, 'processNow').mockResolvedValue(undefined);
    await sent(h, 'wamid.ok');
    await sent(h, 'wamid.bad');
    await deliver(h, statusBody({ id: 'wamid.ok', status: 'delivered' }, { id: 'wamid.bad', status: 'failed', errors: [{ code: 131026 }] }));
    await h.worker.sweep();
    expect(h.db.otpChallenge.updateMany.mock.calls.map((c) => c[0])).toEqual([
      { where: { providerMessageId: 'wamid.ok', provider: 'cloud-api' }, data: { deliveryDetail: 'Provider reported: delivered' } },
      { where: { providerMessageId: 'wamid.bad', provider: 'cloud-api' }, data: { deliveryState: 'rejected', deliveryDetail: 'Provider reported failure (code 131026)' } },
    ]);
    expect(h.db.whatsAppWebhookEvent.rows.every((r) => r.state === 'done')).toBe(true);
  });

  it('moves statuses forward only, and a late "failed" never overwrites delivered or read', async () => {
    const h = harness({ verifyToken: 'v', appSecret: SECRET });
    jest.spyOn(h.worker, 'processNow').mockResolvedValue(undefined);
    await sent(h, 'wamid.1');
    // Out of order: read before delivered, then a failure after both.
    await deliver(h, statusBody({ id: 'wamid.1', status: 'read' }));
    await h.worker.sweep();
    await deliver(h, statusBody({ id: 'wamid.1', status: 'delivered' }, { id: 'wamid.1', status: 'sent' }, { id: 'wamid.1', status: 'failed', errors: [{ code: 131026 }] }));
    await h.worker.sweep();
    const row = messageRow(h, 'wamid.1');
    expect(row.status).toBe('read');
    expect(row.failedAt ?? null).toBeNull();
    // The late failure touched nothing else either: no code marked rejected, no proof marked failed.
    const otpData = h.db.otpChallenge.updateMany.mock.calls.map((c) => (c[0] as { data: object }).data);
    expect(otpData).toEqual([{ deliveryDetail: 'Provider reported: read' }]);
    // The proof is only ever completed (read, then the late delivered), never marked failed.
    const proofData = h.db.messagingDeliveryProof.updateMany.mock.calls.map((c) => (c[0] as { data: object }).data);
    expect(proofData.length).toBeGreaterThan(0);
    expect(proofData.every((d) => 'deliveredAt' in d)).toBe(true);
  });

  it('records a failure that comes before delivery, and remembers an undeliverable number (131026)', async () => {
    const h = harness({ verifyToken: 'v', appSecret: SECRET });
    jest.spyOn(h.worker, 'processNow').mockResolvedValue(undefined);
    await sent(h, 'wamid.2', '+22236000002');
    await deliver(h, statusBody({ id: 'wamid.2', status: 'sent' }, { id: 'wamid.2', status: 'failed', errors: [{ code: 131026 }] }));
    await h.worker.sweep();
    expect(messageRow(h, 'wamid.2')).toMatchObject({ status: 'failed', errorCode: 131026 });
    expect((await h.records.contactState('+22236000002')).undeliverableAt).toBeInstanceOf(Date);
  });

  it('D166: completes the operator’s delivery proof only on a signed delivered status, and opens the gate by reading the proofs again', async () => {
    const h = harness({ verifyToken: 'v', appSecret: SECRET });
    jest.spyOn(h.worker, 'processNow').mockResolvedValue(undefined);
    await sent(h, 'wamid.ok');
    await sent(h, 'wamid.bad');
    h.db.messagingDeliveryProof.updateMany.mockResolvedValueOnce({ count: 1 } as never);
    await deliver(h, statusBody({ id: 'wamid.ok', status: 'delivered' }, { id: 'wamid.bad', status: 'failed', errors: [{ code: 131026 }] }));
    await h.worker.sweep();
    const calls = h.db.messagingDeliveryProof.updateMany.mock.calls.map((c) => c[0]);
    expect(calls[0]).toEqual({ where: { provider: 'cloud-api', providerMessageId: 'wamid.ok', deliveredAt: null }, data: { deliveredAt: expect.any(Date) } });
    // A failure is recorded on the proof, never a delivery.
    expect(calls[1]).toEqual({ where: { provider: 'cloud-api', providerMessageId: 'wamid.bad', deliveredAt: null }, data: { failureDetail: 'Provider reported failure (code 131026)' } });
    expect(h.readiness.refresh).toHaveBeenCalledTimes(1);
  });

  it('an unsigned delivery proves nothing', async () => {
    const h = harness({ verifyToken: 'v', appSecret: SECRET });
    const body = statusBody({ id: 'wamid.ok', status: 'delivered' });
    await expect(h.controller.receive({ rawBody: raw(body), body } as never, sign(raw(body), 'wrong'))).rejects.toBeInstanceOf(UnauthorizedException);
    await h.worker.sweep();
    expect(h.db.messagingDeliveryProof.updateMany).not.toHaveBeenCalled();
    expect(h.readiness.refresh).not.toHaveBeenCalled();
  });

  it('is idempotent: working the same item twice (an expired lease taken over) changes nothing more', async () => {
    const h = harness({ verifyToken: 'v', appSecret: SECRET });
    jest.spyOn(h.worker, 'processNow').mockResolvedValue(undefined);
    await sent(h, 'wamid.3');
    await deliver(h, statusBody({ id: 'wamid.3', status: 'delivered' }));
    await h.worker.sweep();
    // Simulate a worker that died after doing the work but before marking the item done.
    const event = h.db.whatsAppWebhookEvent.rows[0];
    Object.assign(event, { state: 'processing', claimedUntil: new Date(Date.now() - 1) });
    await h.worker.sweep();
    expect(messageRow(h, 'wamid.3').status).toBe('delivered');
    // Re-applying is harmless: the same effect with the same data, never a different one.
    const effects = h.db.otpChallenge.updateMany.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(new Set(effects).size).toBe(1);
    expect(event.state).toBe('done');
  });

  it('a claimed item with a live lease is not worked by a second pass', async () => {
    const h = harness({ verifyToken: 'v', appSecret: SECRET });
    jest.spyOn(h.worker, 'processNow').mockResolvedValue(undefined);
    await deliver(h, statusBody({ id: 'wamid.4', status: 'sent' }));
    Object.assign(h.db.whatsAppWebhookEvent.rows[0], { state: 'processing', claimedUntil: new Date(Date.now() + 60_000) });
    const result = await h.worker.sweep();
    expect(result).toEqual({ done: 0, failed: 0 });
  });

  it('a failure puts the item back with a backoff, and parks it after the last attempt — never lost, never a crash', async () => {
    const h = harness({ verifyToken: 'v', appSecret: SECRET });
    jest.spyOn(h.worker, 'processNow').mockResolvedValue(undefined);
    await sent(h, 'wamid.5');
    await deliver(h, statusBody({ id: 'wamid.5', status: 'delivered' }));
    h.db.otpChallenge.failing.add('updateMany');
    const first = await h.worker.sweep();
    const event = h.db.whatsAppWebhookEvent.rows[0];
    expect(first.failed).toBe(1);
    expect(event).toMatchObject({ state: 'pending', attempts: 1 });
    expect((event.nextAttemptAt as Date).getTime()).toBeGreaterThan(Date.now());
    expect(String(event.lastError)).not.toMatch(/unavailable|wamid/); // class and code only
    Object.assign(event, { attempts: MAX_ATTEMPTS - 1, nextAttemptAt: new Date(0) });
    await h.worker.sweep();
    expect(event.state).toBe('failed');
  });

  it('a retry after an effect failed still completes the delivery proof (D166 is never skipped)', async () => {
    const h = harness({ verifyToken: 'v', appSecret: SECRET });
    jest.spyOn(h.worker, 'processNow').mockResolvedValue(undefined);
    await sent(h, 'wamid.7');
    await deliver(h, statusBody({ id: 'wamid.7', status: 'delivered' }));
    h.db.messagingDeliveryProof.failing.add('updateMany');
    await h.worker.sweep();
    // The record moved; the proof did not.
    expect(messageRow(h, 'wamid.7').status).toBe('delivered');
    h.db.messagingDeliveryProof.failing.clear();
    h.db.messagingDeliveryProof.updateMany.mockResolvedValueOnce({ count: 1 } as never);
    h.db.whatsAppWebhookEvent.rows[0].nextAttemptAt = new Date(0);
    await h.worker.sweep();
    expect(h.readiness.refresh).toHaveBeenCalledTimes(1);
    expect(h.db.whatsAppWebhookEvent.rows[0].state).toBe('done');
  });

  it('waits for a message that is not recorded yet (the status raced its own send), then applies it', async () => {
    const h = harness({ verifyToken: 'v', appSecret: SECRET });
    jest.spyOn(h.worker, 'processNow').mockResolvedValue(undefined);
    await deliver(h, statusBody({ id: 'wamid.6', status: 'delivered' }));
    await h.worker.sweep();
    const event = h.db.whatsAppWebhookEvent.rows[0];
    expect(event.state).toBe('pending');
    expect(h.db.messagingDeliveryProof.updateMany).not.toHaveBeenCalled();
    // The send records itself; the retry now finds it.
    await sent(h, 'wamid.6');
    event.nextAttemptAt = new Date(0);
    await h.worker.sweep();
    expect(messageRow(h, 'wamid.6').status).toBe('delivered');
    expect(event.state).toBe('done');
  });

  it('after the grace period, applies a status for a message it never recorded (sent before 0098) as before', async () => {
    const h = harness({ verifyToken: 'v', appSecret: SECRET });
    jest.spyOn(h.worker, 'processNow').mockResolvedValue(undefined);
    await deliver(h, statusBody({ id: 'wamid.legacy', status: 'delivered' }));
    Object.assign(h.db.whatsAppWebhookEvent.rows[0], { receivedAt: new Date(Date.now() - UNKNOWN_MESSAGE_GRACE_MS - 1) });
    await h.worker.sweep();
    expect(h.db.messagingDeliveryProof.updateMany).toHaveBeenCalledTimes(1);
    expect(h.db.whatsAppWebhookEvent.rows[0].state).toBe('done');
  });

  it('applies STOP and START from inbound text, keeps the window, and minimises the item once processed', async () => {
    const h = harness({ verifyToken: 'v', appSecret: SECRET });
    jest.spyOn(h.worker, 'processNow').mockResolvedValue(undefined);
    const now = Math.floor(Date.now() / 1000);
    await deliver(h, inboundBody({ id: 'wamid.in1', from: '22236963839', timestamp: String(now), type: 'text', text: { body: 'STOP' } }));
    await h.worker.sweep();
    let state = await h.records.contactState('+22236963839');
    expect(state.optOutScope).toBe('optional');
    expect(state.lastInboundAt?.getTime()).toBe(now * 1000);
    const event = h.db.whatsAppWebhookEvent.rows[0];
    expect(event).toMatchObject({ state: 'done', senderHash: null, senderMasked: null, optOutSignal: null });
    expect(event.dedupeKey).toBe('m:wamid.in1');

    await deliver(h, inboundBody({ id: 'wamid.in2', from: '22236963839', timestamp: String(now + 5), type: 'text', text: { body: 'ابدأ' } }));
    await h.worker.sweep();
    state = await h.records.contactState('+22236963839');
    expect(state.optOutScope).toBe('none');
  });

  it('a keyword never lifts a withdrawal of the account channel: that takes a new consent', async () => {
    const h = harness({ verifyToken: 'v', appSecret: SECRET });
    jest.spyOn(h.worker, 'processNow').mockResolvedValue(undefined);
    await h.records.optOut({ number: '+22236963839', scope: 'all', companyId: Buffer.alloc(16, 1), userId: Buffer.alloc(16, 2) });
    await deliver(h, inboundBody({ id: 'wamid.in3', from: '22236963839', text: { body: 'START' } }));
    await h.worker.sweep();
    expect((await h.records.contactState('+22236963839')).optOutScope).toBe('all');
  });

  it('deletes processed items and message metadata after their retention periods', async () => {
    const h = harness({ verifyToken: 'v', appSecret: SECRET });
    const now = new Date();
    const old = new Date(now.getTime() - 31 * 24 * 3600_000);
    const ancient = new Date(now.getTime() - 181 * 24 * 3600_000);
    h.db.whatsAppWebhookEvent.rows.push(
      { dedupeKey: 'a', state: 'done', receivedAt: old },
      { dedupeKey: 'b', state: 'pending', receivedAt: old },
      { dedupeKey: 'c', state: 'done', receivedAt: now },
    );
    h.db.whatsAppMessage.rows.push({ idempotencyKey: 'x', createdAt: ancient }, { idempotencyKey: 'y', createdAt: old });
    h.db.emailMessage.rows.push({ idempotencyKey: 'e', createdAt: ancient });
    expect(await h.worker.purgeExpired(now)).toEqual({ events: 1, whatsapp: 1, email: 1 });
    // Unprocessed work is never purged.
    expect(h.db.whatsAppWebhookEvent.rows.map((r) => r.dedupeKey)).toEqual(['b', 'c']);
  });
});
