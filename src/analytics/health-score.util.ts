export type HealthStatus = 'red' | 'amber' | 'green';

/** A component's normalized score (0..1) before weighting. */
export interface ComponentScore {
  key: string;
  score: number; // 0..1
  insufficientData?: boolean;
}

export interface HealthComponent {
  key: string;
  score: number; // 0..1
  weight: number; // normalized 0..1
  contribution: number; // points added to the 0..100 score
  insufficientData: boolean;
}

export interface HealthResult {
  score: number; // 0..100
  status: HealthStatus;
  components: HealthComponent[];
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const r4 = (n: number): number => Math.round((n + Number.EPSILON) * 10_000) / 10_000;

/**
 * Combine component scores with company-configurable weights into an
 * explainable 0..100 health score. Weights are normalized by their sum so
 * owners can tune them freely (they need not sum to 1). Each component's
 * contribution sums to the overall score, so the frontend can explain exactly
 * why the score is what it is. Bands: <50 red, 50–75 amber, >75 green.
 */
export function combineHealth(scores: ComponentScore[], rawWeights: Record<string, number>): HealthResult {
  const weightSum = scores.reduce((s, c) => s + Math.max(0, rawWeights[c.key] ?? 0), 0);
  const denom = weightSum > 0 ? weightSum : 1;

  let total = 0;
  const components: HealthComponent[] = scores.map((c) => {
    const score = clamp01(c.score);
    const weight = Math.max(0, rawWeights[c.key] ?? 0) / denom;
    const contribution = score * weight * 100;
    total += contribution;
    return {
      key: c.key,
      score: r2(score),
      weight: r4(weight),
      contribution: r2(contribution),
      insufficientData: c.insufficientData ?? false,
    };
  });

  const score = Math.round(total * 10) / 10;
  const status: HealthStatus = score < 50 ? 'red' : score > 75 ? 'green' : 'amber';
  return { score, status, components };
}
