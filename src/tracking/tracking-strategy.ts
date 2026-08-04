import { CodeType, TrackingType } from '@prisma/client';

/** Result of deriving a learning-map key from a scanned/entered code. */
export interface RecognitionKey {
  codeType: CodeType; // tac | barcode | serial_prefix
  code: string;
}

/**
 * Per-tracking-type behavior. Every module that identifies a unit (inventory,
 * sales, transfers, the scanner) goes through a strategy instead of branching on
 * the tracking type inline.
 *
 * `recognitionKey()` is the extension point the 2C.5c scanner uses to feed the
 * company learning map — it returns the stable code (TAC / barcode / serial
 * prefix) that maps to a product, or null when this type has no learnable key.
 */
export interface TrackingStrategy {
  readonly type: TrackingType;
  /** Field label for the per-unit identifier, or null when there is none. */
  readonly identifierLabel: string | null;
  /** true → each physical unit carries its own identifier (imei/serial). */
  readonly perUnit: boolean;
  /**
   * Which `units` column stores this type's identifier, so services build a
   * unit generically without branching on the tracking type. null → quantity
   * (no per-unit row; tracked as a StockItem count).
   */
  readonly identifierField: 'imeiPrimary' | 'serialNo' | null;

  /** Canonical form of a raw scanned/typed code. */
  normalize(code: string): string;
  /** Whether a normalized identifier is acceptable for this type. */
  validateIdentifier(code: string): { ok: boolean; reason?: string };
  /** Stable key for the learning map, or null if not learnable (yet). */
  recognitionKey(code: string): RecognitionKey | null;
}
