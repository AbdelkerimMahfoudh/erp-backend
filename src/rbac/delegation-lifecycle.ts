import { DELEGATABLE_PERMISSIONS, delegatedKeysKeptBy } from './permission-scope';

/**
 * What must happen to delegated grants when an assignment's ROLE changes.
 *
 * The resolver already refuses to honour a grant on a non-manager assignment,
 * so a downgrade takes effect immediately and safely. That protection is not
 * enough on its own: the grant ROW survives the downgrade, so promoting the
 * same person back to Store Manager would silently restore an authority the
 * Owner granted under different circumstances and never re-approved.
 *
 * The rule is therefore: **a role change away from Store Manager deletes the
 * assignment's delegated grants.** Re-delegation is a fresh Owner decision.
 *
 * This lives on its own, away from any one caller, because today the only
 * role-change path is the `create-user` development utility and tomorrow it
 * will be a role-management API. Both must obey the same rule, and a rule
 * written twice is a rule that drifts.
 */

/** True when an assignment with this role may KEEP delegated grants. */
export function roleKeepsDelegatedGrants(roleKey: string): boolean {
  return delegatedKeysKeptBy(roleKey).length > 0;
}

/**
 * The minimum client shape needed to prune. Deliberately structural so it
 * accepts a transaction client, the tenant-scoped client, or the plain
 * `PrismaClient` a CLI uses — the rule should not care which.
 */
export interface GrantPruningClient {
  userBranchPermission: {
    deleteMany(args: {
      where: { userBranchId: Buffer; permission?: { key: { notIn: string[] } } };
    }): Promise<{ count: number }>;
  };
}

/**
 * Drop every delegated grant on an assignment whose role can no longer hold
 * them. Returns how many were removed, so the caller can audit it.
 *
 * Safe to call unconditionally: for a role that keeps grants it does nothing,
 * and for one that does not it is idempotent.
 *
 * **Call it inside the same transaction as the role change.** A role change
 * that commits without the prune leaves exactly the stale grant this exists to
 * prevent.
 */
export async function pruneGrantsForRole(
  client: GrantPruningClient,
  userBranchId: Buffer,
  newRoleKey: string,
): Promise<number> {
  // 0076: a role keeps the delegated keys it may hold and loses the rest — a
  // manager made employee keeps a closing grant and loses price editing.
  const kept = delegatedKeysKeptBy(newRoleKey);
  if (kept.length === DELEGATABLE_PERMISSIONS.size) return 0;
  const { count } = await client.userBranchPermission.deleteMany({
    where: { userBranchId, ...(kept.length > 0 ? { permission: { key: { notIn: kept } } } : {}) },
  });
  return count;
}
