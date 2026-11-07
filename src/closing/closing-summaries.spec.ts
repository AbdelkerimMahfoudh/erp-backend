import { Prisma } from '@prisma/client';
import { ClosingNoticeService } from './closing-notice.service';
import { TestWhatsAppChannel } from '../messaging/channels';
import { daySummaryNotice, monthSummaryNotice } from './closing-notices';
import { isLastDayOfMonth } from './closing.service';
import { getTemplate, PLANNED_TEMPLATES, validateTemplateVariables } from '../messaging/templates';
import { newUuidV7Bin } from '../common/utils/uuid.util';

/**
 * The Owner's WhatsApp summaries (owner, 2026-11-07): the day's at its first close, the month's at the close of its
 * last day. Each goes to WhatsApp only while its switch is on; the in-app notice is always written; amounts only
 * with "include amounts"; never a cost or a full identifier.
 */
const COMPANY = newUuidV7Bin();
const BRANCH = newUuidV7Bin();
const OWNER = newUuidV7Bin();

function makeService(settings: { whatsappDailyEnabled: boolean; whatsappMonthlyEnabled: boolean } | null) {
  const inserted = new Set<string>();
  const prisma: any = {
    companySettings: { findUnique: async () => settings },
    userBranch: { findMany: async () => [{ user: { id: OWNER, phone: '+22200000001', phoneVerifiedAt: new Date('2026-09-01T00:00:00Z') } }] },
    notification: {
      create: async ({ data }: { data: { dedupeKey: string; targetUserId: Buffer } }) => {
        const key = `${data.dedupeKey}:${data.targetUserId.toString('hex')}`;
        if (inserted.has(key)) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
        inserted.add(key);
        return data;
      },
    },
  };
  const channel = new TestWhatsAppChannel();
  return { service: new ClosingNoticeService(prisma, channel), channel };
}

const ctx = (language: 'en' | 'fr' | 'ar', includeAmounts: boolean) => ({
  branchName: 'Dukan · Ksar',
  timezone: 'Africa/Nouakchott',
  businessDate: '2026-11-30',
  language,
  includeAmounts,
  currency: 'MRU',
});
const day = { closingIdHex: 'cd'.repeat(16), salesCount: 12, salesValue: 340000, collected: 300000, owed: 40000, difference: 0 };
const month = { month: '2026-11', branchIdHex: 'ef'.repeat(16), salesCount: 310, salesValue: 9100000, daysClosed: 29 };

describe('the day’s and the month’s WhatsApp summaries', () => {
  it('the day’s: count and amounts with "include amounts", the count alone without — in EN, FR and AR', () => {
    for (const lang of ['en', 'fr', 'ar'] as const) {
      const withAmounts = daySummaryNotice(ctx(lang, true), day);
      expect(withAmounts.template).toBe('closing.summary');
      expect(withAmounts.variables.sales).toContain('12');
      expect(withAmounts.variables.sales).toContain('340 000 MRU');
      expect(withAmounts.variables.money).toContain('300 000 MRU');
      expect(() => validateTemplateVariables(getTemplate('closing.summary'), withAmounts.variables)).not.toThrow();
      const without = daySummaryNotice(ctx(lang, false), day);
      expect(JSON.stringify(without.variables)).not.toMatch(/MRU|340|300/);
      expect(without.payload).not.toHaveProperty('salesValue');
    }
  });

  it('an uncounted drawer is said so, never shown as a zero difference', () => {
    expect(daySummaryNotice(ctx('fr', true), { ...day, difference: null }).variables.money).toContain('caisse non comptée');
  });

  it('the month’s: its sales and the days closed; one per store and month', () => {
    const n = monthSummaryNotice(ctx('fr', true), month);
    expect(n.template).toBe('closing.monthly');
    expect(n.variables).toMatchObject({ month: '2026-11', days: '29 jours clôturés' });
    expect(n.variables.sales).toContain('9 100 000 MRU');
    expect(n.dedupeKey).toBe(`closing:${'ef'.repeat(16)}:monthly:2026-11`);
    expect(() => validateTemplateVariables(getTemplate('closing.monthly'), n.variables)).not.toThrow();
  });

  it('switched on: in-app and WhatsApp, once — a retried close sends nothing again', async () => {
    const { service, channel } = makeService({ whatsappDailyEnabled: true, whatsappMonthlyEnabled: true });
    const notice = daySummaryNotice(ctx('fr', true), day);
    notice.payload.language = 'fr';
    expect(await service.deliver(COMPANY, BRANCH, notice)).toMatchObject({ notified: 1, sent: 1 });
    expect(await service.deliver(COMPANY, BRANCH, notice)).toMatchObject({ deduplicated: 1, sent: 0 });
    expect(channel.messages).toHaveLength(1);
    expect(channel.last).toMatchObject({ template: 'closing.summary', language: 'fr' });
  });

  it('switched off: the in-app notice only, no WhatsApp — daily and monthly each by their own switch', async () => {
    const off = makeService({ whatsappDailyEnabled: false, whatsappMonthlyEnabled: true });
    expect(await off.service.deliver(COMPANY, BRANCH, daySummaryNotice(ctx('en', false), day))).toMatchObject({ notified: 1, sent: 0, failures: ['summary_switched_off'] });
    expect(await off.service.deliver(COMPANY, BRANCH, monthSummaryNotice(ctx('en', false), month))).toMatchObject({ notified: 1, sent: 1 });
    expect(off.channel.messages.map((m) => m.template)).toEqual(['closing.monthly']);
  });

  it('a business with no settings row follows the default: on', async () => {
    const { service } = makeService(null);
    expect(await service.deliver(COMPANY, BRANCH, daySummaryNotice(ctx('en', false), day))).toMatchObject({ sent: 1 });
  });

  it('the month’s summary goes at the close of its last day only', () => {
    expect(['2026-11-30', '2026-12-31', '2028-02-29', '2026-02-28'].map(isLastDayOfMonth)).toEqual([true, true, true, true]);
    expect(['2026-11-29', '2028-02-28', '2026-12-01'].map(isLastDayOfMonth)).toEqual([false, false, false]);
  });

  it('no longer planned: both are registered templates', () => {
    expect(PLANNED_TEMPLATES).not.toContain('summary.daily');
    expect(getTemplate('closing.summary').configKey).toBe('WHATSAPP_TEMPLATE_CLOSING_SUMMARY');
    expect(getTemplate('closing.monthly').configKey).toBe('WHATSAPP_TEMPLATE_CLOSING_MONTHLY');
  });
});
