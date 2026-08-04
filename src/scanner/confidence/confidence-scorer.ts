/**
 * The full statistical picture of one learned mapping, read from the
 * product_recognition row (0010). A ConfidenceScorer consumes this — it is NOT
 * limited to times_seen. New confidence algorithms read more of these fields
 * WITHOUT any schema change (that is the whole point of 0010).
 */
export interface RecognitionSignals {
  /** Total times this code was scanned (all products, cumulative). */
  timesSeen: number;
  /** Times the CURRENT mapping was affirmed (resets when the code is corrected). */
  confirmations: number;
  /** Times this code was ever corrected to a different product (cumulative). */
  corrections: number;
  lastSeenAt: Date | null;
  lastConfirmedAt: Date | null;
  lastCorrectedAt: Date | null;
  /** Per-source affirmation counts, e.g. { receiving: 5, scan: 2, sale: 1 }. */
  sourceStats: Record<string, number>;
  /** Reserved — computed later from purchases/units (supplier intelligence). */
  supplierConsistency?: number;
}

/** A pluggable confidence rule. Swap the binding to change scoring globally;
 *  callers never change. */
export interface ConfidenceScorer {
  /** Confidence a mapping is correct, 0..1. */
  score(signals: RecognitionSignals): number;
}

export const CONFIDENCE_SCORER = Symbol('CONFIDENCE_SCORER');
