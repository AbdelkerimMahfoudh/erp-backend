import { createHash } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { FakePrisma } from '../account/testing/fake-prisma';
import { ContactVerificationService } from './contact-verification.service';
import { ContactDeliveryProvider, OutboxDeliveryProvider, type DeliveryRequest, type DeliveryResult } from './contact-delivery';

/**
 * Proving a contact (correction phase, 2026-10-12): codes stored under a keyed hash, delivery recorded on the
 * code's row, and a code that could not be sent dead at once — never shown instead.
 */

const PEPPER = 'a-pepper-that-is-at-least-32-characters-long';

class Provider extends ContactDeliveryProvider {
  readonly name = 'channels';
  readonly sent: DeliveryRequest[] = [];
  constructor(private readonly answer: DeliveryResult | Error) {
    super();
  }
  canDeliver(): boolean {
    return true;
  }
  async send(req: DeliveryRequest): Promise<DeliveryResult> {
    this.sent.push(req);
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

function harness(opts: { pepper?: string | null; answer?: DeliveryResult | Error } = {}) {
  const prisma = new FakePrisma();
  const delivery = new Provider(opts.answer ?? { delivery: 'sent', provider: 'email:resend', providerMessageId: 'em-1' });
  const config = { otpPepper: opts.pepper === undefined ? PEPPER : opts.pepper };
  const service = new ContactVerificationService(prisma as never, delivery, new OutboxDeliveryProvider(), config as never);
  const row = () => prisma.rows('contactVerification').slice(-1)[0];
  return { prisma, delivery, service, row };
}

describe('the code’s hash', () => {
  it('is keyed with the pepper (version 2): the stored hash is not the unkeyed one, and the right code verifies', async () => {
    const h = harness();
    await h.service.start('owner@shop.mr', 'en');
    const code = h.delivery.sent[0].code;
    expect(h.row()).toMatchObject({ hashVersion: 2 });
    expect(h.row().codeHash).not.toBe(createHash('sha256').update(`owner@shop.mr:${code}`).digest('hex'));
    await expect(h.service.confirm('owner@shop.mr', '000000' === code ? '111111' : '000000')).resolves.toBe(false);
    expect(h.row().attempts).toBe(1);
    await expect(h.service.confirm('owner@shop.mr', code)).resolves.toBe(true);
  });

  it('a code issued before 0093 (version 1) still verifies; a version-2 code with the pepper gone never does', async () => {
    const h = harness({ pepper: null });
    await h.service.start('owner@shop.mr', 'en');
    expect(h.row()).toMatchObject({ hashVersion: 1 });
    await expect(h.service.confirm('owner@shop.mr', h.delivery.sent[0].code)).resolves.toBe(true);

    const keyed = harness();
    await keyed.service.start('owner@shop.mr', 'en');
    const lost = new ContactVerificationService(keyed.prisma as never, keyed.delivery, new OutboxDeliveryProvider(), { otpPepper: null } as never);
    await expect(lost.confirm('owner@shop.mr', keyed.delivery.sent[0].code)).resolves.toBe(false);
  });
});

describe('what delivery did, recorded on the row', () => {
  it('accepted by a provider: its name and message id', async () => {
    const h = harness();
    await expect(h.service.start('owner@shop.mr', 'fr')).resolves.toEqual({ delivery: 'sent', devCode: undefined });
    expect(h.row()).toMatchObject({ deliveryState: 'accepted', deliveryProvider: 'email:resend', providerMessageId: 'em-1', consumedAt: null });
  });

  it('the development outbox is recorded as the outbox, never as sent', async () => {
    const h = harness({ answer: { delivery: 'outbox', provider: 'dev-outbox' } });
    await h.service.start('owner@shop.mr', 'en');
    expect(h.row()).toMatchObject({ deliveryState: 'outbox', deliveryProvider: 'dev-outbox' });
  });

  it('not sent: the refusal goes back as it is, the code is dead at once, and it is never shown', async () => {
    const refusal = new ServiceUnavailableException({ code: 'delivery_failed', delivery: 'temporary', message: 'x' });
    const h = harness({ answer: refusal });
    await expect(h.service.start('owner@shop.mr', 'en')).rejects.toBe(refusal);
    expect(h.row()).toMatchObject({ deliveryState: 'failed', deliveryProvider: 'channels', deliveryDetail: 'temporary' });
    expect(h.row().consumedAt).toBeInstanceOf(Date);
    await expect(h.service.confirm('owner@shop.mr', h.delivery.sent[0].code)).resolves.toBe(false);
  });
});
