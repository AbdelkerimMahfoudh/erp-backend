import { CodeType, TrackingType } from '@prisma/client';
import { RecognitionKey, TrackingStrategy } from '../tracking-strategy';
import { isValidImei, tacOf } from '../../inventory/imei.util';

/** IMEI-tracked (phones, cellular devices): 15-digit Luhn identifier, TAC key. */
export class ImeiStrategy implements TrackingStrategy {
  readonly type = TrackingType.imei;
  readonly identifierLabel = 'IMEI';
  readonly perUnit = true;
  readonly identifierField = 'imeiPrimary' as const;

  normalize(code: string): string {
    return (code ?? '').replace(/\D/g, '');
  }

  validateIdentifier(code: string): { ok: boolean; reason?: string } {
    return isValidImei(this.normalize(code))
      ? { ok: true }
      : { ok: false, reason: 'IMEI must be 15 digits and Luhn-valid' };
  }

  recognitionKey(code: string): RecognitionKey | null {
    const imei = this.normalize(code);
    if (!isValidImei(imei)) return null;
    return { codeType: CodeType.tac, code: tacOf(imei) };
  }
}
