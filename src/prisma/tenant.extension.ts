import { ClsService } from 'nestjs-cls';
import { PrismaClient } from '@prisma/client';
import { AppClsStore } from '../common/context/request-context';

/**
 * Thrown when a tenant-scoped model is queried with no company context.
 * This is the FAIL-CLOSED guarantee: a tenant query is NEVER executed unscoped.
 * It indicates a programming error (a query issued outside a request/guard), so
 * the exception filter maps it to 500 and logs it loudly.
 */
export class MissingTenantContextError extends Error {
  constructor(
    readonly model: string,
    readonly operation: string,
  ) {
    super(
      `Tenant-scoped operation '${operation}' on model '${model}' was executed ` +
        `without a company context. Refusing to run an unscoped query (fail-closed).`,
    );
    this.name = 'MissingTenantContextError';
  }
}

/**
 * Models WITHOUT a `company_id` — global reference data. Everything else is
 * treated as tenant-scoped (fail-closed: unknown/new models are scoped by
 * default, so forgetting to list a new tenant model can never leak data).
 */
const GLOBAL_MODELS: ReadonlySet<string> = new Set(['Permission', 'TacCatalog']);

/** Operations whose `args.where` we scope with `companyId`. */
export const WHERE_OPERATIONS: ReadonlySet<string> = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
]);

/**
 * Pure scoping logic (unit-testable without a DB). Mutates + returns `args` with
 * `companyId` injected for tenant models, throws {@link MissingTenantContextError}
 * when the company context is missing, and passes global models through untouched.
 */
export function scopeTenantArgs<T extends Record<string, unknown>>(
  model: string,
  operation: string,
  args: T,
  companyId: Buffer | undefined,
): T {
  if (GLOBAL_MODELS.has(model)) {
    return args;
  }
  if (!companyId) {
    throw new MissingTenantContextError(model, operation);
  }

  const a = args as Record<string, unknown>;
  if (operation === 'create') {
    a.data = { ...(a.data as object), companyId };
  } else if (operation === 'createMany') {
    a.data = Array.isArray(a.data)
      ? a.data.map((row: Record<string, unknown>) => ({ ...row, companyId }))
      : { ...(a.data as object), companyId };
  } else if (operation === 'upsert') {
    a.where = { ...((a.where as object) ?? {}), companyId };
    a.create = { ...(a.create as object), companyId };
  } else if (WHERE_OPERATIONS.has(operation)) {
    a.where = { ...((a.where as object) ?? {}), companyId };
  }
  return args;
}

/**
 * Build the tenant-scoped Prisma client from a base client + the request CLS.
 *
 * For every tenant model it injects `companyId` (BINARY(16) Buffer from context):
 *   - reads/updates/deletes → merged into `where` (relies on Prisma's GA
 *     `extendedWhereUnique`, so it works for `findUnique`/`update`/`delete` too);
 *   - `create` → merged into `data`;
 *   - `createMany` → merged into every row;
 *   - `upsert` → merged into `where` and `create`.
 *
 * If `companyId` is absent it THROWS (fail-closed). Global models pass through.
 */
export function createTenantPrisma(base: PrismaClient, cls: ClsService<AppClsStore>) {
  return base.$extends({
    name: 'tenant-isolation',
    query: {
      $allModels: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async $allOperations({ model, operation, args, query }: any) {
          const scoped = scopeTenantArgs(model, operation, args ?? {}, cls.get('companyId'));
          return query(scoped);
        },
      },
    },
  });
}

/** The tenant-scoped client type (what feature services inject via TENANT_PRISMA). */
export type TenantPrisma = ReturnType<typeof createTenantPrisma>;
