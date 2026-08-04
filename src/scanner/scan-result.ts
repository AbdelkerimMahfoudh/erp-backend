import { CodeType } from '@prisma/client';
import { ProductSuggestion } from '../catalog/catalog.service';
import { ScanKind } from './code-classifier';

/** The single response shape for POST /scan, for every identifier kind. */
export interface ScanResult {
  /** Normalized code. */
  code: string;
  kind: ScanKind;
  recognized: boolean;
  /** 0..1 confidence in the suggestion (0 when not recognized). */
  confidence: number;
  /** Learning-map key for this code, so a later confirm can teach it. */
  recognitionKey: { codeType: CodeType; code: string } | null;
  suggestion: ProductSuggestion | null;
  /** Short guidance when not recognized (client shows create/confirm prompt). */
  hint?: string;
}
