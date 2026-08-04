import { Injectable } from '@nestjs/common';
import { CodeType } from '@prisma/client';
import { binToUuid } from '../common/utils/uuid.util';
import { CatalogService } from '../catalog/catalog.service';
import { TrackingStrategyRegistry } from '../tracking/tracking-strategy.registry';
import { RecognitionService } from './recognition.service';
import { classifyCode, ScanKind } from './code-classifier';
import { ScanResult } from './scan-result';

// Confidence for matches that are NOT (yet) learned mappings. Learned mappings
// are scored by the ConfidenceScorer; these are fixed priors, tunable later.
const CONFIDENCE_EXACT_BARCODE = 1; // the product's own primary barcode
const CONFIDENCE_TAC_CATALOG = 0.6; // global TAC → single catalog product

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
  ) {}

  async scan(rawCode: string): Promise<ScanResult> {
    const { kind, normalized } = classifyCode(rawCode);
    const recognitionKey = this.recognitionKeyFor(kind, normalized);
    const base: ScanResult = {
      code: normalized,
      kind,
      recognized: false,
      confidence: 0,
      recognitionKey,
      suggestion: null,
    };

    if (kind === 'unknown') {
      return { ...base, hint: 'Unrecognized code — create a new product template.' };
    }

    // 1. Learned mapping (the fast path once the store has taught the scanner).
    if (recognitionKey) {
      const match = await this.recognition.resolve(recognitionKey.codeType, recognitionKey.code);
      if (match) {
        const suggestion = await this.catalog.findOrSuggest({ productId: binToUuid(match.productId) });
        if (suggestion) {
          return { ...base, recognized: true, confidence: this.recognition.confidenceOf(match.signals), suggestion };
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

  private recognitionKeyFor(kind: ScanKind, code: string): { codeType: CodeType; code: string } | null {
    if (kind === 'imei') return this.registry.get('imei').recognitionKey(code);
    if (kind === 'barcode') return { codeType: CodeType.barcode, code };
    return null; // serial (reserved) / unknown
  }
}
