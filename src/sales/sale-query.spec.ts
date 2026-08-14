import { BadRequestException } from '@nestjs/common';
import { describeProduct, parseDateRange, parseEnumList } from './sale-query';

describe('filter lists', () => {
  const STATUSES = ['paid', 'partial', 'credit'] as const;

  it('reads a comma-separated list, trimming and de-duplicating', () => {
    expect(parseEnumList('paid, credit ,paid', STATUSES, 'payment status')).toEqual(['paid', 'credit']);
  });

  it('treats absent, empty and comma-only as no filter at all', () => {
    for (const raw of [undefined, '', '   ', ',', ' , ,']) {
      expect(parseEnumList(raw, STATUSES, 'payment status')).toEqual([]);
    }
  });

  /**
   * The dangerous alternative is dropping the unknown value and running the
   * query anyway: `?payStatus=paid,pade` would then match everything, and the
   * screen would show unpaid sales under a heading that says "paid".
   */
  it('refuses an unknown value rather than silently widening the query', () => {
    expect(() => parseEnumList('paid,pade', STATUSES, 'payment status')).toThrow(BadRequestException);
    expect(() => parseEnumList('paid,pade', STATUSES, 'payment status')).toThrow(/pade/);
  });

  it('names what was wrong, so the message is usable', () => {
    expect(() => parseEnumList('cheque', ['cash'] as const, 'payment method')).toThrow(
      /Unknown payment method: cheque/,
    );
  });
});

describe('the sold-at range', () => {
  it('is absent when neither end is given', () => {
    expect(parseDateRange(undefined, undefined)).toBeUndefined();
  });

  /**
   * A bare date means the whole day. `to=2026-08-03` interpreted as midnight
   * would return nothing for a day that had sales all afternoon — and an empty
   * list reads as "there were none", not as "you asked for an instant".
   */
  it('covers the entire day for a bare date, at both ends', () => {
    const r = parseDateRange('2026-08-03', '2026-08-03')!;
    expect(r.gte?.toISOString()).toBe('2026-08-03T00:00:00.000Z');
    // Exclusive upper bound: nothing sold at 23:59:59.999 can fall through.
    expect(r.lt?.toISOString()).toBe('2026-08-04T00:00:00.000Z');
  });

  it('includes a sale at the last millisecond of the closing day', () => {
    const r = parseDateRange(undefined, '2026-08-03')!;
    expect(new Date('2026-08-03T23:59:59.999Z') < r.lt!).toBe(true);
  });

  it('uses UTC, matching dayKey and the branch-day buckets', () => {
    expect(parseDateRange('2026-08-03')!.gte?.toISOString()).toBe('2026-08-03T00:00:00.000Z');
  });

  it('accepts a precise instant unchanged', () => {
    const r = parseDateRange('2026-08-03T14:30:00.000Z', '2026-08-03T15:00:00.000Z')!;
    expect(r.gte?.toISOString()).toBe('2026-08-03T14:30:00.000Z');
    expect(r.lt?.toISOString()).toBe('2026-08-03T15:00:00.000Z');
  });

  it('allows an open-ended range at either side', () => {
    expect(parseDateRange('2026-08-03', undefined)).toEqual({ gte: new Date('2026-08-03T00:00:00.000Z') });
    expect(parseDateRange(undefined, '2026-08-03')).toEqual({ lt: new Date('2026-08-04T00:00:00.000Z') });
  });

  it('refuses a backwards range instead of returning nothing', () => {
    // An empty result would look like "no sales", which is a different fact.
    expect(() => parseDateRange('2026-08-05', '2026-08-03')).toThrow(BadRequestException);
  });

  it('accepts a single day as a range, which is not backwards', () => {
    expect(() => parseDateRange('2026-08-03', '2026-08-03')).not.toThrow();
  });

  it('refuses an unparseable date', () => {
    expect(() => parseDateRange('yesterday')).toThrow(/Invalid from date/);
    expect(() => parseDateRange(undefined, '2026-13-45')).toThrow(BadRequestException);
  });
});

describe('naming a product the way a person would say it', () => {
  it('joins the parts that exist', () => {
    expect(describeProduct({ brand: 'Samsung', model: 'A15', variant: '128GB' })).toBe('Samsung A15 128GB');
  });

  it('leaves out the parts that are missing rather than printing gaps', () => {
    expect(describeProduct({ brand: 'Anker', model: null, variant: null })).toBe('Anker');
    expect(describeProduct({ brand: null, model: 'A15', variant: '128GB' })).toBe('A15 128GB');
  });

  it('is null when there is nothing to say', () => {
    expect(describeProduct(null)).toBeNull();
    expect(describeProduct(undefined)).toBeNull();
    expect(describeProduct({ brand: null, model: null, variant: null })).toBeNull();
  });
});
