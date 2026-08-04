import { TrackingType } from '@prisma/client';
import { RecognitionKey, TrackingStrategy } from '../tracking-strategy';

/**
 * Serial-tracked (TVs, laptops, consoles, cameras, power stations, …): each unit
 * has a free-form manufacturer serial. Learning by serial *prefix* is reserved
 * for 2C.5c (prefixes are vendor-specific), so `recognitionKey` returns null for
 * now — the scanner falls back to barcode/manual confirmation.
 */
export class SerialStrategy implements TrackingStrategy {
  readonly type = TrackingType.serial;
  readonly identifierLabel = 'Serial number';
  readonly perUnit = true;
  readonly identifierField = 'serialNo' as const;

  normalize(code: string): string {
    return (code ?? '').trim().toUpperCase();
  }

  validateIdentifier(code: string): { ok: boolean; reason?: string } {
    const serial = this.normalize(code);
    if (serial.length < 1) return { ok: false, reason: 'Serial number is required' };
    if (serial.length > 64) return { ok: false, reason: 'Serial number is too long (max 64)' };
    return { ok: true };
  }

  recognitionKey(): RecognitionKey | null {
    return null; // serial_prefix learning reserved for 2C.5c
  }
}
