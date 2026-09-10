import { Injectable } from '@nestjs/common';
import { CodeType } from '@prisma/client';
import { binToUuid } from '../common/utils/uuid.util';
import { InventoryService } from '../inventory/inventory.service';
import { CatalogService } from '../catalog/catalog.service';
import { TrackingStrategyRegistry } from '../tracking/tracking-strategy.registry';
import { RecognitionService } from './recognition.service';
import { classifyCode, ScanKind } from './code-classifier';
import { ScanResult } from './scan-result';

// Confidence for matches that are NOT (yet) learned mappings. Learned mappings
// are scored by the ConfidenceScorer; these are fixed priors, tunable later.
const CONFIDENCE_EXACT_BARCODE = 1; // the product's own primary barcode
const CONFIDENCE_TAC_CATALOG = 0.6; // global TAC → single catalog product
/** Contested mapping: never presented as near-certain, whatever the tally. */
const CONFIDENCE_CONFLICT_CEILING = 0.5;

/**
 * The one scanner pipeline. Every identifier (IMEI / barcode / serial, QR later)
 * enters through scan() and leaves as a ScanResult. Optimized for speed:
 * one classification, at most two cheap lookups, instant suggestion — no menus.
 */
@Injectable()
export class ScannerService {
  constructor(
    private readonly recognition: RecognitionService,
    private readonly catalog: CatalogService,
    private readonly registry: TrackingStrategyRegistry,
    private readonly inventory: InventoryService,
  ) {}

  async scan(rawCode: string, rawSecondary?: string): Promise<ScanResult> {
    const { kind, normalized } = classifyCode(rawCode);
    const recognitionKey = this.recognitionKeyFor(kind, normalized);

    /**
     * Does this handset already exist here?
     *
     * Asked for per-unit identifiers only. A barcode names a reusable product,
     * so "is this already in inventory" is not a question about it — every
     * cable shares one.
     *
     * Both IMEIs of a dual-SIM phone go in together. They are one physical
     * thing, and checking them separately is how two numbers off one box end up
     * attached to two different units.
     *
     * The answer comes from `InventoryService`, which already owns the
     * authoritative both-columns lookup that `findByIdentifier` uses. Writing a
     * second query here would be a second definition of "already have it".
     */
    const inventory =
      kind === 'imei' || kind === 'serial'
        ? await this.inventory.describeIdentifierConflict(
            [normalized, ...(rawSecondary ? [rawSecondary.trim()] : [])],
          )
        : null;

    const base: ScanResult = {
      code: normalized,
      kind,
      recognized: false,
      confidence: 0,
      recognitionKey,
      suggestion: null,
      inventory,
    };

    if (kind === 'unknown') {
      return { ...base, hint: 'Unrecognized code — create a new product template.' };
    }

    // 1. Learned mapping (the fast path once the store has taught the scanner).
    if (recognitionKey) {
      const match = await this.recognition.resolve(recognitionKey.codeType, recognitionKey.code);
      if (match) {
        const learnedId = binToUuid(match.productId);
        const suggestion = await this.catalog.findOrSuggest({ productId: learnedId });
        if (suggestion) {
          return this.scoreLearnedMatch(base, kind, normalized, learnedId, suggestion, match.signals);
        }
      }
    }

    // 2. Type-specific fallbacks (teach-on-confirm happens in the add flow, 2C.5d).
    if (kind === 'barcode') {
      const suggestion = await this.catalog.findOrSuggest({ barcode: normalized });
      return suggestion
        ? { ...base, recognized: true, confidence: CONFIDENCE_EXACT_BARCODE, suggestion }
        : { ...base, hint: 'New barcode — confirm the product to teach it.' };
    }

    if (kind === 'imei') {
      const rec = await this.catalog.recognize(normalized); // global TAC catalog + catalog match
      if (rec.suggestion?.productId) {
        const suggestion = await this.catalog.findOrSuggest({ productId: rec.suggestion.productId });
        if (suggestion) return { ...base, recognized: true, confidence: CONFIDENCE_TAC_CATALOG, suggestion };
      }
      return {
        ...base,
        hint: rec.known
          ? 'Recognized device — confirm the product to teach it.'
          : 'Unknown IMEI — create a new product template.',
      };
    }

    // serial: prefix learning is reserved; fall back to manual confirmation.
    return { ...base, hint: 'Serial scan — confirm the product manually (serial learning coming soon).' };
  }

  /**
   * Confidence for a learned mapping, cross-checked against the deterministic
   * signal for the same code.
   *
   * The statistical score alone is a measure of EVIDENCE ACCUMULATED, not of
   * certainty. A single confirmation scores 1/(1+2) = 0.333 by design — the
   * curve has to start low or two sightings would look conclusive. That is
   * correct in isolation and wrong the moment it overrides something already
   * certain: a barcode that IS the product's own barcode identifies it exactly,
   * however many times anyone has confirmed it.
   *
   * So the previous behaviour was that teaching a code made the scanner less
   * sure of it — 1.0 before, 0.333 after — which is the opposite of the
   * promise that recognition improves with use.
   *
   * The rule instead: a learned mapping is never scored BELOW the deterministic
   * signal that corroborates it, and a genuine disagreement lowers confidence
   * and is explained rather than hidden behind a number.
   *
   * Note this is not a floor of 1.0. With no corroborating signal the
   * statistical score stands unchanged, and corrections still erode it.
   */
  private async scoreLearnedMatch(
    base: ScanResult,
    kind: ScanKind,
    code: string,
    learnedProductId: string,
    suggestion: NonNullable<ScanResult['suggestion']>,
    signals: Parameters<RecognitionService['confidenceOf']>[0],
  ): Promise<ScanResult> {
    const learned = this.recognition.confidenceOf(signals);

    // What would the deterministic path have concluded for this same code?
    const corroborating =
      kind === 'barcode' ? await this.catalog.findOrSuggest({ barcode: code }) : null;

    if (!corroborating) {
      return { ...base, recognized: true, confidence: learned, suggestion };
    }

    if (corroborating.productId === learnedProductId) {
      // Both agree. Certainty comes from the exact match, not from tally size.
      return {
        ...base,
        recognized: true,
        confidence: Math.max(learned, CONFIDENCE_EXACT_BARCODE),
        suggestion,
      };
    }

    // Genuine conflict: memory says one product, the barcode belongs to
    // another. Report the learned match but say plainly that it is contested —
    // presenting either as confident would be a lie the employee cannot see.
    return {
      ...base,
      recognized: true,
      confidence: Math.min(learned, CONFIDENCE_CONFLICT_CEILING),
      suggestion,
      hint:
        `This code is linked to two different products — "${suggestion.brand} ${suggestion.model}" ` +
        `and "${corroborating.brand} ${corroborating.model}". Confirm the right one.`,
    };
  }

  private recognitionKeyFor(kind: ScanKind, code: string): { codeType: CodeType; code: string } | null {
    if (kind === 'imei') return this.registry.get('imei').recognitionKey(code);
    if (kind === 'barcode') return { codeType: CodeType.barcode, code };
    return null; // serial (reserved) / unknown
  }
}
