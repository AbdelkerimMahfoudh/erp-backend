import { ClsStore } from 'nestjs-cls';

/**
 * Per-request context carried through AsyncLocalStorage (nestjs-cls).
 *
 * - `requestId` is set for every request (correlation id).
 * - `userId` / `companyId` / `branchId` / `permissions` are populated by the
 *   auth + isolation guards (Phase 2/3). Until then they are undefined.
 * - `companyId` / `branchId` are BINARY(16) `Buffer`s (DB-native), so the tenant
 *   Prisma extension can inject them directly into queries.
 *
 * The tenant Prisma extension reads `companyId` here and FAILS CLOSED: a
 * tenant-scoped query with no `companyId` throws instead of running unscoped.
 */
export interface AppClsStore extends ClsStore {
  requestId: string;
  userId?: string;
  companyId?: Buffer;
  branchId?: Buffer;
  permissions?: ReadonlySet<string>;
}

export const CLS_KEY = {
  REQUEST_ID: 'requestId',
  USER_ID: 'userId',
  COMPANY_ID: 'companyId',
  BRANCH_ID: 'branchId',
  PERMISSIONS: 'permissions',
} as const;
