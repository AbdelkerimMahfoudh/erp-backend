import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { WhatsAppWebhookController, extractStatuses, signatureMatches } from './whatsapp-webhook.controller';

/**
 * The provider's delivery-status webhook (docs/64 §3).
 *
 * Two public routes, both closed by construction: the subscription check
 * answers only with the configured verify token, and a status report is read
 * only when its signature is the HMAC of the exact bytes received.
 */

const SECRET = 'app-secret-for-tests';
const sign = (raw: Buffer, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

function harness(opts: { verifyToken?: string; appSecret?: string } = {}) {
  const updates: unknown[] = [];
  const prisma = {
    otpChallenge: {
      updateMany: jest.fn(async (args: unknown) => {
        updates.push(args);
        return { count: 1 };
      }),
    },
  };
  const config = {
    whatsappWebhookVerifyToken: opts.verifyToken ?? '',
    whatsappAppSecret: opts.appSecret ?? '',
  };
  const controller = new WhatsAppWebhookController(config as never, prisma as never);
  return { controller, updates, prisma };
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

describe('receiving a report', () => {
  const body = {
    entry: [
      {
        changes: [
          {
            value: {
              statuses: [
                { id: 'wamid.ok', status: 'delivered' },
                { id: 'wamid.bad', status: 'failed', errors: [{ code: 131026 }] },
              ],
            },
          },
        ],
      },
    ],
  };
  const raw = Buffer.from(JSON.stringify(body));

  it('does not exist until configured', async () => {
    const { controller } = harness();
    await expect(controller.receive({ rawBody: raw, body } as never, sign(raw))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses an unsigned or mis-signed body before reading it', async () => {
    const { controller, updates } = harness({ verifyToken: 'v', appSecret: SECRET });
    await expect(controller.receive({ rawBody: raw, body } as never, undefined)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      controller.receive({ rawBody: raw, body } as never, sign(raw, 'wrong')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    // No raw body means the signature cannot be checked, so nothing is trusted.
    await expect(controller.receive({ body } as never, sign(raw))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(updates).toHaveLength(0);
  });

  it('records the delivery state on the challenge the message belongs to', async () => {
    const { controller, updates } = harness({ verifyToken: 'v', appSecret: SECRET });

    const result = await controller.receive({ rawBody: raw, body } as never, sign(raw));

    expect(result).toEqual({ received: 2 });
    expect(updates).toEqual([
      {
        where: { providerMessageId: 'wamid.ok', provider: 'cloud-api' },
        data: { deliveryDetail: 'Provider reported: delivered' },
      },
      {
        where: { providerMessageId: 'wamid.bad', provider: 'cloud-api' },
        data: { deliveryState: 'rejected', deliveryDetail: 'Provider reported failure (code 131026)' },
      },
    ]);
  });

  it('is scoped to the provider id, so a forged id cannot touch another challenge', async () => {
    const { controller, updates } = harness({ verifyToken: 'v', appSecret: SECRET });
    await controller.receive({ rawBody: raw, body } as never, sign(raw));
    for (const u of updates as { where: Record<string, unknown> }[]) {
      expect(u.where.provider).toBe('cloud-api');
      expect(typeof u.where.providerMessageId).toBe('string');
    }
  });
});
