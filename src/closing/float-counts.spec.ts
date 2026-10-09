import { floatDifference, floatsToCount, listedFloats } from './float-counts';

/**
 * The floats at the closing of an agent branch (D154, docs/73 §4.5): which are
 * listed, which still stand between the day and its lock, and what a count's
 * difference is — pure, like the channel rules they sit beside.
 */

const providers = [
  { providerId: 'bankily', label: 'Bankily', isActive: true },
  { providerId: 'sedad', label: 'Sedad', isActive: true },
  { providerId: 'old', label: 'Old wallet', isActive: false },
];
const counts = (rows: { providerId: string; counted: number | null; isSkipped: boolean }[]) => new Map(rows.map((r) => [r.providerId, r]));

describe('the difference of a float count', () => {
  it('is counted − expected when both are known, to the cent', () => {
    expect(floatDifference(150_000, 149_900)).toBe(-100);
    expect(floatDifference(0.1, 0.3)).toBe(0.2);
  });

  it('is null — never zero — while either figure is unknown: nothing is fabricated to compare against', () => {
    expect(floatDifference(null, 40_000)).toBeNull();
    expect(floatDifference(1_000, null)).toBeNull();
    expect(floatDifference(null, null)).toBeNull();
  });
});

describe('which floats a closing lists', () => {
  it('every active provider, and a switched-off one only once somebody counted or skipped it at this closing', () => {
    expect(listedFloats(providers, counts([])).map((p) => p.providerId)).toEqual(['bankily', 'sedad']);
    expect(listedFloats(providers, counts([{ providerId: 'old', counted: 5, isSkipped: false }])).map((p) => p.providerId)).toEqual(['bankily', 'sedad', 'old']);
  });

  it('an electronics-only branch hands in no providers and lists nothing', () => {
    expect(listedFloats([], counts([]))).toEqual([]);
  });
});

describe('which floats the lock still waits for', () => {
  it('an active provider with neither a count nor a skip: silence is outstanding, not agreed', () => {
    expect(floatsToCount(providers, counts([])).map((p) => p.label)).toEqual(['Bankily', 'Sedad']);
    expect(floatsToCount(providers, counts([{ providerId: 'bankily', counted: 30_200, isSkipped: false }])).map((p) => p.label)).toEqual(['Sedad']);
  });

  it('a count of zero is a count, and a skip with a reason is a decision', () => {
    const done = counts([
      { providerId: 'bankily', counted: 0, isSkipped: false },
      { providerId: 'sedad', counted: null, isSkipped: true },
    ]);
    expect(floatsToCount(providers, done)).toEqual([]);
  });

  it('a switched-off provider is never waited for, even with money on it', () => {
    expect(floatsToCount([{ providerId: 'old', label: 'Old wallet', isActive: false }], counts([]))).toEqual([]);
  });
});
