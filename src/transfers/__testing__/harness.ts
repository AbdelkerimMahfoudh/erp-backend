import { TransfersService } from '../transfers.service';
import { TransferNotifier } from '../transfer-notifications';
import { TenantPrisma } from '../../prisma/tenant.extension';
import { newUuidV7Bin } from '../../common/utils/uuid.util';
import { COMPANY, Db, makeClient, SOURCE } from './transfer-db';

/**
 * The real `TransfersService`, wired to the database-like double.
 *
 * Everything replaced here is genuinely outside the transfer decision —
 * numbering, audit writing, price invalidation. The lifecycle, the authority
 * rules, the compare-and-swap and the notification recipients are the real
 * production code, which is the entire point: a test that reimplemented them
 * would prove only that the test agrees with itself.
 */
export interface Harness {
  service: TransfersService;
  db: Db;
  /** Change who is acting, and where, between calls — the mobile app does. */
  act(opts: { userId?: Buffer; branchId?: Buffer | undefined; permissions?: string[] }): void;
  audit: { entityType: string; action: string; reason?: string; after?: unknown }[];
  /** `stock.moved` events emitted after commit — the valuation-refresh signal. */
  moved: Record<string, unknown>[];
}

export function makeHarness(
  db: Db,
  initial: { userId: Buffer; branchId?: Buffer; permissions: string[]; companyId?: Buffer },
): Harness {
  const companyId = initial.companyId ?? COMPANY;
  let userId = initial.userId;
  let branchId: Buffer | undefined = initial.branchId ?? SOURCE;
  let permissions = new Set(initial.permissions);

  const client = makeClient(db, companyId);
  const audit: Harness['audit'] = [];

  const cls = {
    get: (key: string) => {
      if (key === 'companyId') return companyId;
      if (key === 'branchId') return branchId;
      if (key === 'userId') return userId;
      if (key === 'permissions') return permissions;
      return undefined;
    },
    set: () => undefined,
  };

  const tenant = {
    companyId: () => companyId,
    branchId: () => branchId,
    requireBranchId: () => {
      if (!branchId) throw new Error('X-Branch-Id header is required for this operation');
      return branchId;
    },
    userId: () => userId,
    requireUserId: () => userId,
  };

  /** Audit rows really are written, into the same transaction as everything else. */
  const auditService = {
    recordTx: async (tx: { auditLog: { create: (a: unknown) => Promise<unknown> } }, entry: Record<string, unknown>) => {
      audit.push(entry as Harness['audit'][number]);
      await tx.auditLog.create({
        data: { id: newUuidV7Bin(), companyId, ...entry },
      });
    },
  };

  let seq = 0;
  const invoiceNumbers = {
    next: async (_tx: unknown, _branch: Buffer, _kind: string, format: (n: number) => string) => {
      seq += 1;
      return format(seq);
    },
  };

  const pricing = { invalidateOnBranchMoveTx: async () => undefined };

  /**
   * Captures `stock.moved` so a test can assert that a shipment or receipt
   * asked for a valuation refresh — the thing that was missing entirely until
   * H1.4-CP5, and that no unit test noticed because nothing looked for it.
   */
  const moved: Record<string, unknown>[] = [];
  const events = { emit: (name: string, payload: Record<string, unknown>) => moved.push({ name, ...payload }) };

  const service = new TransfersService(
    client as unknown as TenantPrisma,
    tenant as never,
    auditService as never,
    invoiceNumbers as never,
    // The REAL notifier. Recipients, deduplication and the unique key are the
    // production code — a stub here would prove only that the stub was called.
    new TransferNotifier(),
    pricing as never,
    events as never,
    cls as never,
  );

  return {
    moved,
    service,
    db,
    audit,
    act(opts) {
      if (opts.userId !== undefined) userId = opts.userId;
      if ('branchId' in opts) branchId = opts.branchId;
      if (opts.permissions !== undefined) permissions = new Set(opts.permissions);
    },
  };
}
