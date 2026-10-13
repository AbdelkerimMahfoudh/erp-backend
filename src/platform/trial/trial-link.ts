import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Prisma, TrialSetupLinkRevokedReason } from '@prisma/client';

/**
 * What a setup link is worth to the signed-in Owner who presents it (0095; docs/76) — pure.
 *
 * The setup instructions carry a link to the Dukan ERP website so the Owner lands on the right page already holding
 * a reason to trust it. The link is a convenience and never a key (the owner's clarification of 2026-10-13): it is
 * looked at only AFTER the Owner signed in, it never activates anything by being opened, and an eligible Owner who
 * signs in without it sees exactly the same offer. So everything here answers one narrow question — may this signed-in
 * Owner's claim go with this link? — and the answer is never the reason a claim is allowed.
 *
 * The token itself is never stored: only its SHA-256 (`trial-rules.setupTokenHash`). A row is bound to the Owner it
 * was sent to by a keyed digest of their credentials and contacts as they were when it was sent, so a password, a
 * contact or a verification that changed since makes the link stale — revoked — without anything having to find it.
 */

/** The answers a link can get, in the order they are decided. Only `valid` lets a claim consume it. */
export type TrialLinkOutcome = 'valid' | 'expired' | 'used' | 'revoked' | 'invalid' | 'other_account';

/**
 * A key for development machines that have no OTP pepper, so a developer can walk the flow by hand. Not a secret:
 * it is in this file, and it is never used where a pepper is required — production and staging get none at all.
 */
const DEVELOPMENT_BINDING_KEY = 'dukan-erp/trial-setup-link/development-only';

/**
 * The key the binding digest is computed under: the OTP pepper — the server-side secret that already keys every
 * verification code — or, on a development machine without one, the fixed development key. Production and staging
 * without a pepper get null, and then no link can be bound or trusted: a digest anybody can recompute from this
 * repository would bind nothing.
 */
export function bindingKey(pepper: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (pepper) return pepper;
  const appEnv = (env.APP_ENV ?? '').toLowerCase();
  if (appEnv === 'production' || appEnv === 'staging') return null;
  return (env.NODE_ENV ?? '').toLowerCase() === 'production' ? null : DEVELOPMENT_BINDING_KEY;
}

/** The Owner's credentials and contacts as the account holds them — what a link is bound to. */
export interface LinkBinding {
  passwordHash: string;
  email: string | null;
  phone: string | null;
  emailVerifiedAt: Date | null;
  phoneVerifiedAt: Date | null;
}

/**
 * The keyed digest a link stores at issue and is compared with at use (`trial_setup_links.binding_digest`). Any change
 * to the password, a contact or a verification instant changes it, so a link sent before such a change no longer
 * matches the Owner it was sent to. The material is the password's HASH, never the password.
 */
export function bindingDigest(key: string, owner: LinkBinding): string {
  const material = [
    'trial-link',
    owner.passwordHash,
    owner.email ?? '',
    owner.phone ?? '',
    owner.emailVerifiedAt?.toISOString() ?? '',
    owner.phoneVerifiedAt?.toISOString() ?? '',
  ].join('|');
  return createHmac('sha256', key).update(material, 'utf8').digest('hex');
}

/**
 * The digest a link is bound with, for this Owner as the account holds them now — or null when no key exists
 * (`bindingKey`), and then no link can be issued or trusted. The setup instructions issue with it and the claim checks
 * with it: one function, so the two can never compute it differently.
 */
export function linkBindingOf(
  pepper: string | null,
  owner: LinkBinding,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const key = bindingKey(pepper, env);
  return key ? bindingDigest(key, owner) : null;
}

/** A stored link, as the outcome needs it. */
export interface SetupLinkFacts {
  companyId: Buffer;
  userId: Buffer;
  bindingDigest: string;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
}

/** Compared in constant time: a digest is a credential's fingerprint, and a timing leak would let one be guessed. */
function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The link's outcome for this signed-in Owner, in this order: no row for the token → `invalid` (forged, mistyped,
 * or never sent); another business's or another person's → `other_account`, before anything about it is told;
 * consumed → `used`; revoked → `revoked`; past its end → `expired`; bound to credentials or contacts that have
 * changed since, or unbindable here (no key) → `revoked`; otherwise `valid`.
 *
 * `currentDigest` is the digest of the link's Owner as they are now, or null when no key exists. Nothing here
 * consumes anything: only a successful claim does.
 */
export function linkOutcomeOf(
  link: SetupLinkFacts | null,
  caller: { companyId: Buffer; userId: Buffer },
  now: Date,
  currentDigest: string | null,
): TrialLinkOutcome {
  if (!link) return 'invalid';
  if (!link.companyId.equals(caller.companyId) || !link.userId.equals(caller.userId)) return 'other_account';
  if (link.consumedAt) return 'used';
  if (link.revokedAt) return 'revoked';
  if (link.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (!currentDigest || !digestsMatch(currentDigest, link.bindingDigest)) return 'revoked';
  return 'valid';
}

/** A claim that carries a link which is not `valid` is refused with the link's own code — never anything else. */
export const LINK_REFUSAL = {
  invalid: 'link_invalid',
  expired: 'link_expired',
  used: 'link_used',
  revoked: 'link_revoked',
  other_account: 'link_other_account',
} as const satisfies Record<Exclude<TrialLinkOutcome, 'valid'>, string>;

/**
 * The write that retires every link that could still be used — unconsumed and unrevoked — among those named, with
 * the reason it stops working: a new send (`reissued`), the claim (`claimed`), the Owner signing out everywhere, a
 * contact or the password changing, the Owner's login deleted, the business closed. A link already used or revoked
 * keeps the reason it has; the first one is the one that is true.
 *
 * Arguments for `updateMany`, not a call: it runs on whichever client the caller holds — a transaction, the tenant's
 * scoped client, a batch — with the caller's own instant.
 */
export function revokeUsableLinks(
  where: { companyId?: Buffer; userId?: Buffer },
  reason: TrialSetupLinkRevokedReason,
  now: Date,
) {
  return {
    where: { ...where, consumedAt: null, revokedAt: null },
    data: { revokedAt: now, revokedReason: reason },
  } satisfies Prisma.TrialSetupLinkUpdateManyArgs;
}
