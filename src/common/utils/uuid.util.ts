/**
 * UUIDv7 <-> BINARY(16) helpers for the application boundary.
 *
 * The database stores ids as BINARY(16) (Prisma `Bytes`). The API and logs only
 * ever deal with canonical 36-char UUID strings. Convert:
 *   - incoming string -> Buffer with `uuidToBin` (in DTO pipes / services)
 *   - outgoing Buffer -> string with `binToUuid` (serialization interceptor)
 *
 * UUIDv7 is time-ordered, which keeps the InnoDB clustered PK sequential.
 * In raw SQL, MySQL's native BIN_TO_UUID(x, 0) / UUID_TO_BIN(x, 0) do the same.
 *
 * Monotonic within the process (RFC 9562 §6.2, method 1): the 12 bits after
 * the version are a counter. A new millisecond seeds it at random in its lower
 * half, leaving at least 2048 increments; the same millisecond — or a clock
 * that stepped back — counts on from the last id, so every id this process
 * makes sorts after the one before it. Past 4096 in one millisecond, the next
 * millisecond is borrowed. Across processes, ids still sort only by their
 * millisecond: nothing may rely on them to order rows written on two clocks
 * (billing.service.ts `NEWEST_PERIOD_FIRST`).
 */
import { randomBytes } from 'node:crypto';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The millisecond the last id was made in, and its counter (`rand_a`). */
let lastMs = -1;
let counter = 0;

/** A fresh counter for a new millisecond: random, in the lower half of 12 bits. */
const seed = (): number => randomBytes(2).readUInt16BE(0) & 0x7ff;

/** Generate a new UUIDv7 as a 16-byte Buffer (BINARY(16)-ready), after every id made before it in this process. */
export function newUuidV7Bin(): Buffer {
  const now = Date.now();
  if (now > lastMs) {
    lastMs = now;
    counter = seed();
  } else {
    counter += 1;
    if (counter > 0xfff) {
      lastMs += 1;
      counter = seed();
    }
  }
  const buf = Buffer.alloc(16);
  buf.writeUIntBE(lastMs, 0, 6); // 48-bit big-endian ms timestamp
  buf[6] = 0x70 | (counter >> 8); // version 7, then the counter's top 4 bits
  buf[7] = counter & 0xff;
  randomBytes(8).copy(buf, 8);
  buf[8] = (buf[8] & 0x3f) | 0x80; // variant 10xx
  return buf;
}

/** Fresh UUIDv7 as a canonical string. */
export function newUuidV7(): string {
  return binToUuid(newUuidV7Bin());
}

/** Canonical UUID string -> 16-byte Buffer. Throws on malformed input. */
export function uuidToBin(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`Invalid UUID string: "${uuid}"`);
  }
  return Buffer.from(hex, 'hex');
}

/** 16-byte Buffer -> canonical UUID string. Throws if not 16 bytes. */
export function binToUuid(bin: Buffer | Uint8Array): string {
  if (bin.length !== 16) {
    throw new Error(`Invalid BINARY(16) length: ${bin.length}`);
  }
  const hex = Buffer.from(bin).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Type guard for a canonical UUID string. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** A 16-byte Buffer likely representing a BINARY(16) id (used by the serializer). */
export function isBinaryId(value: unknown): value is Buffer {
  return Buffer.isBuffer(value) && value.length === 16;
}
