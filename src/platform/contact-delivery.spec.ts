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

    expect(result).toEqual({ delivery: 'sent', provider: 'whatsapp' });
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
