import { CodeType, TrackingType } from '@prisma/client';
import { RecognitionKey, TrackingStrategy } from '../tracking-strategy';

/**
 * Quantity-tracked (accessories, bulk goods): NOT identified per unit — stock is
 * a count. A shared barcode identifies the *product*, so it doubles as the
 * learning-map key.
 */
export class QuantityStrategy implements TrackingStrategy {
  readonly type = TrackingType.quantity;
  readonly identifierLabel = null;
  readonly perUnit = false;
  readonly identifierField = null;

  normalize(code: string): string {
    return (code ?? '').trim();
  }

  validateIdentifier(): { ok: boolean; reason?: string } {
    return { ok: true }; // no per-unit identifier to validate
  }

  recognitionKey(code: string): RecognitionKey | null {
    const barcode = this.normalize(code);
    return barcode ? { codeType: CodeType.barcode, code: barcode } : null;
  }
}
