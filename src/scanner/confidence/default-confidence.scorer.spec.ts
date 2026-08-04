import { DefaultConfidenceScorer } from './default-confidence.scorer';
import { RecognitionSignals } from './confidence-scorer';

describe('DefaultConfidenceScorer', () => {
  const scorer = new DefaultConfidenceScorer();
  const sig = (over: Partial<RecognitionSignals>): RecognitionSignals => ({
    timesSeen: 0,
    confirmations: 0,
    corrections: 0,
    lastSeenAt: null,
    lastConfirmedAt: null,
    lastCorrectedAt: null,
    sourceStats: {},
    ...over,
  });

  it('rises with confirmations and saturates below 1', () => {
    expect(scorer.score(sig({ confirmations: 1 }))).toBeCloseTo(1 / 3, 5);
    expect(scorer.score(sig({ confirmations: 3 }))).toBeCloseTo(0.6, 5);
    expect(scorer.score(sig({ confirmations: 8 }))).toBeCloseTo(0.8, 5);
    expect(scorer.score(sig({ confirmations: 1000 }))).toBeLessThan(1);
  });

  it('is eroded by corrections (not a function of times_seen alone)', () => {
    const clean = scorer.score(sig({ confirmations: 3, corrections: 0 }));
    const corrected = scorer.score(sig({ confirmations: 3, corrections: 3 }));
    expect(corrected).toBeLessThan(clean);
    expect(corrected).toBeCloseTo(0.6 * 0.5, 5);
  });

  it('does not use times_seen when confirmations are present', () => {
    const a = scorer.score(sig({ confirmations: 3, timesSeen: 3 }));
    const b = scorer.score(sig({ confirmations: 3, timesSeen: 999 }));
    expect(a).toEqual(b);
  });

  it('falls back to times_seen only for legacy rows with no confirmations', () => {
    expect(scorer.score(sig({ confirmations: 0, timesSeen: 3 }))).toBeCloseTo(0.6, 5);
  });

  it('returns 0 with no evidence', () => {
    expect(scorer.score(sig({}))).toBe(0);
  });
});
