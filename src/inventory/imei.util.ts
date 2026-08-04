/** IMEI helpers: format + Luhn checksum validation, and TAC extraction. */

/** Luhn checksum over a numeric string. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48; // '0' = 48
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** A valid IMEI: exactly 15 digits and Luhn-valid. */
export function isValidImei(imei: string): boolean {
  return /^\d{15}$/.test(imei) && luhnValid(imei);
}

/** Type Allocation Code — first 8 digits (maps to make/model). */
export function tacOf(imei: string): string {
  return imei.slice(0, 8);
}
