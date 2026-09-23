/**
 * Permission scope — the branch-safety boundary for authorization.
 *
 * A **company** permission applies across the whole company. A **branch-scoped**
 * permission applies only within a specific branch (it acts on that branch's
 * inventory, sales, cash, pricing or cost visibility). Branch-scoped permissions
 * MUST NOT be granted through the no-branch (cross-branch union) resolution path,
 * or authority granted for one branch would silently apply in every branch.
 *
 * **Fail-closed:** any permission NOT listed here is treated as branch-scoped, so
 * a new permission — or a per-branch delegated grant (F1 Stage 2, e.g.
 * `price.edit`) — can never leak company-wide by default. To make a permission
 * usable without a branch context you must add it here deliberately.
 *
 * Classification is a product decision; revisit it if a permission's scope
 * changes. Conservative today: only the clearly company-wide, resource-management
 * permissions are company-scoped. Everything operational (sales, units, imports,
 * purchases, discounts, closing, cost view, pricing) is branch-scoped.
 */
export const COMPANY_PERMISSIONS: ReadonlySet<string> = new Set<string>([
  'user.manage',
  'settings.manage',
  'branch.manage',
  'integrations.manage',
  'supplier.manage',
]);

/** True if the permission may be resolved without a branch context. */
export function isCompanyPermission(key: string): boolean {
  return COMPANY_PERMISSIONS.has(key);
}

/**
 * Permissions an Owner may delegate per branch (F1 Stage 2). Deliberately tiny.
 *
 * `discount.override` (the below-cost gate), `user.manage` and `settings.manage`
 * are NEVER delegatable, and neither is anything not listed here — the grant API
 * rejects any key outside this set, and resolution honours only these, so a
 * malicious or stale grant of another permission can never take effect.
 */
export const DELEGATABLE_PERMISSIONS: ReadonlySet<string> = new Set<string>(['price.edit', 'closing.perform']);

export function isDelegatable(key: string): boolean {
  return DELEGATABLE_PERMISSIONS.has(key);
}

/**
 * Which assignments may receive — and keep — each delegated key (0076).
 *
 * `price.edit` stays a Store Manager's. `closing.perform` is the Owner's two
 * named closers per branch, who may be a manager or an employee: the person
 * holding the drawer at 22:00 is usually the employee. Resolution honours a
 * grant only while the assignment's role is eligible for that key, so a role
 * change neutralises what it should and leaves the rest.
 */
export const DELEGATION_ELIGIBLE_ROLES: Readonly<Record<string, readonly string[]>> = {
  'price.edit': ['store_manager'],
  'closing.perform': ['store_manager', 'store_employee'],
};

export function mayHoldDelegated(key: string, roleKey: string): boolean {
  return (DELEGATION_ELIGIBLE_ROLES[key] ?? []).includes(roleKey);
}

/** The delegated keys a role may keep after a role change. */
export function delegatedKeysKeptBy(roleKey: string): string[] {
  return [...DELEGATABLE_PERMISSIONS].filter((k) => mayHoldDelegated(k, roleKey));
}

/**
 * The role a per-branch delegated grant may attach to and be effective for.
 * Delegation is a manager-only feature this phase ("delegate to a particular
 * Store Manager"), so a grant is honoured only while the assignment's role is
 * this one. Downgrading a manager to employee therefore neutralizes the grant
 * automatically, without waiting on any role-change endpoint to clean it up.
 *
 * This is the single, deliberate place delegation references a role — general
 * endpoint authorization stays permission-based and never compares a role name.
 */
export const DELEGATION_ELIGIBLE_ROLE = 'store_manager';
