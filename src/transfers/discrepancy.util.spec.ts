import { computeDiscrepancy } from './discrepancy.util';

describe('computeDiscrepancy', () => {
  it('reports a clean match', () => {
    const r = computeDiscrepancy(['a', 'b'], ['a', 'b']);
    expect(r.matched.sort()).toEqual(['a', 'b']);
    expect(r.missing).toEqual([]);
    expect(r.unexpected).toEqual([]);
    expect(r.duplicate).toEqual([]);
    expect(r.hasDiscrepancy).toBe(false);
  });

  it('detects missing, unexpected, and duplicate', () => {
    const r = computeDiscrepancy(['a', 'b', 'c'], ['a', 'a', 'x']);
    expect(r.matched).toEqual(['a']);
    expect(r.missing.sort()).toEqual(['b', 'c']);
    expect(r.unexpected).toEqual(['x']);
    expect(r.duplicate).toEqual(['a']);
    expect(r.scanned.sort()).toEqual(['a', 'x']);
    expect(r.hasDiscrepancy).toBe(true);
  });

  it('handles an empty scan (everything missing)', () => {
    const r = computeDiscrepancy(['a', 'b'], []);
    expect(r.missing.sort()).toEqual(['a', 'b']);
    expect(r.hasDiscrepancy).toBe(true);
  });
});
