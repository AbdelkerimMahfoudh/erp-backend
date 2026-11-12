import { durationText, PaymentAlertService, REVIEW_OVERDUE_AFTER_MS } from './payment-alert.service';
import { getTemplate } from '../messaging/templates';

/*
 * The administrators' WhatsApp alerts about payment proofs (owner, 2026-11-05; 0138, 2026-11-12): to their own numbers,
 * no link, no customer or money details; once per new proof, once when a review is overdue — never twice.
 */
const ID = '01a1b807-fd67-73cd-8a76-9551e2b659b6';

function alerts(opts: { numbers?: string[]; template?: string; fail?: boolean; now?: Date; due?: string[] } = {}) {
  const sent: { to: string; template: string; language: string; variables: Record<string, string>; idempotencyKey: string }[] = [];
  const marks = new Map<string, Date>();
  const asked: unknown[] = [];
  const prisma = {
    paymentProof: {
      updateMany: async ({ where, data }: { where: Record<string, unknown> & { id: Buffer }; data: Record<string, Date> }) => {
        const field = Object.keys(data)[0];
        const key = `${where.id.toString('hex')}:${field}`;
        if (marks.has(key)) return { count: 0 };
        marks.set(key, data[field]);
        return { count: 1 };
      },
      findMany: async (q: unknown) => (asked.push(q), (opts.due ?? []).map((id) => ({ id: Buffer.from(id.replace(/-/g, ''), 'hex') }))),
    },
  };
  const config = { paymentAlertNumbers: opts.numbers ?? ['+22220000001', '+22220000002'], whatsappTemplateName: () => opts.template ?? 'dukan_admin_proof' };
  const whatsapp = {
    send: async (m: (typeof sent)[number]) => {
      sent.push(m);
      return opts.fail ? { status: 'failed', reason: 'temporary' } : { status: 'accepted' };
    },
  };
  const now = opts.now ?? new Date('2026-11-12T10:00:00Z');
  return { service: new PaymentAlertService(prisma as never, config as never, whatsapp as never, { now: () => now }), sent, marks, asked };
}

describe('the administrators’ payment alerts', () => {
  it('a new proof: both administrator numbers, the no-variable template — no link, no customer or money detail', async () => {
    const { service, sent } = alerts();
    expect(await service.proofSubmitted({ id: ID })).toEqual({ sent: 2 });
    expect(sent.map((m) => m.to)).toEqual(['+22220000001', '+22220000002']);
    expect(sent.every((m) => m.template === 'admin.proof_submitted' && m.language === 'en' && Object.keys(m.variables).length === 0)).toBe(true);
    expect(getTemplate('admin.proof_submitted')).toMatchObject({ use: 'operator', providerKind: 'utility', variables: [], configKey: 'WHATSAPP_TEMPLATE_ADMIN_PROOF' });
  });

  it('once: a retry, a second instance or a restart sends nothing more', async () => {
    const { service, sent } = alerts();
    await service.proofSubmitted({ id: ID });
    expect(await service.proofSubmitted({ id: ID })).toEqual({ sent: 0, skipped: 'already' });
    expect(sent).toHaveLength(2);
  });

  it('nothing without the approved template or the numbers — and nothing marked, so it is not lost while Meta reviews', async () => {
    const off = alerts({ template: '' });
    expect(await off.service.proofSubmitted({ id: ID })).toEqual({ sent: 0, skipped: 'no_template' });
    expect(off.marks.size).toBe(0);
    expect(await alerts({ numbers: [] }).service.proofSubmitted({ id: ID })).toEqual({ sent: 0, skipped: 'no_numbers' });
  });

  it('a failed delivery is logged and counted, never thrown at the Owner', async () => {
    expect(await alerts({ fail: true }).service.proofSubmitted({ id: ID })).toEqual({ sent: 0 });
  });

  it('a review overdue 24 hours after access was opened: its own template, once per proof; only undecided opened proofs are asked for', async () => {
    const now = new Date('2026-11-13T12:00:00Z');
    const { service, sent, asked } = alerts({ now, due: [ID], template: 'dukan_admin_overdue' });
    expect(await service.alertOverdue()).toBe(1);
    expect(await service.alertOverdue()).toBe(0);
    expect(sent.map((m) => m.template)).toEqual(['admin.proof_overdue', 'admin.proof_overdue']);
    expect(asked[0]).toMatchObject({ where: { status: 'under_review', openedAt: { lte: new Date(now.getTime() - REVIEW_OVERDUE_AFTER_MS) }, overdueAlertedAt: null } });
    expect(getTemplate('admin.proof_overdue')).toMatchObject({ use: 'operator', variables: [], configKey: 'WHATSAPP_TEMPLATE_ADMIN_OVERDUE' });
  });

  it('a duration line stays short with many stores', () => {
    expect(durationText(12, ['A', 'B', 'C', 'D', 'E'])).toBe('12 months — A, B, C +2');
    expect(durationText(1, [])).toBe('1 month');
  });
});
