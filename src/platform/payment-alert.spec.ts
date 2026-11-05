import { durationText, PaymentAlertService } from './payment-alert.service';
import { getTemplate } from '../messaging/templates';

/* The administrators' WhatsApp alert of a portal payment proof (owner, 2026-11-05). */
const company = Buffer.alloc(16, 1);
const owner = Buffer.alloc(16, 2);

function alerts(opts: { numbers?: string[]; template?: string; ownerVerified?: boolean; fail?: boolean }) {
  const sent: { to: string; template: string; language: string; variables: Record<string, string>; idempotencyKey: string }[] = [];
  const prisma = {
    company: { findUnique: async () => ({ name: 'Boutique Aicha', publicStoreId: 'AB12' }) },
    user: { findUnique: async () => ({ phone: '+22220000000', phoneVerifiedAt: opts.ownerVerified === false ? null : new Date() }) },
  };
  const config = { paymentAlertNumbers: opts.numbers ?? ['+22220000001', '+22220000002'], whatsappTemplateName: () => opts.template ?? 'dukan_payment_submitted' };
  const whatsapp = {
    send: async (m: (typeof sent)[number]) => {
      sent.push(m);
      return opts.fail ? { status: 'failed', reason: 'temporary' } : { status: 'accepted' };
    },
  };
  return { service: new PaymentAlertService(prisma as never, config as never, whatsapp as never), sent };
}
const proof = { id: 'p1', companyId: company, submittedBy: owner, amount: '2100', months: 3, stores: ['Tevragh Zeina', 'Ksar'] };

describe('the payment proof alert', () => {
  it('goes to every administrator number automatically: business, the Owner’s verified number, amount, duration and stores', async () => {
    const { service, sent } = alerts({});
    expect(await service.proofSubmitted(proof)).toEqual({ sent: 2 });
    expect(sent.map((m) => m.to)).toEqual(['+22220000001', '+22220000002']);
    expect(sent[0]).toMatchObject({
      template: 'payment.submitted',
      language: 'en',
      variables: { business: 'Boutique Aicha', phone: '+22220000000', amount: '2100', duration: '3 months — Tevragh Zeina, Ksar' },
    });
    // One key per proof and number: a retry cannot send it twice.
    expect(new Set(sent.map((m) => m.idempotencyKey)).size).toBe(2);
  });

  it('is an operator message in English, with exactly the approved template’s four variables', () => {
    expect(getTemplate('payment.submitted')).toMatchObject({ use: 'operator', providerKind: 'utility', languages: ['en'], variables: ['business', 'phone', 'amount', 'duration'], configKey: 'WHATSAPP_TEMPLATE_PAYMENT_SUBMITTED' });
  });

  it('never shows an unverified number', async () => {
    const { service, sent } = alerts({ ownerVerified: false });
    await service.proofSubmitted(proof);
    expect(sent[0].variables.phone).toBe('number not verified');
  });

  it('sends nothing without the approved template or without numbers — and says why', async () => {
    expect(await alerts({ template: '' }).service.proofSubmitted(proof)).toEqual({ sent: 0, skipped: 'no_template' });
    expect(await alerts({ numbers: [] }).service.proofSubmitted(proof)).toEqual({ sent: 0, skipped: 'no_numbers' });
  });

  it('a failed delivery is counted, never thrown at the Owner', async () => {
    expect(await alerts({ fail: true }).service.proofSubmitted(proof)).toEqual({ sent: 0 });
  });

  it('a duration line stays short with many stores', () => {
    expect(durationText(12, ['A', 'B', 'C', 'D', 'E'])).toBe('12 months — A, B, C +2');
    expect(durationText(1, [])).toBe('1 month');
  });
});
