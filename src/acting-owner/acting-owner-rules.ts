import { ROLE_PERMISSIONS } from '../rbac/role-permissions';

/**
 * What a temporary Acting Owner may do (D225, 0112) — the capability matrix in code.
 *
 * Delegated: the Owner's permissions, so the business keeps running — approvals and below-cost sales, money and
 * expenses, returns, loans and consignments, stock adjustments and transfers, closing and reconciliation, staff
 * creation, activation, store assignment and Employee ↔ Manager, store settings, return policy and payment methods,
 * reports with buying costs and profit.
 *
 * Kept by the real Owner, whatever the delegate's permissions say:
 *  - `integrations.manage`: the business's private integration credentials (WhatsApp, push) — never delegated;
 *  - appointing, changing, extending or revoking an Acting Owner — the routes check the Owner ROLE, not a permission,
 *    so the delegate cannot extend their own appointment or appoint anyone else;
 *  - the real Owner's own record (name, contacts, password, role) — `assertMayManageTarget`;
 *  - closing the business, deleting accounts, the subscription and the Owner's portal sign-in — those check the Owner
 *    role directly (`account-deletion.service.ts`, `portal-session.service.ts`);
 *  - ownership transfer, the Owner's MFA and recovery codes, and audit records — no store route offers them at all.
 */
export const NEVER_DELEGATED: ReadonlySet<string> = new Set(['integrations.manage']);

export const ACTING_OWNER_PERMISSIONS: readonly string[] = ROLE_PERMISSIONS.owner.filter((k) => !NEVER_DELEGATED.has(k));

export interface DelegationWindow {
  startsAt: Date;
  endsAt: Date | null;
  revokedAt: Date | null;
}

/** In force at `now`: started, not ended, not revoked. Read on every request — no job switches it on or off. */
export function inForce(d: DelegationWindow, now: Date): boolean {
  return d.revokedAt === null && d.startsAt.getTime() <= now.getTime() && (d.endsAt === null || now.getTime() < d.endsAt.getTime());
}

/** Still running or still to come at `now`: what a new appointment must not overlap. */
export function liveOrScheduled(d: DelegationWindow, now: Date): boolean {
  return d.revokedAt === null && (d.endsAt === null || now.getTime() < d.endsAt.getTime());
}

/** Two windows share a moment. An open end runs forever. */
export function overlaps(a: { startsAt: Date; endsAt: Date | null }, b: { startsAt: Date; endsAt: Date | null }): boolean {
  const aEnd = a.endsAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bEnd = b.endsAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return a.startsAt.getTime() < bEnd && b.startsAt.getTime() < aEnd;
}
