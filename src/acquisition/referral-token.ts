import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The opaque token in a registration link (0103, D221): `<portal>/join?r=<token>`.
 *
 * Two kinds, one shape — `base64url(kind ‖ ref ‖ version ‖ mac)`, 37 bytes, 50 characters:
 *
 *  - **kind** (1 byte): 1 a promoter's QR link, 2 a user invitation;
 *  - **ref** (16 bytes): the row's random `public_ref` — never its id, never a name, a number or a code;
 *  - **version** (4 bytes, big-endian): a promoter's code version, so regenerating the code invalidates every QR link
 *    printed before it; 0 for an invitation, which is revoked instead;
 *  - **mac** (16 bytes): HMAC-SHA256 under REFERRAL_KEY, in this kind's own purpose domain, truncated to 128 bits.
 *
 * Nothing is stored that could be replayed: the server signs the same bytes again whenever it needs the link, so the
 * console can show a promoter's QR as often as it likes and a leaked database yields no working link. A token that was
 * changed in any byte fails its MAC and is unknown; a valid MAC only says the server minted it — whether it is still
 * usable is the row's decision (active, current version, not revoked).
 */

export type ReferralKind = 'promoter' | 'user_invite';

const KIND_BYTE: Record<ReferralKind, number> = { promoter: 1, user_invite: 2 };
const DOMAIN: Record<ReferralKind, string> = {
  promoter: 'dukan-erp/promoter-qr/v1',
  user_invite: 'dukan-erp/user-invite/v1',
};
const REF_BYTES = 16;
const MAC_BYTES = 16;
const TOKEN_BYTES = 1 + REF_BYTES + 4 + MAC_BYTES;
/** The token's exact length in base64url, unpadded. Anything else is refused before a byte is decoded. */
export const REFERRAL_TOKEN_LENGTH = Math.ceil((TOKEN_BYTES * 4) / 3);

const TOKEN_SHAPE = new RegExp(`^[A-Za-z0-9_-]{${REFERRAL_TOKEN_LENGTH}}$`);

export interface ReferralClaim {
  kind: ReferralKind;
  ref: Buffer;
  version: number;
}

function mac(key: string, kind: ReferralKind, body: Buffer): Buffer {
  return createHmac('sha256', key).update(DOMAIN[kind]).update('\n').update(body).digest().subarray(0, MAC_BYTES);
}

/** The token for this row and version. Deterministic: the same inputs always give the same link. */
export function signReferralToken(key: string, claim: ReferralClaim): string {
  if (claim.ref.length !== REF_BYTES) throw new Error('A referral reference is 16 bytes.');
  if (!Number.isInteger(claim.version) || claim.version < 0 || claim.version > 0xffffffff) throw new Error('A referral version is a 32-bit count.');
  const body = Buffer.alloc(1 + REF_BYTES + 4);
  body[0] = KIND_BYTE[claim.kind];
  claim.ref.copy(body, 1);
  body.writeUInt32BE(claim.version, 1 + REF_BYTES);
  return Buffer.concat([body, mac(key, claim.kind, body)]).toString('base64url');
}

/** What a token claims, if the server minted it; null for anything else — one answer for every kind of wrong. */
export function verifyReferralToken(key: string, token: unknown): ReferralClaim | null {
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return null;
  const raw = Buffer.from(token, 'base64url');
  if (raw.length !== TOKEN_BYTES) return null;
  const kind = raw[0] === 1 ? 'promoter' : raw[0] === 2 ? 'user_invite' : null;
  if (!kind) return null;
  const body = raw.subarray(0, 1 + REF_BYTES + 4);
  if (!timingSafeEqual(raw.subarray(1 + REF_BYTES + 4), mac(key, kind, body))) return null;
  return { kind, ref: Buffer.from(body.subarray(1, 1 + REF_BYTES)), version: body.readUInt32BE(1 + REF_BYTES) };
}

/** `<portal>/join?r=<token>` — the one address every QR card and every shared invitation carries. */
export function referralLink(portalOrigin: string, token: string): string {
  return `${portalOrigin}/join?r=${token}`;
}
