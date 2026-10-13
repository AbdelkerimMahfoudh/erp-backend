import 'reflect-metadata';
import { ServiceUnavailableException, type FactoryProvider } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { DisabledWhatsAppChannel, TestWhatsAppChannel } from '../messaging/channels';
import { ProvenWhatsAppChannel, WhatsAppReadiness } from '../messaging/delivery-readiness';
import { DisabledEmailChannel } from '../messaging/email-channel';
import { AUTH_OTP_TEMPLATE } from '../messaging/templates';
import {
  ContactDeliveryProvider,
  OutboxDeliveryProvider,
  UnconfiguredDeliveryProvider,
  WhatsAppContactDeliveryProvider,
} from './contact-delivery';
import { PlatformModule } from './platform.module';

/**
 * F11 (2026-10-13): the provider that sends contact codes is chosen on every call, never once at boot.
 *
 * In production a configured WhatsApp channel stays closed until its delivery proofs load (docs/64). The module used
 * to choose its provider while it was being built — before `WhatsAppReadiness` had read anything — so a deployment
 * whose only channel is WhatsApp was handed the refusal at boot and kept refusing every code, the registration's
 * included, until somebody restarted it. These tests build the provider exactly as `PlatformModule` declares it,
 * at "boot" with no proof, and then load the proofs the way the deployment does: the same instance must start
 * delivering, with nothing rebuilt.
 */

/** The ContactDeliveryProvider definition `PlatformModule` actually registers — not a copy of it. */
function declaredFactory(): FactoryProvider<ContactDeliveryProvider> {
  const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, PlatformModule) as unknown[];
  const found = providers.find(
    (p): p is FactoryProvider<ContactDeliveryProvider> =>
      typeof p === 'object' && p !== null && (p as FactoryProvider).provide === ContactDeliveryProvider,
  );
  if (!found) throw new Error('PlatformModule registers no ContactDeliveryProvider factory');
  return found;
}

/** The delivery proofs table as `WhatsAppReadiness` reads it: one row per language whose delivery was reported. */
function proofsTable() {
  const rows: { language: string }[] = [];
  return {
    rows,
    prisma: { messagingDeliveryProof: { findMany: async () => rows.map((r) => ({ ...r })) } },
  };
}

/** A production process: no outbox, whatever else is set. */
function inProduction(): () => void {
  const saved = { APP_ENV: process.env.APP_ENV, NODE_ENV: process.env.NODE_ENV };
  process.env.APP_ENV = 'production';
  process.env.NODE_ENV = 'production';
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

const CODE = { channel: 'phone' as const, destination: '+22231234567', code: '482913', language: 'fr' as const };

describe('a WhatsApp-only production deployment (F11)', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = inProduction();
  });
  afterEach(() => restore());

  /** The module's wiring, at boot: the proven-WhatsApp gate over a real channel, no email provider. */
  async function boot() {
    const table = proofsTable();
    const readiness = new WhatsAppReadiness(table.prisma as never);
    const sender = new TestWhatsAppChannel();
    const channel = new ProvenWhatsAppChannel(sender, readiness);
    const email = new DisabledEmailChannel();
    const unconfigured = new UnconfiguredDeliveryProvider();
    const real = new WhatsAppContactDeliveryProvider(channel, unconfigured, email);
    const outbox = new OutboxDeliveryProvider();
    // Nest builds the provider while it builds the module — before any `onModuleInit`, so before a proof is read.
    const provider = declaredFactory().useFactory(channel, real, outbox, unconfigured, email) as ContactDeliveryProvider;
    await readiness.onModuleInit();
    return { table, readiness, sender, provider };
  }

  it('refuses honestly while delivery is unproven — nothing sent, nothing claimed', async () => {
    const { sender, provider } = await boot();
    expect(provider.canDeliver('phone')).toBe(false);
    await expect(provider.send(CODE)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(provider.send(CODE)).rejects.toMatchObject({ response: { code: 'delivery_unavailable' } });
    expect(sender.messages).toHaveLength(0);
  });

  it('delivers codes from the moment its proofs load — the same provider, no restart', async () => {
    const { table, readiness, sender, provider } = await boot();
    expect(provider.canDeliver('phone')).toBe(false);

    // The operator's three proofs complete through the signed webhook, which refreshes the readiness in-process.
    table.rows.push({ language: 'en' }, { language: 'fr' }, { language: 'ar' });
    await readiness.refresh();

    expect(provider.canDeliver('phone')).toBe(true);
    await expect(provider.send(CODE)).resolves.toEqual({ delivery: 'sent', provider: 'whatsapp:test', providerMessageId: 'test-1' });
    expect(sender.last).toMatchObject({ to: CODE.destination, template: AUTH_OTP_TEMPLATE.key, language: 'fr', variables: { code: '482913', ttlMinutes: '10' } });
    // An email address still has no provider here, and is still refused rather than faked.
    expect(provider.canDeliver('email')).toBe(false);
  });

  it('a proof that is no longer readable closes it again, at once', async () => {
    const { table, readiness, provider } = await boot();
    table.rows.push({ language: 'en' }, { language: 'fr' }, { language: 'ar' });
    await readiness.refresh();
    expect(provider.canDeliver('phone')).toBe(true);

    table.rows.length = 0;
    await readiness.refresh();
    expect(provider.canDeliver('phone')).toBe(false);
    await expect(provider.send(CODE)).rejects.toMatchObject({ response: { code: 'delivery_unavailable' } });
  });

  it('records which provider a code went through as the one chosen for that call', async () => {
    const { table, readiness, provider } = await boot();
    expect(provider.name).toBe('none');
    table.rows.push({ language: 'en' }, { language: 'fr' }, { language: 'ar' });
    await readiness.refresh();
    expect(provider.name).toBe('channels');
  });
});

describe('the outbox is still never chosen in production, and still chosen in development', () => {
  it('development with no channel: the one registered outbox — codes stored are the codes read back', async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const unconfigured = new UnconfiguredDeliveryProvider();
      const outbox = new OutboxDeliveryProvider();
      const email = new DisabledEmailChannel();
      const channel = new DisabledWhatsAppChannel();
      const real = new WhatsAppContactDeliveryProvider(channel, unconfigured, email);
      const provider = declaredFactory().useFactory(channel, real, outbox, unconfigured, email) as ContactDeliveryProvider;
      await expect(provider.send(CODE)).resolves.toEqual({ delivery: 'outbox', provider: 'dev-outbox' });
      expect(outbox.peek(CODE.destination)).toBe('482913');
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});
