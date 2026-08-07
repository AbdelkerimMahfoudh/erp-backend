import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PricingService } from './pricing.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';

/**
 * The pricing contract.
 *
 * The double below behaves like the database rather than like a mock: it
 * enforces company scoping, the two unique keys, and compare-and-swap on
 * `version`, and `$transaction` really does roll back on failure. A service that
 * wrote history outside the transaction, or overwrote a concurrent edit, fails
 * here instead of in a shop.
 *
 * What is deliberately NOT proven here — the append-only triggers, real unique
 * indexes and genuine concurrent writers — is proven against real MySQL in the
 * CP3 live verification, because a double can only ever agree with itself.
 */

const COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c001');
const OTHER_COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c002');
const BRANCH_A = uuidToBin('018f0000-0000-7000-8000-0000000b0001');
const BRANCH_B = uuidToBin('018f0000-0000-7000-8000-0000000b0002');
const OWNER = uuidToBin('018f0000-0000-7000-8000-00000000a001');
const MANAGER = uuidToBin('018f0000-0000-7000-8000-00000000a002');
const OWNER_2 = uuidToBin('018f0000-0000-7000-8000-00000000a003');

interface Row {
  id: Buffer;
  companyId: Buffer;
  [k: string]: unknown;
}

/** Everything the service touches, as plain arrays. */
interface Db {
  product: Row[];
  unit: Row[];
  stockItem: Row[];
  branchVariantPrice: Row[];
  unitPriceOverride: Row[];
  priceChangeEvent: Row[];
  notification: Row[];
  auditLog: Row[];
  userBranch: Row[];
  user: Row[];
}

const eq = (a: unknown, b: unknown): boolean =>
  Buffer.isBuffer(a) && Buffer.isBuffer(b) ? a.equals(b) : a === b;

/** Match a Prisma-ish `where` against a row, supporting the operators we use. */
function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(cond as Record<string, unknown>[]).some((c) => matches(row, c))) return false;
      continue;
    }
    if (key === 'role') {
      if (!eq((row.roleKey as string) ?? null, (cond as { key: string }).key)) return false;
      continue;
    }
    if (key === 'user') {
      const u = (cond as { isActive?: boolean; deletedAt?: null }) ?? {};
      const user = row.user as { isActive: boolean; deletedAt: Date | null } | undefined;
      if (u.isActive !== undefined && user?.isActive !== u.isActive) return false;
      if ('deletedAt' in u && user?.deletedAt !== null) return false;
      continue;
    }
    const value = row[key];
    if (cond !== null && typeof cond === 'object' && !Buffer.isBuffer(cond) && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ('not' in c && eq(value, c.not)) return false;
      if ('gt' in c && !(Number(value) > Number(c.gt))) return false;
      if ('in' in c && !(c.in as unknown[]).some((v) => eq(value, v))) return false;
      continue;
    }
    if (!eq(value, cond)) return false;
  }
  return true;
}

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

/** Unique keys the real schema enforces — the double enforces them too. */
const UNIQUE: Partial<Record<keyof Db, (r: Row) => string>> = {
  branchVariantPrice: (r) =>
    `${(r.productId as Buffer).toString('hex')}:${(r.branchId as Buffer).toString('hex')}`,
  unitPriceOverride: (r) => (r.unitId as Buffer).toString('hex'),
};

function makeClient(db: Db, companyId: Buffer) {
  const model = (name: keyof Db) => {
    const table = () => db[name];
    // Company scoping, exactly like the tenant extension: nothing else is visible.
    const scoped = () => table().filter((r) => r.companyId.equals(companyId));
    return {
      findFirst: async ({ where, select }: { where?: Record<string, unknown>; select?: unknown }) => {
        const hit = scoped().find((r) => matches(r, where)) ?? null;
        return hit && select ? project(hit, select as Record<string, unknown>, db) : hit;
      },
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) =>
        scoped().filter((r) => matches(r, where)),
      count: async ({ where }: { where?: Record<string, unknown> } = {}) =>
        scoped().filter((r) => matches(r, where)).length,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, companyId: (data.companyId as Buffer) ?? companyId } as Row;
        const key = UNIQUE[name];
        if (key && table().some((r) => r.companyId.equals(row.companyId) && key(r) === key(row))) {
          throw uniqueViolation();
        }
        if (row.version === undefined) row.version = 0;
        table().push(row);
        return row;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hits = scoped().filter((r) => matches(r, where));
        for (const r of hits) {
          for (const [k, v] of Object.entries(data)) {
            r[k] =
              v !== null && typeof v === 'object' && 'increment' in (v as object)
                ? Number(r[k]) + Number((v as { increment: number }).increment)
                : v;
          }
        }
        return { count: hits.length };
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const hits = scoped().filter((r) => matches(r, where));
        db[name] = table().filter((r) => !hits.includes(r));
        return { count: hits.length };
      },
    };
  };

  const client = {
    product: model('product'),
    unit: model('unit'),
    stockItem: model('stockItem'),
    branchVariantPrice: model('branchVariantPrice'),
    unitPriceOverride: model('unitPriceOverride'),
    priceChangeEvent: model('priceChangeEvent'),
    notification: model('notification'),
    auditLog: model('auditLog'),
    userBranch: model('userBranch'),
    user: model('user'),
  };

  return {
    ...client,
    // Real rollback: a failure anywhere undoes everything, so a price cannot
    // survive a failed history or notification write.
    $transaction: async <T>(fn: (tx: typeof client) => Promise<T>): Promise<T> => {
      const snapshot = JSON.parse(JSON.stringify(db, bufReplacer)) as unknown;
      try {
        return await fn(client);
      } catch (e) {
        const restored = JSON.parse(JSON.stringify(snapshot), bufReviver) as Db;
        for (const k of Object.keys(db) as (keyof Db)[]) db[k] = restored[k];
        throw e;
      }
    },
  };
}

function bufReplacer(_k: string, v: unknown) {
  return Buffer.isBuffer(v) ? { __buf: v.toString('hex') } : v;
}
function bufReviver(_k: string, v: unknown) {
  const o = v as { __buf?: string };
  return o && typeof o === 'object' && typeof o.__buf === 'string' ? Buffer.from(o.__buf, 'hex') : v;
}

/** Resolve the handful of relation selects the service asks for. */
function project(row: Row, select: Record<string, unknown>, db: Db): Row {
  const out: Row = { ...row };
  if (select.product) {
    out.product = db.product.find((p) => (p.id as Buffer).equals(row.productId as Buffer)) ?? null;
  }
  if (select.actor) {
    out.actor = db.user.find((u) => (u.id as Buffer).equals(row.actorId as Buffer)) ?? null;
  }
  return out;
}

// ─────────────────────────── fixture ───────────────────────────

const PHONE = newUuidV7Bin();
const ACCESSORY = newUuidV7Bin();
const UNIT_A = newUuidV7Bin();
const UNIT_A2 = newUuidV7Bin();

function seed(): Db {
  return {
    product: [
      { id: PHONE, companyId: COMPANY, trackingType: 'imei', defaultPrice: 18000, brand: 'Apple', model: '13 Pro', variant: '256GB' },
      { id: ACCESSORY, companyId: COMPANY, trackingType: 'quantity', defaultPrice: 45, brand: 'Anker', model: 'Cable', variant: null },
    ],
    unit: [
      { id: UNIT_A, companyId: COMPANY, productId: PHONE, branchId: BRANCH_A, cost: 16000, status: 'in_stock', imeiPrimary: '111111111111111', serialNo: null },
      { id: UNIT_A2, companyId: COMPANY, productId: PHONE, branchId: BRANCH_A, cost: 16500, status: 'in_stock', imeiPrimary: '222222222222222', serialNo: null },
    ],
    stockItem: [
      { id: newUuidV7Bin(), companyId: COMPANY, productId: ACCESSORY, branchId: BRANCH_A, price: 60, cost: 30, quantity: 10, version: 0 },
    ],
    branchVariantPrice: [],
    unitPriceOverride: [],
    priceChangeEvent: [],
    notification: [],
    auditLog: [],
    userBranch: [
      { id: newUuidV7Bin(), companyId: COMPANY, userId: OWNER, branchId: BRANCH_A, roleKey: 'owner', user: { isActive: true, deletedAt: null } },
      // The same Owner also owns branch B — one person, two assignments.
      { id: newUuidV7Bin(), companyId: COMPANY, userId: OWNER, branchId: BRANCH_B, roleKey: 'owner', user: { isActive: true, deletedAt: null } },
      { id: newUuidV7Bin(), companyId: COMPANY, userId: OWNER_2, branchId: BRANCH_A, roleKey: 'owner', user: { isActive: true, deletedAt: null } },
      { id: newUuidV7Bin(), companyId: COMPANY, userId: MANAGER, branchId: BRANCH_A, roleKey: 'store_manager', user: { isActive: true, deletedAt: null } },
    ],
    user: [
      { id: OWNER, companyId: COMPANY, name: 'Owner', isActive: true, deletedAt: null },
      { id: MANAGER, companyId: COMPANY, name: 'Amina', isActive: true, deletedAt: null },
      { id: OWNER_2, companyId: COMPANY, name: 'Second Owner', isActive: true, deletedAt: null },
    ],
  };
}

function makeService(opts: {
  db?: Db;
  actor?: Buffer;
  branchId?: Buffer | undefined;
  permissions?: string[];
  companyId?: Buffer;
}) {
  const db = opts.db ?? seed();
  const companyId = opts.companyId ?? COMPANY;
  const branchId = 'branchId' in opts ? opts.branchId : BRANCH_A;
  const actor = opts.actor ?? MANAGER;
  const permissions = new Set(opts.permissions ?? ['price.edit']);

  const client = makeClient(db, companyId);
  const tenant = {
    companyId: () => companyId,
    branchId: () => branchId,
    requireBranchId: () => {
      if (!branchId) throw new BadRequestException('X-Branch-Id header is required for this operation');
      return branchId;
    },
    userId: () => actor,
    requireUserId: () => actor,
  };
  const audit = {
    recordTx: async (tx: { auditLog: { create: (a: unknown) => Promise<unknown> } }, p: Record<string, unknown>) => {
      await tx.auditLog.create({ data: { id: newUuidV7Bin(), companyId, ...p } });
    },
  };
  const cls = { get: (k: string) => (k === 'permissions' ? permissions : undefined) };

  const service = new PricingService(
    client as never,
    tenant as never,
    audit as never,
    cls as never,
  );
  return { service, db };
}

// ─────────────────────────── tests ───────────────────────────

describe('reading a price', () => {
  it('reports the company default when the branch has set nothing', async () => {
    const { service } = makeService({});
    await expect(service.getProductPricing(binToUuid(PHONE))).resolves.toMatchObject({
      price: 18000,
      source: 'product_default',
      canRemove: false,
    });
  });

  it('offers a fallback preview only when something can actually be removed', async () => {
    const { service } = makeService({});
    await service.setBranchVariantPrice(binToUuid(PHONE), { price: 17500 });
    const after = await service.getProductPricing(binToUuid(PHONE));
    expect(after).toMatchObject({ price: 17500, source: 'branch_variant', canRemove: true });
    // What the manager would be left with if they removed it.
    expect(after.fallback).toEqual({ price: 18000, source: 'product_default' });
  });

  it('quantity stock reads its own branch price, not a pricing row', async () => {
    const { service, db } = makeService({});
    await expect(service.getProductPricing(binToUuid(ACCESSORY))).resolves.toMatchObject({
      price: 60,
      source: 'stock_item',
    });
    expect(db.branchVariantPrice).toHaveLength(0);
  });

  it('404s for a product belonging to another company', async () => {
    // The id is real, but not ours — it must not resolve, and must not confirm
    // that it exists elsewhere.
    const db = seed();
    db.product.push({ id: newUuidV7Bin(), companyId: OTHER_COMPANY, trackingType: 'imei', defaultPrice: 1 });
    const foreign = binToUuid(db.product[db.product.length - 1]!.id);
    const { service } = makeService({ db });
    await expect(service.getProductPricing(foreign)).rejects.toThrow(NotFoundException);
  });

  it('404s for a unit belonging to another company', async () => {
    const db = seed();
    db.unit.push({
      id: newUuidV7Bin(), companyId: OTHER_COMPANY, productId: PHONE, branchId: BRANCH_A,
      cost: 1, status: 'in_stock', imeiPrimary: '999999999999999', serialNo: null,
    });
    const { service } = makeService({ db });
    await expect(service.getUnitPricing('999999999999999')).rejects.toThrow(NotFoundException);
  });
});

describe('branch isolation', () => {
  it('lets the same model carry different prices in different branches', async () => {
    const db = seed();
    await makeService({ db, branchId: BRANCH_A }).service.setBranchVariantPrice(binToUuid(PHONE), { price: 17500 });
    await makeService({ db, branchId: BRANCH_B }).service.setBranchVariantPrice(binToUuid(PHONE), { price: 19000 });

    await expect(
      makeService({ db, branchId: BRANCH_A }).service.getProductPricing(binToUuid(PHONE)),
    ).resolves.toMatchObject({ price: 17500 });
    await expect(
      makeService({ db, branchId: BRANCH_B }).service.getProductPricing(binToUuid(PHONE)),
    ).resolves.toMatchObject({ price: 19000 });
  });

  it('lets one phone differ from another of the same model', async () => {
    const db = seed();
    const { service } = makeService({ db });
    await service.setBranchVariantPrice(binToUuid(PHONE), { price: 17500 });
    await service.setUnitOverride('111111111111111', { price: 17000 });

    await expect(service.getUnitPricing('111111111111111')).resolves.toMatchObject({ price: 17000, source: 'unit_override' });
    await expect(service.getUnitPricing('222222222222222')).resolves.toMatchObject({ price: 17500, source: 'branch_variant' });
  });

  it('refuses to price a phone that is in another branch', async () => {
    const db = seed();
    db.unit[0]!.branchId = BRANCH_B;
    const { service } = makeService({ db, branchId: BRANCH_A });
    await expect(service.setUnitOverride('111111111111111', { price: 17000 })).rejects.toThrow(ForbiddenException);
  });

  it('requires a branch context at all — no-branch writes fail closed', async () => {
    const { service } = makeService({ branchId: undefined });
    await expect(service.setBranchVariantPrice(binToUuid(PHONE), { price: 1 })).rejects.toThrow(BadRequestException);
  });
});

describe('removal reveals what is underneath', () => {
  it('removing a unit price falls back to the branch price', async () => {
    const db = seed();
    const { service } = makeService({ db });
    await service.setBranchVariantPrice(binToUuid(PHONE), { price: 17500 });
    const set = await service.setUnitOverride('111111111111111', { price: 17000 });

    const after = await service.removeUnitOverride('111111111111111', { expectedVersion: set.version! });
    expect(after).toMatchObject({ price: 17500, source: 'branch_variant' });
    expect(db.unitPriceOverride).toHaveLength(0);
  });

  it('removing a branch price falls back to the company default', async () => {
    const db = seed();
    const { service } = makeService({ db });
    const set = await service.setBranchVariantPrice(binToUuid(PHONE), { price: 17500 });
    const after = await service.removeBranchVariantPrice(binToUuid(PHONE), { expectedVersion: set.version! });
    expect(after).toMatchObject({ price: 18000, source: 'product_default' });
  });

  it('records the removal instead of erasing the price from history', async () => {
    const db = seed();
    const { service } = makeService({ db });
    const set = await service.setBranchVariantPrice(binToUuid(PHONE), { price: 17500 });
    await service.removeBranchVariantPrice(binToUuid(PHONE), { expectedVersion: set.version! });

    const removal = db.priceChangeEvent.at(-1)!;
    expect(removal).toMatchObject({ previousPrice: 17500, newPrice: null, scope: 'branch_variant' });
  });

  it('404s when there is nothing to remove', async () => {
    const { service } = makeService({});
    await expect(service.removeUnitOverride('111111111111111', { expectedVersion: 0 })).rejects.toThrow(NotFoundException);
  });
});

describe('optimistic concurrency', () => {
  it('rejects an update carrying a stale version', async () => {
    const db = seed();
    const { service } = makeService({ db });
    await service.setBranchVariantPrice(binToUuid(PHONE), { price: 17500 });
    await service.setBranchVariantPrice(binToUuid(PHONE), { price: 17400, expectedVersion: 0 });

    // A second manager still holding version 0.
    await expect(
      service.setBranchVariantPrice(binToUuid(PHONE), { price: 17300, expectedVersion: 0 }),
    ).rejects.toThrow(ConflictException);
    expect(Number(db.branchVariantPrice[0]!.price)).toBe(17400);
  });

  it('rejects a stale removal', async () => {
    const db = seed();
    const { service } = makeService({ db });
    await service.setBranchVariantPrice(binToUuid(PHONE), { price: 17500 });
    await expect(
      service.removeBranchVariantPrice(binToUuid(PHONE), { expectedVersion: 7 }),
    ).rejects.toThrow(ConflictException);
    expect(db.branchVariantPrice).toHaveLength(1);
  });

  it('turns a lost create race into refresh-required, not a silent overwrite', async () => {
    const db = seed();
    const { service } = makeService({ db });
    await service.setBranchVariantPrice(binToUuid(PHONE), { price: 17500 });
    // Someone else created it first; this caller still thinks none exists.
    await expect(service.setBranchVariantPrice(binToUuid(PHONE), { price: 17300 })).rejects.toMatchObject({
      response: { code: 'refresh_required' },
    });
    expect(Number(db.branchVariantPrice[0]!.price)).toBe(17500);
  });

  it('requires the version once a price exists', async () => {
    const db = seed();
    const { service } = makeService({ db });
    await service.setUnitOverride('111111111111111', { price: 17000 });
    await expect(service.setUnitOverride('111111111111111', { price: 16900 })).rejects.toThrow(ConflictException);
  });

  it('quantity price rejects a stale version and leaves the price alone', async () => {
    const db = seed();
    const { service } = makeService({ db });
    await expect(
      service.setQuantityPrice(binToUuid(ACCESSORY), { price: 70, expectedVersion: 9 }),
    ).rejects.toThrow(ConflictException);
    expect(Number(db.stockItem[0]!.price)).toBe(60);
  });

  it('increments the version so the next stale write also fails', async () => {
    const db = seed();
    const { service } = makeService({ db });
    await service.setQuantityPrice(binToUuid(ACCESSORY), { price: 70, expectedVersion: 0 });
    expect(db.stockItem[0]!.version).toBe(1);
    await expect(
      service.setQuantityPrice(binToUuid(ACCESSORY), { price: 80, expectedVersion: 0 }),
    ).rejects.toThrow(ConflictException);
  });

  it('writes no history or notification for a rejected write', async () => {
    const db = seed();
    const { service } = makeService({ db });
    await service.setBranchVariantPrice(binToUuid(PHONE), { price: 17500 });
    const events = db.priceChangeEvent.length;
    const notes = db.notification.length;
    await expect(
      service.setBranchVariantPrice(binToUuid(PHONE), { price: 17300, expectedVersion: 99 }),
    ).rejects.toThrow(ConflictException);
    expect(db.priceChangeEvent).toHaveLength(events);
    expect(db.notification).toHaveLength(notes);
  });
});

describe('below cost', () => {
  it('refuses a manager pricing one phone below what it cost', async () => {
    const { service } = makeService({ permissions: ['price.edit'] });
    await expect(service.setUnitOverride('111111111111111', { price: 15000 })).rejects.toThrow(ForbiddenException);
  });

  it('lets an owner do it, but only with a reason', async () => {
    const db = seed();
    const { service } = makeService({ db, actor: OWNER, permissions: ['price.edit', 'discount.override'] });
    await expect(service.setUnitOverride('111111111111111', { price: 15000 })).rejects.toThrow(BadRequestException);

    await service.setUnitOverride('111111111111111', { price: 15000, reason: 'Display unit, screen scratched' });
    expect(db.priceChangeEvent.at(-1)).toMatchObject({ reason: 'Display unit, screen scratched' });
  });

  it('treats a blank reason as no reason', async () => {
    const { service } = makeService({ actor: OWNER, permissions: ['price.edit', 'discount.override'] });
    await expect(
      service.setUnitOverride('111111111111111', { price: 15000, reason: '   ' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses a branch price that would put any phone of that model below cost', async () => {
    // Two units at 16000 and 16500 — 16200 is below cost for exactly one.
    const { service } = makeService({ permissions: ['price.edit'] });
    await expect(service.setBranchVariantPrice(binToUuid(PHONE), { price: 16200 })).rejects.toThrow(ForbiddenException);
  });

  it('says how many items are affected without revealing any cost', async () => {
    const { service } = makeService({ permissions: ['price.edit'] });
    const err = await service.setBranchVariantPrice(binToUuid(PHONE), { price: 15000 }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as Error).message).toContain('2 item(s)');
    expect((err as Error).message).not.toMatch(/16000|16500/);
  });

  it('allows a branch price above every unit cost', async () => {
    const db = seed();
    const { service } = makeService({ db, permissions: ['price.edit'] });
    await service.setBranchVariantPrice(binToUuid(PHONE), { price: 16500 });
    expect(db.branchVariantPrice).toHaveLength(1);
  });

  it('allows any branch price when no stock is present yet', async () => {
    const db = seed();
    db.unit = [];
    const { service } = makeService({ db, permissions: ['price.edit'] });
    // Nothing can be sold below cost yet, and Sell re-checks the real unit cost
    // at the counter regardless.
    await service.setBranchVariantPrice(binToUuid(PHONE), { price: 1 });
    expect(db.branchVariantPrice).toHaveLength(1);
  });

  it('refuses a manager pricing quantity stock below its branch cost', async () => {
    const { service } = makeService({ permissions: ['price.edit'] });
    await expect(
      service.setQuantityPrice(binToUuid(ACCESSORY), { price: 20, expectedVersion: 0 }),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('history', () => {
  it('records both sides of a change, the actor and the scope', async () => {
    const db = seed();
    const { service } = makeService({ db });
    await service.setBranchVariantPrice(binToUuid(PHONE), { price: 17500 });
    await service.setBranchVariantPrice(binToUuid(PHONE), { price: 17400, expectedVersion: 0 });

    expect(db.priceChangeEvent[0]).toMatchObject({ previousPrice: null, newPrice: 17500, scope: 'branch_variant', initiator: 'user' });
    expect(db.priceChangeEvent[1]).toMatchObject({ previousPrice: 17500, newPrice: 17400 });
    expect((db.priceChangeEvent[1]!.actorId as Buffer).equals(MANAGER)).toBe(true);
  });

  it('records a quantity price change too', async () => {
    const db = seed();
    const { service } = makeService({ db, actor: OWNER, permissions: ['price.edit', 'discount.override'] });
    await service.setQuantityPrice(binToUuid(ACCESSORY), { price: 70, expectedVersion: 0 });
    expect(db.priceChangeEvent.at(-1)).toMatchObject({ scope: 'stock_item', previousPrice: 60, newPrice: 70 });
  });
});

describe('owner notifications', () => {
  it('notifies every active owner when a manager changes a price', async () => {
    const db = seed();
    const { service } = makeService({ db, actor: MANAGER });
    await service.setBranchVariantPrice(binToUuid(PHONE), { price: 17500 });

    expect(db.notification).toHaveLength(2);
    expect(db.notification[0]).toMatchObject({ type: 'price.changed' });
    const targets = db.notification.map((n) => (n.targetUserId as Buffer).toString('hex')).sort();
    expect(targets).toEqual([OWNER, OWNER_2].map((b) => b.toString('hex')).sort());
  });

  it('sends one notification to an owner who owns several branches', async () => {
    // OWNER is assigned to both A and B, so appears twice in user_branches.
    // Two owners, three assignments, two notifications.
    const db = seed();
    const { service } = makeService({ db, actor: MANAGER });
    await service.setBranchVariantPrice(binToUuid(PHONE), { price: 17500 });
    expect(db.notification).toHaveLength(2);
    const forOwner = db.notification.filter((n) => (n.targetUserId as Buffer).equals(OWNER));
    expect(forOwner).toHaveLength(1);
  });

  it('does not notify the owner about the owner’s own change', async () => {
    const db = seed();
    const { service } = makeService({ db, actor: OWNER, permissions: ['price.edit', 'discount.override'] });
    await service.setBranchVariantPrice(binToUuid(PHONE), { price: 17500 });
    // The other owner still hears about it; the actor never notifies themselves.
    expect(db.notification).toHaveLength(1);
    expect((db.notification[0]!.targetUserId as Buffer).equals(OWNER_2)).toBe(true);
    // Still audited and still in history, though.
    expect(db.priceChangeEvent).toHaveLength(1);
    expect(db.auditLog).toHaveLength(1);
  });

  it('skips deactivated and deleted owners', async () => {
    const db = seed();
    db.userBranch = db.userBranch.map((ub) =>
      (ub.roleKey as string) === 'owner'
        ? { ...ub, user: { isActive: (ub.userId as Buffer).equals(OWNER_2), deletedAt: null } }
        : ub,
    );
    const { service } = makeService({ db, actor: MANAGER });
    await service.setBranchVariantPrice(binToUuid(PHONE), { price: 17500 });
    // Only the still-active owner is reachable.
    expect(db.notification).toHaveLength(1);
    expect((db.notification[0]!.targetUserId as Buffer).equals(OWNER_2)).toBe(true);
  });

  it('never puts cost, margin or a below-cost threshold in the message', async () => {
    const db = seed();
    const { service } = makeService({ db, actor: MANAGER });
    await service.setBranchVariantPrice(binToUuid(PHONE), { price: 17500 });
    const text = JSON.stringify(db.notification[0]);
    expect(text).not.toMatch(/16000|16500|cost|margin/i);
    expect(text).toContain('17500');
  });

  it('notifies on removal as well as on change', async () => {
    const db = seed();
    const { service } = makeService({ db, actor: MANAGER });
    const set = await service.setBranchVariantPrice(binToUuid(PHONE), { price: 17500 });
    await service.removeBranchVariantPrice(binToUuid(PHONE), { expectedVersion: set.version! });
    expect(db.notification).toHaveLength(4); // two owners x (set, remove)
    expect(db.notification.at(-1)!.body).toContain('removed');
  });
});

describe('atomicity', () => {
  it('rolls the price back when history cannot be written', async () => {
    const db = seed();
    const { service } = makeService({ db });
    const original = db.priceChangeEvent;
    // Simulate the append-only table refusing the write.
    db.priceChangeEvent = original;
    const client = (service as unknown as { db: { priceChangeEvent: { create: unknown } } }).db;
    const realCreate = client.priceChangeEvent.create;
    client.priceChangeEvent.create = async () => {
      throw new Error('price_change_events is append-only for the application user');
    };

    await expect(service.setBranchVariantPrice(binToUuid(PHONE), { price: 17500 })).rejects.toThrow(/append-only/);
    expect(db.branchVariantPrice).toHaveLength(0);

    client.priceChangeEvent.create = realCreate as never;
  });

  it('rolls the price back when the owner notification cannot be written', async () => {
    const db = seed();
    const { service } = makeService({ db, actor: MANAGER });
    const client = (service as unknown as { db: { notification: { create: unknown } } }).db;
    client.notification.create = async () => {
      throw new Error('notification write failed');
    };

    await expect(service.setBranchVariantPrice(binToUuid(PHONE), { price: 17500 })).rejects.toThrow(/notification/);
    expect(db.branchVariantPrice).toHaveLength(0);
    expect(db.priceChangeEvent).toHaveLength(0);
  });
});

describe('transfer invalidation', () => {
  it('removes the override and records why, when a phone changes branch', async () => {
    const db = seed();
    const { service } = makeService({ db });
    await service.setUnitOverride('111111111111111', { price: 17000 });
    expect(db.unitPriceOverride).toHaveLength(1);

    const client = (service as unknown as { db: unknown }).db;
    const invalidated = await service.invalidateOnBranchMoveTx(client as never, [
      { unitId: UNIT_A, productId: PHONE, fromBranchId: BRANCH_A, toBranchId: BRANCH_B },
    ]);

    expect(invalidated).toBe(1);
    expect(db.unitPriceOverride).toHaveLength(0);
    expect(db.priceChangeEvent.at(-1)).toMatchObject({
      initiator: 'system',
      reason: 'branch_transfer',
      previousPrice: 17000,
      newPrice: null,
    });
  });

  it('does nothing when the branch did not actually change', async () => {
    const db = seed();
    const { service } = makeService({ db });
    await service.setUnitOverride('111111111111111', { price: 17000 });
    const client = (service as unknown as { db: unknown }).db;

    // A cancelled transfer writes the unit's branch back to where it already was.
    const invalidated = await service.invalidateOnBranchMoveTx(client as never, [
      { unitId: UNIT_A, productId: PHONE, fromBranchId: BRANCH_A, toBranchId: BRANCH_A },
    ]);
    expect(invalidated).toBe(0);
    expect(db.unitPriceOverride).toHaveLength(1);
  });

  it('leaves a phone with no override alone', async () => {
    const db = seed();
    const { service } = makeService({ db });
    const client = (service as unknown as { db: unknown }).db;
    await expect(
      service.invalidateOnBranchMoveTx(client as never, [
        { unitId: UNIT_A, productId: PHONE, fromBranchId: BRANCH_A, toBranchId: BRANCH_B },
      ]),
    ).resolves.toBe(0);
    expect(db.priceChangeEvent).toHaveLength(0);
  });
});
