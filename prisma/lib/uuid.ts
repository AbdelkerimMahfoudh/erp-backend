// ===========================================================================
// UUIDv7 <-> BINARY(16) helpers  (M2 / requirement: documented conversions)
// ---------------------------------------------------------------------------
// Primary keys are UUIDv7 stored as BINARY(16). IDs are generated APP-SIDE
// (offline-friendly) and passed to Prisma as `Buffer` (Prisma `Bytes`).
//
// Keep the boundary simple for future API + logging work:
//   • Internally / in the DB  → 16-byte Buffer (compact, InnoDB-clustered).
//   • At the API edge & logs   → canonical 36-char string via `binToUuid`.
//
// In raw SQL you do NOT need these — MySQL 8 has native BIN_TO_UUID(id) and
// UUID_TO_BIN('...') (use swap_flag = 0 for UUIDv7, which is already
// time-ordered). These helpers are the JS/TS equivalents.
// ===========================================================================

import { randomBytes } from 'node:crypto';

/**
 * Generate a new UUIDv7 as a 16-byte Buffer (ready to store in BINARY(16)).
 * Layout (RFC 9562): 48-bit big-endian ms timestamp | version(7) | 74 random bits.
 * Time-ordered ⇒ sequential InnoDB inserts. Offline-safe (no DB round-trip).
 */
export function newUuidV7Bin(): Buffer {
  const buf = Buffer.alloc(16);
  const ts = Date.now(); // ms since epoch (fits in 48 bits until year 10889)

  // bytes 0..5 = 48-bit timestamp, big-endian
  buf.writeUIntBE(ts, 0, 6);

  // bytes 6..15 = random
  randomBytes(10).copy(buf, 6);

  // version 7 in the high nibble of byte 6
  buf[6] = (buf[6] & 0x0f) | 0x70;
  // variant (10xx) in the two high bits of byte 8
  buf[8] = (buf[8] & 0x3f) | 0x80;

  return buf;
}

/** Convenience: a fresh UUIDv7 as a canonical string. */
export function newUuidV7(): string {
  return binToUuid(newUuidV7Bin());
}

/**
 * UUID string → 16-byte Buffer. Accepts canonical form with or without dashes.
 * Throws on malformed input.
 */
export function uuidToBin(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`Invalid UUID string: "${uuid}"`);
  }
  return Buffer.from(hex, 'hex');
}

/**
 * 16-byte Buffer/Uint8Array → canonical 36-char UUID string.
 * Throws if the input is not exactly 16 bytes.
 */
export function binToUuid(bin: Buffer | Uint8Array): string {
  if (bin.length !== 16) {
    throw new Error(`Invalid BINARY(16) length: ${bin.length}`);
  }
  const hex = Buffer.from(bin).toString('hex');
  return (
    hex.slice(0, 8) + '-' +
    hex.slice(8, 12) + '-' +
    hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' +
    hex.slice(20)
  );
}
