import { GovernedWhatsAppChannel } from './whatsapp-policy';
import { ProvenWhatsAppChannel } from './delivery-readiness';
import type { WhatsAppChannel, WhatsAppMessage, DeliveryResult } from './whatsapp-channel';
import { AUTH_OTP_TEMPLATE, DELIVERY_CHECK_TEMPLATE, ACCOUNT_DELETION_TEMPLATE } from './templates';

/**
 * The rolling recipient guard (the owner's brief, 2026-11-01): Meta allows 250 unique business-initiated recipients per
 * 24 hours; this server stops below that, counts people rather than attempts, and fails closed.
 */
const LIVE = { mode: 'live' as const, testRecipients: new Set<string>(), liveSends: true, phoneNumberId: 'P1', maxPerSecond: 80, recipientMinIntervalMs: 0, portfolioRecipientLimit: 2 };
const message = (to: string, key = to): WhatsAppMessage => ({ to, template: AUTH_OTP_TEMPLATE.key, language: 'en', variables: { code: '123456', ttlMinutes: '10' }, idempotencyKey: key, verifiesContact: true });

function world(opts: { broken?: boolean; hold?: Promise<void> } = {}) {
  const reached = new Set<string>();
  const recorded: { refused: boolean; detail?: string }[] = [];
  const calls: WhatsAppMessage[] = [];
  const records = {
    contactState: async () => ({ optOutScope: null, consented: true, consent: 'active', pendingLive: true, undeliverableAt: null }),
    messageExists: async () => false,
    uniqueRecipientsSince: async () => {
      if (opts.broken) throw new Error('down');
      return reached.size;
    },
    recipientReachedSince: async (to: string) => {
      if (opts.broken) throw new Error('down');
      return reached.has(to);
    },
    recordSend: async (r: { to: string; refused: boolean; result: DeliveryResult }) => {
      recorded.push({ refused: r.refused, detail: r.result.status === 'failed' ? r.result.detail : undefined });
      if (r.result.status === 'accepted') reached.add(r.to);
    },
    markUndeliverable: async () => undefined,
  };
  const inner: WhatsAppChannel = {
    name: 'cloud-api',
    isEnabled: true,
    send: async (m) => {
      calls.push(m);
      await opts.hold;
      return { status: 'accepted', providerMessageId: `w${calls.length}`, provider: 'cloud-api' };
    },
  };
  return { channel: new GovernedWhatsAppChannel(inner, LIVE, records as never), calls, recorded, reached };
}

describe('the rolling recipient limit', () => {
  it('counts people, not messages: a number already reached sends again at the limit; a new one is held, recorded, not sent', async () => {
    const { channel, calls, recorded } = world();
    await channel.send(message('+22240000001', 'a'));
    await channel.send(message('+22240000002', 'b'));
    expect((await channel.send(message('+22240000001', 'c'))).status).toBe('accepted');
    const held = await channel.send(message('+22240000003', 'd'));
    expect(held).toMatchObject({ status: 'failed', reason: 'temporary', detail: expect.stringContaining('recipient limit') });
    expect(calls.map((c) => c.idempotencyKey)).toEqual(['a', 'b', 'c']);
    expect(recorded.at(-1)?.refused).toBe(true);
  });

  it('two new numbers at the same instant cannot both take the last place', async () => {
    let open!: () => void;
    const { channel, calls, reached } = world({ hold: new Promise((r) => (open = r)) });
    reached.add('+22240000009');
    const both = [channel.send(message('+22240000001', 'a')), channel.send(message('+22240000002', 'b'))];
    await new Promise((r) => setTimeout(r, 10));
    open();
    const statuses = (await Promise.all(both)).map((r) => r.status).sort();
    expect(statuses).toEqual(['accepted', 'failed']);
    expect(calls).toHaveLength(1);
  });

  it('fails closed: with nothing to count from, nothing is sent', async () => {
    const { channel, calls } = world({ broken: true });
    expect(await channel.send(message('+22240000001'))).toMatchObject({ status: 'failed', reason: 'temporary' });
    expect(calls).toHaveLength(0);
  });
});

describe('a language opens on its own proof', () => {
  const inner: WhatsAppChannel = { name: 'cloud-api', isEnabled: true, send: async () => ({ status: 'accepted', providerMessageId: 'w', provider: 'cloud-api' }) };
  const gate = new ProvenWhatsAppChannel(inner, { isProven: true, missing: ['fr', 'ar'], proves: (l) => l === 'en' });

  it('the proven language is sent; another is refused, never substituted', async () => {
    expect(gate.isEnabled).toBe(true);
    expect((await gate.send(message('+22240000001'))).status).toBe('accepted');
    expect(await gate.send({ ...message('+22240000001'), language: 'ar' })).toMatchObject({ status: 'failed', reason: 'channel_unavailable' });
  });
});

describe('the approved template shapes', () => {
  it('the deletion code and the delivery proof are authentication templates, as Meta approved them', () => {
    expect(ACCOUNT_DELETION_TEMPLATE.providerKind).toBe('authentication');
    expect(DELIVERY_CHECK_TEMPLATE).toMatchObject({ providerKind: 'authentication', variables: ['code'], use: 'operator' });
  });
});
