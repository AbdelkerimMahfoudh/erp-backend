/**
 * The permission catalogue and role matrix, re-exported.
 *
 * The definition moved to `src/rbac/role-permissions.ts` so the SERVER can
 * reach it: `tsconfig.build.json` excludes `prisma/seed-data` from the
 * production build, so anything defined here is invisible to runtime code —
 * which is why self-service registration could create roles and no permissions.
 *
 * This file stays as the seed's entry point so nothing that already imports it
 * has to change, and so there is still exactly ONE definition behind both.
 * Never redeclare the matrix here.
 */
export {
  PERMISSIONS,
  ALL_PERMISSION_KEYS,
  ROLE_PERMISSIONS,
  STORE_FACING_ROLES,
  ROLE_LABELS,
  type RoleKey,
} from '../../src/rbac/role-permissions';

export { DEFAULT_SETTINGS } from './company-defaults';
