import { Matches } from 'class-validator';

/**
 * A client's idempotency key: 1 to 80 ASCII letters, digits and `. _ : -` — what a UUID is made of (C11; review
 * finding R2-5).
 *
 * The key is stored in an 80-character column and compared in full on a retry. A length check alone counts what the
 * column does not — a variation selector, the second half of a surrogate pair — so a key it let through could be cut
 * by MySQL on the way in and never match its own retry: the client's replay would be refused as somebody else's
 * attempt. Plain ASCII is stored exactly as it was sent.
 */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,80}$/;

export function IsIdempotencyKey() {
  return Matches(IDEMPOTENCY_KEY);
}
