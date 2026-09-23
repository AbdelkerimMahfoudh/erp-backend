import { assertNoticeSafe, formatAmount, formatLocalTime, reclosedNotice, reopenedNotice, saleNotice } from './closing-notices';

const ctx = {
  branchName: 'Main Store',
  timezone: 'Africa/Nouakchott',
  businessDate: '2026-09-23',
  language: 'en' as const,
  includeAmounts: true,
  currency: 'MRU',
};

describe('closing notices', () => {
  it('formats the local time and the amount without a locale dependency', () => {
    expect(formatLocalTime(new Date('2026-09-23T18:45:00Z'), 'Africa/Nouakchott')).toBe('18:45');
    expect(formatLocalTime(new Date('2026-09-23T18:45:00Z'), 'Asia/Dubai')).toBe('22:45');
    expect(formatAmount(2500, 'MRU')).toBe('2 500 MRU');
    expect(formatAmount(128000.5, 'MRU')).toBe('128 000.50 MRU');
    expect(formatAmount(-300, 'MRU')).toBe('−300 MRU');
  });

  it('a reopened notice names the branch, the local time and the business date, with a stable id', () => {
    const n = reopenedNotice(ctx, { closingIdHex: 'ab'.repeat(16), reopenCount: 1, at: new Date('2026-09-23T18:30:00Z'), mode: 'continue', automatic: false });
    expect(n.template).toBe('closing.reopened');
    expect(n.dedupeKey).toBe(`closing:${'ab'.repeat(16)}:reopened:1`);
    expect(n.variables).toEqual({ branch: 'Main Store', time: '18:30', date: '2026-09-23', what: '2026-09-23 continues' });
    expect(n.title).toBe('Day reopened · Main Store');
    const early = reopenedNotice(ctx, { closingIdHex: 'ab'.repeat(16), reopenCount: 1, at: new Date('2026-09-24T03:00:00Z'), mode: 'start_new', automatic: false, nextDate: '2026-09-24' });
    expect(early.variables.what).toBe('2026-09-24 started early');
    // The same event retried yields the same key — that is the whole point.
    expect(reopenedNotice(ctx, { closingIdHex: 'ab'.repeat(16), reopenCount: 1, at: new Date(), mode: 'continue', automatic: true }).dedupeKey).toBe(n.dedupeKey);
  });

  it('a sale notice distinguishes collected from owed on a partial payment, and hides amounts when told to', () => {
    const sale = { saleIdHex: 'cd'.repeat(16), soldAt: new Date('2026-09-23T18:45:00Z'), total: 2500, amountPaid: 1500, balanceDue: 1000, itemLabel: 'Google Pixel 8', itemCount: 1 };
    const n = saleNotice(ctx, sale);
    expect(n.dedupeKey).toBe(`closing-sale:${'cd'.repeat(16)}`);
    expect(n.variables.money).toBe('2 500 MRU · 1 500 MRU collected · 1 000 MRU still owed');
    expect(n.payload).toMatchObject({ total: 2500, collected: 1500, owed: 1000 });
    const paid = saleNotice(ctx, { ...sale, amountPaid: 2500, balanceDue: 0 });
    expect(paid.variables.money).toBe('2 500 MRU');
    const hidden = saleNotice({ ...ctx, includeAmounts: false }, sale);
    expect(hidden.variables.money).toBe('amounts hidden by your settings');
    expect(hidden.payload).not.toHaveProperty('total');
    expect(saleNotice(ctx, { ...sale, itemCount: 3 }).variables.item).toBe('Google Pixel 8 +2');
  });

  it('a reclosed notice separates the movement since the first count from the revised whole day', () => {
    const n = reclosedNotice(ctx, {
      closingIdHex: 'ef'.repeat(16),
      reopenCount: 1,
      at: new Date('2026-09-23T19:10:00Z'),
      sinceFirstCount: { salesValue: 2500, cashIn: 2500, salesCount: 1 },
      wholeDay: { salesValue: 22500, expectedCash: 22500, countedCash: 22500, difference: 0 },
    });
    expect(n.dedupeKey).toBe(`closing:${'ef'.repeat(16)}:reclosed:1`);
    expect(n.variables.since).toBe('since the first count: 1 · 2 500 MRU');
    expect(n.variables.whole).toBe('whole day: 22 500 MRU · 0 MRU');
    expect(n.body).toContain('19:10');
  });

  it('speaks the Owner’s language', () => {
    expect(reopenedNotice({ ...ctx, language: 'fr' }, { closingIdHex: '00'.repeat(16), reopenCount: 2, at: new Date(), mode: 'continue', automatic: false }).title).toBe('Journée rouverte · Main Store');
    expect(saleNotice({ ...ctx, language: 'ar' }, { saleIdHex: '00'.repeat(16), soldAt: new Date(), total: 1, amountPaid: 0, balanceDue: 1, itemLabel: 'X', itemCount: 1 }).variables.money).toContain('متبقٍ');
  });

  it('refuses a full identifier or a cost in any variable', () => {
    expect(() => assertNoticeSafe({ item: 'Pixel 8 IMEI 356938035643809' })).toThrow(/identifier/);
    expect(() => assertNoticeSafe({ item: 'Pixel 8 · 3569 3803 5643 809' })).toThrow(/identifier/);
    expect(() => assertNoticeSafe({ money: 'cost 1 200 MRU' })).toThrow(/cost/);
    expect(() => assertNoticeSafe({ item: 'Pixel 8 · IMEI •••• 7330' })).not.toThrow();
  });
});
