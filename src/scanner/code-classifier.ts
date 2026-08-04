import { luhnValid } from '../inventory/imei.util';

/** What a scanned/typed code looks like. `unknown` → prompt to create a template. */
export type ScanKind = 'imei' | 'barcode' | 'serial' | 'unknown';

export interface Classification {
  kind: ScanKind;
  normalized: string;
}

/**
 * Classify a raw scanned code so the pipeline can route it. Order matters:
 *   1. IMEI  — exactly 15 digits AND Luhn-valid
 *   2. Barcode — 8..14 digits (EAN-8 / UPC-A / EAN-13 / ITF-14)
 *   3. Serial — other alphanumerics
 *   4. Unknown — anything else
 * QR payloads (URLs / GS1 element strings) are reserved: today a QR that
 * carries a plain code classifies by the rules above, richer parsing is later.
 */
export function classifyCode(raw: string): Classification {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { kind: 'unknown', normalized: '' };

  const digits = trimmed.replace(/[\s-]/g, '');
  if (/^\d{15}$/.test(digits) && luhnValid(digits)) {
    return { kind: 'imei', normalized: digits };
  }
  if (/^\d{8,14}$/.test(digits)) {
    return { kind: 'barcode', normalized: digits };
  }
  if (/^[A-Za-z0-9][A-Za-z0-9/\-]{2,63}$/.test(trimmed)) {
    return { kind: 'serial', normalized: trimmed.toUpperCase() };
  }
  return { kind: 'unknown', normalized: trimmed };
}
