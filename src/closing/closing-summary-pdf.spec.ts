import { ClosingNoticeService, type ReportPdfMaker } from './closing-notice.service';
import type { DeliveryResult, WhatsAppChannel, WhatsAppMessage } from '../messaging/whatsapp-channel';
import { daySummaryNotice, monthSummaryNotice } from './closing-notices';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import { getTemplate } from '../messaging/templates';

/**
 * The reports as the app's PDF on WhatsApp (owner, 2026-11-09): the PDF twin goes when its template is configured,
 * a PDF maker is registered and the Owner allows amounts; otherwise — or when the PDF cannot be made or is refused —
 * the text summary goes, so the Owner always has the day.
 */
const COMPANY = newUuidV7Bin();
const BRANCH = newUuidV7Bin();
const OWNER = newUuidV7Bin();
const PDF = { content: Buffer.from('%PDF-1.7 test'), filename: 'DukanERP_Ksar_Daily_2026-11-30_FR.pdf' };

class Recording implements WhatsAppChannel {
  readonly name = 'rec';
  readonly isEnabled = true;
  sent: WhatsAppMessage[] = [];
  refuse = new Set<string>();
  async send(m: WhatsAppMessage): Promise<DeliveryResult> {
    this.sent.push(m);
    if (this.refuse.has(m.template)) return { status: 'failed', reason: 'rejected', detail: 'no', provider: this.name };
    return { status: 'accepted', providerMessageId: 'x', provider: this.name };
  }
}

function setup(o: { includeAmounts?: boolean; maker?: ReportPdfMaker | null } = {}) {
  const prisma: any = {
    companySettings: { findUnique: async () => ({ whatsappDailyEnabled: true, whatsappMonthlyEnabled: true, whatsappIncludeAmounts: o.includeAmounts ?? true }) },
    userBranch: { findMany: async () => [{ user: { id: OWNER, phone: '+22200000001', phoneVerifiedAt: new Date('2026-09-01T00:00:00Z') } }] },
    notification: { create: async ({ data }: { data: unknown }) => data },
  };
  const channel = new Recording();
  const service = new ClosingNoticeService(prisma, channel);
  const calls: unknown[] = [];
  const maker: ReportPdfMaker = { make: async (a) => (calls.push(a), PDF) };
  if (o.maker !== null) service.usePdfMaker(o.maker ?? maker);
  return { service, channel, calls };
}

const ctx = { branchName: 'Ksar', timezone: 'Africa/Nouakchott', businessDate: '2026-11-30', language: 'fr' as const, includeAmounts: true, currency: 'MRU' };
const dayText = daySummaryNotice(ctx, { closingIdHex: 'cd'.repeat(16), salesCount: 3, salesValue: 9000, collected: 9000, owed: 0, difference: 0 });
const day = { ...dayText, payload: { ...dayText.payload, language: 'fr' } };
const month = monthSummaryNotice(ctx, { month: '2026-11', branchIdHex: 'ef'.repeat(16), salesCount: 30, salesValue: 90000, daysClosed: 29 });

describe('the report PDF on WhatsApp', () => {
  const keys = [getTemplate('closing.summary_pdf').configKey, getTemplate('closing.monthly_pdf').configKey];
  beforeEach(() => keys.forEach((k) => (process.env[k] = 'dukan_report_pdf')));
  afterEach(() => keys.forEach((k) => delete process.env[k]));

  it('the day: its PDF, for that Owner, store and date, with the text summary’s variables', async () => {
    const { service, channel, calls } = setup();
    const out = await service.deliver(COMPANY, BRANCH, day);
    expect(out.sent).toBe(1);
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toMatchObject({ template: 'closing.summary_pdf', document: PDF, variables: day.variables });
    expect(calls[0]).toMatchObject({ kind: 'daily', period: '2026-11-30', language: 'fr', ownerId: OWNER, branchId: BRANCH });
  });

  it('the month: its PDF for the month', async () => {
    const { service, channel, calls } = setup();
    await service.deliver(COMPANY, BRANCH, month);
    expect(channel.sent[0].template).toBe('closing.monthly_pdf');
    expect(calls[0]).toMatchObject({ kind: 'monthly', period: '2026-11' });
  });

  it('amounts not allowed by the Owner: the text summary only, no PDF made', async () => {
    const { service, channel, calls } = setup({ includeAmounts: false });
    await service.deliver(COMPANY, BRANCH, day);
    expect(calls).toHaveLength(0);
    expect(channel.sent.map((m) => m.template)).toEqual(['closing.summary']);
  });

  it('the PDF template not configured, or no maker: the text summary', async () => {
    delete process.env[keys[0]];
    const a = setup();
    await a.service.deliver(COMPANY, BRANCH, day);
    expect(a.channel.sent.map((m) => m.template)).toEqual(['closing.summary']);
    process.env[keys[0]] = 'dukan_report_pdf';
    const b = setup({ maker: null });
    await b.service.deliver(COMPANY, BRANCH, day);
    expect(b.channel.sent.map((m) => m.template)).toEqual(['closing.summary']);
  });

  it('the PDF not made, or refused: the text summary goes instead — once', async () => {
    const failing = setup({ maker: { make: async () => Promise.reject(new Error('chromium')) } });
    await failing.service.deliver(COMPANY, BRANCH, day);
    expect(failing.channel.sent.map((m) => m.template)).toEqual(['closing.summary']);

    const refused = setup();
    refused.channel.refuse.add('closing.summary_pdf');
    const out = await refused.service.deliver(COMPANY, BRANCH, day);
    expect(refused.channel.sent.map((m) => m.template)).toEqual(['closing.summary_pdf', 'closing.summary']);
    expect(refused.channel.sent[0].idempotencyKey).not.toBe(refused.channel.sent[1].idempotencyKey);
    expect(out.sent).toBe(1);
  });
});
