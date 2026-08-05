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
