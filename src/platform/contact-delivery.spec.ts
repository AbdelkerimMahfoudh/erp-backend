import { ServiceUnavailableException } from '@nestjs/common';
import {
  codeMayBeReturned,
  outboxAllowed,
  OutboxDeliveryProvider,
  UnconfiguredDeliveryProvider,
  WhatsAppContactDeliveryProvider,
} from './contact-delivery';
import { selectContactDelivery } from './platform.module';
import { DevelopmentLogWhatsAppChannel, DisabledWhatsAppChannel, TestWhatsAppChannel } from '../messaging/channels';
import { AUTH_OTP_TEMPLATE } from '../messaging/templates';
import { DevelopmentLogEmailChannel, DisabledEmailChannel, type EmailChannel, type EmailMessage } from '../messaging/email-channel';
import type { DeliveryResult as ChannelResult } from '../messaging/whatsapp-channel';

/**
 * Which environment may use the outbox, and which may see a code.
 *
 * Two separate gates on purpose, and the difference matters: staging USES the
 * outbox but must never return a code in a response, because a code in a
 * response body makes the whole verification meaningless.
 */
describe('the outbox is an explicit opt-in', () => {
  it('production never gets it, whatever else is set', () => {
    expect(outboxAllowed({ APP_ENV: 'production', NODE_ENV: 'production' })).toBe(false);
    // Even if somebody sets the staging flag by accident.
    expect(
      outboxAllowed({ APP_ENV: 'production', STAGING_CONTACT_OUTBOX: 'enabled' } as never),
    ).toBe(false);
    expect(outboxAllowed({ NODE_ENV: 'production' })).toBe(false);
  });

  it('staging gets it only when it says so deliberately', () => {
    /*
      Staging runs with NODE_ENV=production so it exercises production code
      paths. Without its own flag it would inherit the refusal — and with the
      OLD rule ("anything not production") any unlabelled environment would
      have silently got an outbox standing in for a real provider.
    */
    expect(outboxAllowed({ APP_ENV: 'staging', NODE_ENV: 'production' })).toBe(false);
    expect(
      outboxAllowed({
        APP_ENV: 'staging',
        NODE_ENV: 'production',
        STAGING_CONTACT_OUTBOX: 'enabled',
      } as never),
    ).toBe(true);
  });

  it('ordinary local development gets it without ceremony', () => {
    expect(outboxAllowed({ NODE_ENV: 'development' })).toBe(true);
    expect(outboxAllowed({})).toBe(true);
  });
});

describe('a code may be returned in a response only in development', () => {
  it('never in staging, even though staging uses the outbox', () => {
    expect(
      codeMayBeReturned({
        APP_ENV: 'staging',
        NODE_ENV: 'production',
        STAGING_CONTACT_OUTBOX: 'enabled',
      } as never),
    ).toBe(false);
  });

  it('never in production', () => {
    expect(codeMayBeReturned({ APP_ENV: 'production' })).toBe(false);
    expect(codeMayBeReturned({ NODE_ENV: 'production' })).toBe(false);
  });

  it('but yes in local development, where it is a convenience', () => {
    expect(codeMayBeReturned({ NODE_ENV: 'development' })).toBe(true);
  });

  it('and it is strictly stricter than the outbox gate', () => {
    // Anywhere a code may be returned, the outbox must also be allowed —
    // otherwise there would be no code to return.
    const envs = [
      { NODE_ENV: 'development' },
      { APP_ENV: 'staging', NODE_ENV: 'production', STAGING_CONTACT_OUTBOX: 'enabled' },
      { APP_ENV: 'production' },
      { NODE_ENV: 'production' },
    ];
    for (const e of envs) {
      if (codeMayBeReturned(e as never)) expect(outboxAllowed(e as never)).toBe(true);
    }
  });
});

describe('which provider actually sends', () => {
  const unconfigured = new UnconfiguredDeliveryProvider();
  const outbox = new OutboxDeliveryProvider();
  const whatsapp = (channel: TestWhatsAppChannel | DisabledWhatsAppChannel | DevelopmentLogWhatsAppChannel) =>
    new WhatsAppContactDeliveryProvider(channel, unconfigured);

  it('a real channel wins, wherever the outbox is allowed', () => {
    const channel = new TestWhatsAppChannel();
    const wa = whatsapp(channel);
    expect(selectContactDelivery(channel, wa, outbox, unconfigured, true)).toBe(wa);
    expect(selectContactDelivery(channel, wa, outbox, unconfigured, false)).toBe(wa);
  });

  it('a disabled channel falls back to the outbox only where that is allowed', () => {
    const channel = new DisabledWhatsAppChannel();
    const wa = whatsapp(channel);
    expect(selectContactDelivery(channel, wa, outbox, unconfigured, true)).toBe(outbox);
    expect(selectContactDelivery(channel, wa, outbox, unconfigured, false)).toBe(unconfigured);
  });

  it('the development-log channel is not treated as a real provider', () => {
    // It prints codes to a sink; the outbox already does that more safely.
    const channel = new DevelopmentLogWhatsAppChannel();
    const wa = whatsapp(channel);
    expect(selectContactDelivery(channel, wa, outbox, unconfigured, true)).toBe(outbox);
    expect(selectContactDelivery(channel, wa, outbox, unconfigured, false)).toBe(unconfigured);
  });
});

describe('the WhatsApp contact provider', () => {
  const unconfigured = new UnconfiguredDeliveryProvider();

  it('sends a phone code through the approved authentication template', async () => {
    const channel = new TestWhatsAppChannel();
    const provider = new WhatsAppContactDeliveryProvider(channel, unconfigured);

    const result = await provider.send({ channel: 'phone', destination: '+22231234567', code: '123456', language: 'fr' });

    // The provider and its message id are returned to be recorded on the code's row (0093).
    expect(result).toEqual({ delivery: 'sent', provider: 'whatsapp:test', providerMessageId: 'test-1' });
    expect(channel.last).toMatchObject({
      to: '+22231234567',
      template: AUTH_OTP_TEMPLATE.key,
      language: 'fr',
      variables: { code: '123456', ttlMinutes: '10' },
    });
  });

  it('refuses honestly when the channel does not accept the message', async () => {
    const channel = new TestWhatsAppChannel();
    channel.nextResult = { status: 'failed', reason: 'temporary', detail: 'simulated', provider: 'test' };
    const provider = new WhatsAppContactDeliveryProvider(channel, unconfigured);

    await expect(
      provider.send({ channel: 'phone', destination: '+22231234567', code: '123456', language: 'en' }),
    ).rejects.toMatchObject({ response: { code: 'delivery_failed', delivery: 'temporary' } });
  });

  it('has no email provider and says so rather than pretending', async () => {
    const channel = new TestWhatsAppChannel();
    const provider = new WhatsAppContactDeliveryProvider(channel, unconfigured);

    await expect(
      provider.send({ channel: 'email', destination: 'owner@example.test', code: '123456', language: 'en' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(channel.messages).toHaveLength(0);
  });
});

describe('whether a code can leave at all — asked before anything is created (2026-10-05)', () => {
  const unconfigured = new UnconfiguredDeliveryProvider();

  it('the outbox takes every channel; nothing configured takes none', () => {
    const outbox = new OutboxDeliveryProvider();
    expect(outbox.canDeliver('email')).toBe(true);
    expect(outbox.canDeliver('phone')).toBe(true);
    expect(unconfigured.canDeliver('email')).toBe(false);
    expect(unconfigured.canDeliver('phone')).toBe(false);
  });

  it('WhatsApp takes a number while the channel is on, and never an email', () => {
    const on = new WhatsAppContactDeliveryProvider(new TestWhatsAppChannel(), unconfigured);
    expect(on.canDeliver('phone')).toBe(true);
    expect(on.canDeliver('email')).toBe(false);
    const off = new WhatsAppContactDeliveryProvider(new DisabledWhatsAppChannel(), unconfigured);
    expect(off.canDeliver('phone')).toBe(false);
  });
});

/** An email provider that answers as a test needs: each call takes the next answer. */
class ScriptedEmail implements EmailChannel {
  readonly name = 'resend';
  readonly isEnabled = true;
  readonly sent: EmailMessage[] = [];
  constructor(private readonly answers: ChannelResult[]) {}
  async send(message: EmailMessage): Promise<ChannelResult> {
    this.sent.push(message);
    return this.answers.shift() ?? { status: 'accepted', providerMessageId: 'em-1', provider: 'resend' };
  }
}

describe('the email boundary (correction phase, 2026-10-12)', () => {
  const unconfigured = new UnconfiguredDeliveryProvider();
  const accepted: ChannelResult = { status: 'accepted', providerMessageId: 'em-1', provider: 'resend' };
  const temporary: ChannelResult = { status: 'failed', reason: 'temporary', detail: '503', provider: 'resend' };
  const rejected: ChannelResult = { status: 'failed', reason: 'rejected', detail: '422', provider: 'resend' };

  it('an email address goes through the email channel, with its approved text and its message id recorded', async () => {
    const email = new ScriptedEmail([accepted]);
    const provider = new WhatsAppContactDeliveryProvider(new DisabledWhatsAppChannel(), unconfigured, email);
    expect(provider.canDeliver('email')).toBe(true);
    expect(provider.canDeliver('phone')).toBe(false);
    await expect(provider.send({ channel: 'email', destination: 'owner@shop.mr', code: '123456', language: 'ar' })).resolves.toEqual({ delivery: 'sent', provider: 'email:resend', providerMessageId: 'em-1' });
    expect(email.sent[0]).toMatchObject({ to: 'owner@shop.mr', template: 'contact.verification', language: 'ar', variables: { code: '123456', ttlMinutes: '10' } });
  });

  it('a temporary failure is tried once more under the same key; a refusal is not, and nothing is claimed', async () => {
    const retried = new ScriptedEmail([temporary, accepted]);
    const provider = new WhatsAppContactDeliveryProvider(new DisabledWhatsAppChannel(), unconfigured, retried);
    await expect(provider.send({ channel: 'email', destination: 'owner@shop.mr', code: '123456', language: 'en' })).resolves.toMatchObject({ delivery: 'sent' });
    expect(retried.sent).toHaveLength(2);
    expect(retried.sent[0].idempotencyKey).toBe(retried.sent[1].idempotencyKey);

    const twice = new ScriptedEmail([temporary, temporary]);
    await expect(new WhatsAppContactDeliveryProvider(new DisabledWhatsAppChannel(), unconfigured, twice).send({ channel: 'email', destination: 'owner@shop.mr', code: '1', language: 'en' })).rejects.toMatchObject({ response: { code: 'delivery_failed', delivery: 'temporary' } });
    expect(twice.sent).toHaveLength(2);

    const refused = new ScriptedEmail([rejected]);
    await expect(new WhatsAppContactDeliveryProvider(new DisabledWhatsAppChannel(), unconfigured, refused).send({ channel: 'email', destination: 'owner@shop.mr', code: '1', language: 'en' })).rejects.toMatchObject({ response: { code: 'delivery_failed', delivery: 'rejected' } });
    expect(refused.sent).toHaveLength(1);
  });

  it('no email provider, or only the development log, is no email channel: refused honestly, nothing sent', async () => {
    for (const email of [new DisabledEmailChannel(), new DevelopmentLogEmailChannel(), undefined]) {
      const provider = new WhatsAppContactDeliveryProvider(new TestWhatsAppChannel(), unconfigured, email);
      expect(provider.canDeliver('email')).toBe(false);
      await expect(provider.send({ channel: 'email', destination: 'owner@shop.mr', code: '1', language: 'en' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
  });

  it('a real email channel alone makes the real provider the choice; a WhatsApp number is then refused honestly', () => {
    const real = new WhatsAppContactDeliveryProvider(new DisabledWhatsAppChannel(), unconfigured, new ScriptedEmail([]));
    const chosen = selectContactDelivery(new DisabledWhatsAppChannel(), real, new OutboxDeliveryProvider(), unconfigured, false, new ScriptedEmail([]));
    expect(chosen).toBe(real);
    expect(chosen.canDeliver('phone')).toBe(false);
    expect(selectContactDelivery(new DisabledWhatsAppChannel(), real, new OutboxDeliveryProvider(), unconfigured, false, new DisabledEmailChannel())).toBe(unconfigured);
  });
});
