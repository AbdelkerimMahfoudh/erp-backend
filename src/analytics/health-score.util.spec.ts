import { combineHealth } from './health-score.util';

const WEIGHTS = {
  profit_trend: 0.25,
  cash_flow: 0.15,
  stock_coverage: 0.2,
  overdue_debts: 0.15,
  dead_stock: 0.1,
  velocity: 0.15,
};
const keys = Object.keys(WEIGHTS);
const all = (v: number) => keys.map((key) => ({ key, score: v }));

describe('combineHealth', () => {
  it('scores a neutral store (all 0.5) at 50 → amber', () => {
    const r = combineHealth(all(0.5), WEIGHTS);
    expect(r.score).toBe(50);
    expect(r.status).toBe('amber');
  });

  it('scores a perfect store at 100 → green', () => {
    const r = combineHealth(all(1), WEIGHTS);
    expect(r.score).toBe(100);
    expect(r.status).toBe('green');
  });

  it('scores a failing store at 0 → red', () => {
    const r = combineHealth(all(0), WEIGHTS);
    expect(r.score).toBe(0);
    expect(r.status).toBe('red');
  });

  it('contributions sum to the overall score', () => {
    const r = combineHealth(
      [
        { key: 'profit_trend', score: 0.8 },
        { key: 'cash_flow', score: 0.6 },
        { key: 'stock_coverage', score: 0.9 },
        { key: 'overdue_debts', score: 1 },
        { key: 'dead_stock', score: 0.4 },
        { key: 'velocity', score: 0.5 },
      ],
      WEIGHTS,
    );
    const sum = r.components.reduce((s, c) => s + c.contribution, 0);
    expect(Math.round(sum * 10) / 10).toBe(r.score);
  });

  it('normalizes weights that do not sum to 1 (owner-tuned)', () => {
    // Double every weight → same normalized result as the canonical weights.
    const doubled = Object.fromEntries(Object.entries(WEIGHTS).map(([k, v]) => [k, v * 2]));
    expect(combineHealth(all(0.7), doubled).score).toBe(combineHealth(all(0.7), WEIGHTS).score);
  });

  it('exposes weight + insufficientData per component for explainability', () => {
    const r = combineHealth([{ key: 'profit_trend', score: 0.5, insufficientData: true }], { profit_trend: 1 });
    expect(r.components[0]).toMatchObject({ key: 'profit_trend', weight: 1, insufficientData: true });
  });
});
