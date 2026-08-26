import type { Prisma, PrismaClient } from '@prisma/client';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import {
  ALL_PERMISSION_KEYS,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  STORE_FACING_ROLES,
  type RoleKey,
} from './role-permissions';

/**
 * Giving a new company its default roles — and the permissions that make them
 * mean anything.
 *
 * **The one place this happens.** Registration, the seed and the historical
 * repair all call in here, because the defect this exists to fix was exactly a
 * second provisioning path that created roles and forgot the permissions:
 * `RegistrationService` wrote three `roles` rows with a key and a name and no
 * `role_permissions` at all, while `AccessService` resolves authority *only*
 * from `role_permissions`. Every shop that signed up through the website got an
 * Owner who could log in and do nothing.
 *
 * A hand-maintained copy of the matrix in a second file is what caused that, so
 * there is no copy here either — only {@link ROLE_PERMISSIONS}. A drift test
 * fails the build if another one appears.
 */

/**
 * A client that may be the real one or a transaction handle.
 *
 * Registration provisions inside the transaction that creates the company, so
 * a failure anywhere rolls the whole tenant back rather than leaving a
 * half-built shop behind.
 */
export type ProvisioningClient = PrismaClient | Prisma.TransactionClient;

/**
 * The roles every new tenant gets.
 *
 * Exactly the store-facing three. `administrator` is an internal SaaS role and
 * is deliberately absent — and in any case a tenant role can never grant
 * platform authority, which lives in the separate `platform_admins` table and
 * is reached through a different guard.
 */
export const DEFAULT_TENANT_ROLE_KEYS: readonly RoleKey[] = STORE_FACING_ROLES;

export interface ProvisionResult {
  /** The role row ids, by key, whether they were just created or already there. */
  roleIds: Record<RoleKey, Buffer>;
  /** How many `role_permissions` rows this call actually inserted. */
  mappingsCreated: number;
}

/**
 * Refuse anything not in the canonical matrix.
 *
 * Belt and braces: the keys come from a constant in this repository, not from a
 * request, and nothing reaching here is caller-supplied. The check exists so
 * that if somebody ever wires a role key in from outside, it fails loudly here
 * instead of silently provisioning a role nobody defined.
 */
function assertCanonical(roleKeys: readonly RoleKey[]): void {
  const catalogue = new Set(ALL_PERMISSION_KEYS);

  for (const roleKey of roleKeys) {
    const permissions = ROLE_PERMISSIONS[roleKey];
    if (!permissions) {
      throw new Error(`Unknown role key "${roleKey}". Refusing to provision.`);
    }
    for (const permissionKey of permissions) {
      if (!catalogue.has(permissionKey)) {
        throw new Error(
          `Role "${roleKey}" references unknown permission "${permissionKey}". Refusing to provision.`,
        );
      }
    }
  }
}

/**
 * Create the default roles for a company and grant each its canonical
 * permissions.
 *
 * Idempotent by construction, at the database rather than by checking first:
 * `roles` is unique on `(company_id, key)` and `role_permissions` is keyed on
 * `(role_id, permission_id)`, so a replay — including two concurrent replays of
 * the same idempotent registration — inserts nothing the second time instead of
 * racing between a read and a write.
 *
 * Company-scoped throughout. Every row written carries this `companyId`, and
 * the roles are looked up by `(companyId, key)`, so one tenant's provisioning
 * can never touch another's.
 */
export async function provisionDefaultRoles(
  tx: ProvisioningClient,
  companyId: Buffer,
  roleKeys: readonly RoleKey[] = DEFAULT_TENANT_ROLE_KEYS,
): Promise<ProvisionResult> {
  assertCanonical(roleKeys);

  // The catalogue, once. Permission ids are global — the rows are reference
  // data shared by every tenant — while the MAPPINGS are per company.
  const catalogue = await tx.permission.findMany({ select: { id: true, key: true } });
  const permissionIdByKey = new Map(catalogue.map((p) => [p.key, p.id]));

  const roleIds = {} as Record<RoleKey, Buffer>;
  const mappings: { companyId: Buffer; roleId: Buffer; permissionId: Buffer }[] = [];

  for (const roleKey of roleKeys) {
    /*
     * `upsert` rather than `create`, so a replay finds the existing role
     * instead of colliding on the unique key. `update: {}` deliberately leaves
     * a renamed role alone — a shop that renamed "Owner" keeps its name.
     */
    const role = await tx.role.upsert({
      where: { companyId_key: { companyId, key: roleKey } },
      update: {},
      create: {
        id: newUuidV7Bin(),
        companyId,
        key: roleKey,
        name: ROLE_LABELS[roleKey],
      },
      select: { id: true },
    });
    roleIds[roleKey] = role.id;

    for (const permissionKey of ROLE_PERMISSIONS[roleKey]) {
      const permissionId = permissionIdByKey.get(permissionKey);
      if (!permissionId) {
        // The catalogue row is missing from the database. Provisioning a role
        // with a silently smaller permission set is exactly the failure being
        // repaired, so refuse instead.
        throw new Error(
          `Permission "${permissionKey}" is not in the database catalogue. ` +
            'Refusing to provision a partial role.',
        );
      }
      mappings.push({ companyId, roleId: role.id, permissionId });
    }
  }

  const { count } = await tx.rolePermission.createMany({
    data: mappings,
    skipDuplicates: true,
  });

  return { roleIds, mappingsCreated: count };
}

/**
 * What the canonical matrix says a role should hold. For tests and for the
 * repair command's dry run, so neither has to restate the matrix.
 */
export function canonicalPermissionCount(roleKey: RoleKey): number {
  return ROLE_PERMISSIONS[roleKey].length;
}
