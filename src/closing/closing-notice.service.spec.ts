import { Prisma } from '@prisma/client';
import { ClosingNoticeService } from './closing-notice.service';
import { TestWhatsAppChannel } from '../messaging/channels';
import { saleNotice } from './closing-notices';
import { newUuidV7Bin } from '../common/utils/uuid.util';

/**
 * A notice reaches each Owner once, whatever happens to the request (docs/50
 * §3.4). The in-app row is inserted FIRST under the event's stable dedupe key;
 * a retry meets the unique index and sends nothing again. Nothing here can
 * throw into the sale or the close that caused it.
 */
const COMPANY = newUuidV7Bin();
const BRANCH = newUuidV7Bin();
const OWNER_A = newUuidV7Bin();
const OWNER_B = newUuidV7Bin();

function makeService(owners: { id: Buffer; phone: string | null }[]) {
  const inserted = new Set<string>();
  const created: unknown[] = [];
  const prisma: any = {
    branch: { findUnique: async () => ({ name: 'Main Store' }) },
    company: { findUnique: async () => ({ timezone: 'Africa/Nouakchott', currency: 'MRU' }) },
    companySettings: { findUnique: async () => ({ whatsappLanguage: 'fr', whatsappIncludeAmounts: true }) },
    userBranch: { findMany: async () => owners.map((u) => ({ user: u })) },
    notification: {
      create: async ({ data }: { data: { dedupeKey: string; targetUserId: Buffer } }) => {
        const key = `${data.dedupeKey}:${data.targetUserId.toString('hex')}`;
        if (inserted.has(key)) {
          const e = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
          throw e;
        }
        inserted.add(key);
        created.push(data);
        return data;
      },
    },
  };
  const channel = new TestWhatsAppChannel();
  return { service: new ClosingNoticeService(prisma, channel), channel, created };
}

const ctx = { branchName: 'Main Store', timezone: 'Africa/Nouakchott', businessDate: '2026-09-23', language: 'fr' as const, includeAmounts: true, currency: 'MRU' };
const sale = { saleIdHex: 'ab'.repeat(16), soldAt: new Date('2026-09-23T18:45:00Z'), total: 2500, amountPaid: 2500, balanceDue: 0, itemLabel: 'Google Pixel 8', itemCount: 1 };

describe('ClosingNoticeService.deliver', () => {
  it('tells every Owner once in-app, and sends by WhatsApp only to those with a number', async () => {
    const { service, channel, created } = makeService([
      { id: OWNER_A, phone: '+22200000001' },
      { id: OWNER_B, phone: null },
    ]);
    const notice = saleNotice(ctx, sale);
    notice.payload.language = 'fr';
    const outcome = await service.deliver(COMPANY, BRANCH, notice);
    expect(outcome).toEqual({ notified: 2, deduplicated: 0, sent: 1, failures: ['owner_has_no_phone'] });
    expect(created).toHaveLength(2);
    expect(channel.messages).toHaveLength(1);
    expect(channel.last).toMatchObject({ to: '+22200000001', template: 'closing.sale', language: 'fr', idempotencyKey: `${notice.dedupeKey}:${OWNER_A.toString('hex')}` });
    // Never the identifier, never a cost.
    expect(JSON.stringify(channel.last?.variables)).not.toMatch(/\d{15}|cost/i);
  });

  it('a retried delivery of the same event is deduplicated: no second row, no second message', async () => {
    const { service, channel } = makeService([{ id: OWNER_A, phone: '+22200000001' }]);
    const notice = saleNotice(ctx, sale);
    notice.payload.language = 'fr';
    await service.deliver(COMPANY, BRANCH, notice);
    const again = await service.deliver(COMPANY, BRANCH, notice);
    expect(again).toEqual({ notified: 0, deduplicated: 1, sent: 0, failures: [] });
    expect(channel.messages).toHaveLength(1);
  });

  it('a failed or throwing channel is recorded, never thrown', async () => {
    const { service, channel } = makeService([{ id: OWNER_A, phone: '+22200000001' }]);
    channel.nextResult = { status: 'failed', reason: 'channel_unavailable', detail: 'none', provider: 'test' };
    const outcome = await service.deliver(COMPANY, BRANCH, saleNotice(ctx, sale));
    expect(outcome.sent).toBe(0);
    expect(outcome.failures).toEqual(['channel_unavailable']);
    expect(outcome.notified).toBe(1);
  });

  it('a broken read never escapes either', async () => {
    const prisma: any = { branch: { findUnique: async () => { throw new Error('db down'); } } };
    const service = new ClosingNoticeService(prisma, new TestWhatsAppChannel());
    const outcome = await service.deliver(COMPANY, BRANCH, saleNotice(ctx, sale));
    expect(outcome.failures).toEqual(['notice_failed']);
  });
});
