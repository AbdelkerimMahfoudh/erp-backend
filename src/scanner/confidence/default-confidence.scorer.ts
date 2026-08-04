import { Injectable } from '@nestjs/common';
import { ConfidenceScorer, RecognitionSignals } from './confidence-scorer';

/**
 * v1 statistical confidence — a function of how strongly the CURRENT mapping is
 * affirmed (`confirmations`) tempered by how often the code has been corrected
 * (`corrections`). Deliberately NOT a function of `times_seen` alone.
 *
 *   volume = confirmations / (confirmations + 2)   → saturating trust in sightings
 *   purity = confirmations / (confirmations + corrections)  → corrections erode trust
 *   score  = volume * purity
 *
 * Recency (`lastConfirmedAt`) and per-source weighting (`sourceStats`,
 * `supplierConsistency`) are available on the signals and reserved for a richer
 * scorer — which drops in by swapping the CONFIDENCE_SCORER binding, no caller
 * changes.
 */
@Injectable()
export class DefaultConfidenceScorer implements ConfidenceScorer {
  score(s: RecognitionSignals): number {
    // Legacy rows (pre-0010) may have confirmations = 0 but times_seen > 0.
    const confirms = Math.max(0, s.confirmations || s.timesSeen);
    const corrects = Math.max(0, s.corrections);
    if (confirms === 0) return 0;

    const volume = confirms / (confirms + 2);
    const purity = confirms / (confirms + corrects);
    return volume * purity;
  }
}
