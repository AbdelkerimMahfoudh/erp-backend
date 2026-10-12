import { ProvenWhatsAppChannel, WhatsAppReadiness } from './delivery-readiness';
import { TestWhatsAppChannel } from './channels';
import { AUTH_OTP_TEMPLATE } from './templates';

/**
 * Production claims no WhatsApp delivery before it is proven on the deployment (correction phase, 2026-10-12):
 * one delivered message per language, completed only by the signed webhook.
 */

function readiness(rows: { language: string }[] | Error) {
  const prisma = {
    messagingDeliveryProof: {
      findMany: jest.fn(async (args: unknown) => {
        if (rows instanceof Error) throw rows;
        return rows;
      }),
    },
  };
  return { r: new WhatsAppReadiness(prisma as never), prisma };
}

const message = { to: '+22231234567', template: AUTH_OTP_TEMPLATE.key, language: 'fr' as const, variables: { code: '123456', ttlMinutes: '10' }, idempotencyKey: 'k' };

describe('whether WhatsApp delivery is proven', () => {
  it('reads only delivered WhatsApp proofs, and is proven once en, fr and ar each have one', async () => {
    const { r, prisma } = readiness([{ language: 'en' }, { language: 'fr' }]);
    await r.refresh();
    expect(prisma.messagingDeliveryProof.findMany).toHaveBeenCalledWith({ where: { channel: 'whatsapp', deliveredAt: { not: null } }, select: { language: true } });
    expect(r.isProven).toBe(false);
    expect(r.missing).toEqual(['ar']);
    const all = readiness([{ language: 'en' }, { language: 'fr' }, { language: 'ar' }]).r;
    await all.refresh();
    expect(all.isProven).toBe(true);
  });

  it('a database that cannot be read proves nothing', async () => {
    const { r } = readiness(new Error('db down'));
    await r.refresh();
    expect(r.isProven).toBe(false);
    expect(r.missing).toEqual(['en', 'fr', 'ar']);
  });
});

describe('the production channel before and after the proof', () => {
  it('closed: says it is off, sends nothing, and answers channel_unavailable naming what is missing', async () => {
    const inner = new TestWhatsAppChannel();
    const gate = new ProvenWhatsAppChannel(inner, { isProven: false, missing: ['fr', 'ar'] });
    expect(gate.isEnabled).toBe(false);
    await expect(gate.send(message)).resolves.toMatchObject({ status: 'failed', reason: 'channel_unavailable', detail: expect.stringContaining('fr, ar') });
    expect(inner.messages).toHaveLength(0);
  });

  it('open: the configured channel, unchanged', async () => {
    const inner = new TestWhatsAppChannel();
    const gate = new ProvenWhatsAppChannel(inner, { isProven: true, missing: [] });
    expect(gate.isEnabled).toBe(true);
    expect(gate.name).toBe(inner.name);
    await expect(gate.send(message)).resolves.toMatchObject({ status: 'accepted' });
    expect(inner.messages).toHaveLength(1);
  });
});
