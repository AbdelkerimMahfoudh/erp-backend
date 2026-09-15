import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Product, Unit, UnitStatus } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { TrackingStrategyRegistry } from '../tracking/tracking-strategy.registry';
import { TrackingStrategy } from '../tracking/tracking-strategy';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { assertTransition } from './unit-state-machine';
import {
  decodeCursor,
  encodeCursor,
  type CursorSection,
  type InventoryCursor,
} from './inventory-cursor';
import { unitIdentifier } from './unit-identifier.util';
import { receiveQuantityAtCost } from './stock-cost';
import { assertAssignedToBranch } from '../rbac/active-branch';
import { buildStockSummary, type StockSummaryRow } from './stock-summary';
import { referencedIds, shapeUnitTimeline } from './unit-timeline';
import { QuickAddUnitDto } from './dto/quick-add-unit.dto';
import { fingerprintReceipt } from './receipt-fingerprint';

/** What a counted-goods receipt reports back: no unit, just the new arrival. */
export interface QuantityReceiptResult {
  productId: string;
  quantity: number;
  tracking: 'quantity';
}

/**
 * What a scanned identifier already is, if anything.
 *
 * `elsewhere` is the deliberately empty answer: the identifier is taken by a
 * unit this caller may not see — another company's, or another branch's — so
 * intake must be refused and nothing else may be said about it.
 */
export interface IdentifierConflict {
  alreadyInInventory: boolean;
  matchedIdentifierPosition: 'primary' | 'secondary' | null;
  /** Safe summary, only for a unit this caller can actually reach. */
  unit: { productLabel: string; branchName: string; status: UnitStatus } | null;
  /** Taken, but outside this caller's reach. Carries nothing else. */
  elsewhere: boolean;
  /** Two identifiers matched two different units — never one phone. */
  conflictingUnits: boolean;
}

const NO_CONFLICT: IdentifierConflict = {
  alreadyInInventory: false,
  matchedIdentifierPosition: null,
  unit: null,
  elsewhere: false,
  conflictingUnits: false,
};

/** Transaction client shape needed to create a unit (+ its audit row). */
export type UnitTxClient = Pick<TenantPrisma, 'unit' | 'auditLog'>;

/**
 * Product fields every inventory row carries.
 *
 * `specifications` is included so the client can distinguish EXACT VARIANTS —
 * two rows reading "Apple iPhone 15" are not the same thing if one is 128GB
 * black and the other 256GB blue. Aggregated quantity rows especially need it,
 * since they have no identifier to tell them apart.
 */
const INVENTORY_PRODUCT_SELECT = {
  brand: true,
  model: true,
  variant: true,
  barcode: true,
  trackingType: true,
  specifications: true,
} as const;

const DEFAULT_PAGE_SIZE = 50;
/** Upper bound a client may request. Guards against a single huge query. */
const MAX_PAGE_SIZE = 200;

export interface InventoryFilter {
  status?: UnitStatus;
  productId?: string;
  /** Free text across product name, barcode and serialized identifiers. */
  search?: string;
  cursor?: string;
  limit?: number;
}

/** One model, and how many of it are on the shelf right now. */
export interface ModelStockRow {
  brand: string;
  model: string;
  trackingType: string;
  /** Every unit of this model in the branch, whatever its storage or colour. */
  inStock: number;
  /**
   * The product rows folded into this one line.
   *
   * More than one is normal, not a fault: `products.variant` carries storage
   * and colour and sits in the `(company, brand, model, variant)` unique key,
   * so a 256 GB black and a 512 GB blue are two products of one model. It is
   * also how a legacy duplicate shows itself, which is why the ids are
   * reported rather than hidden.
   */
  productIds: string[];
  /** Storage and colour, for the detail view. Never splits the headline. */
  variants: { variant: string | null; inStock: number }[];
}

export interface InventoryPage {
  rows: InventoryRow[];
  /** Opaque; pass back verbatim to fetch the next page. Null at the end. */
  nextCursor: string | null;
  hasMore: boolean;
  /**
   * Counts of everything matching the filter, not just this page — so the UI
   * can say "12 of 340" instead of implying the first page is the whole stock.
   */
  totals: { units: number; stock: number };
}

/**
 * The boundary is simply the last row of the page.
 *
 * `id` is a total order on its own, so one row identifies the position exactly
 * — no set of tied ids to carry, and the cursor stays a constant ~90 characters
 * regardless of how much stock exists. See `inventory-cursor.ts` for the
 * measurements that forced this design.
 */
function buildCursor(section: CursorSection, page: { id: Buffer }[]): InventoryCursor {
  return { section, id: binToUuid(page[page.length - 1].id) };
}

/**
 * Search must reach what an employee actually types: a product name, a barcode
 * off the box, or the last digits of an IMEI read off the device. Restricting
 * it to the rows already downloaded would quietly search a fraction of stock.
 */
function unitSearchClauses(q: string) {
  return [
    { imeiPrimary: { contains: q } },
    { imeiSecondary: { contains: q } },
    { serialNo: { contains: q } },
    { product: { brand: { contains: q } } },
    { product: { model: { contains: q } } },
    { product: { variant: { contains: q } } },
    { product: { barcode: { contains: q } } },
  ];
}

function stockSearchClauses(q: string) {
  return [
    { product: { brand: { contains: q } } },
    { product: { model: { contains: q } } },
    { product: { variant: { contains: q } } },
    { product: { barcode: { contains: q } } },
  ];
}

type UnitWithProduct = Unit & { product: InventoryProduct | null };
type StockWithProduct = {
  id: Buffer;
  productId: Buffer;
  quantity: number;
  reservedQuantity: number;
  cost: Prisma.Decimal;
  price: Prisma.Decimal | null;
  product: InventoryProduct | null;
};

function toUnitRow(unit: UnitWithProduct): InventoryUnitRow {
  return {
    kind: 'unit',
    id: unit.id,
    // The DB has a generated `identifier` column Prisma cannot model, so it is
    // derived here to keep one canonical lookup key for the client.
    identifier: unit.imeiPrimary ?? unit.serialNo ?? '',
    imeiPrimary: unit.imeiPrimary,
    imeiSecondary: unit.imeiSecondary,
    serialNo: unit.serialNo,
    status: unit.status,
    cost: unit.cost,
    dateIn: unit.dateIn,
    productId: unit.productId,
    product: unit.product,
  };
}

function toStockRow(line: StockWithProduct): InventoryStockRow {
  return {
    kind: 'stock',
    id: line.id,
    productId: line.productId,
    quantity: line.quantity,
    reservedQuantity: line.reservedQuantity,
    availableQuantity: line.quantity - line.reservedQuantity,
    cost: line.cost,
    price: line.price,
    product: line.product,
  };
}

export interface InventoryProduct {
  brand: string;
  model: string;
  variant: string | null;
  barcode: string | null;
  trackingType: Product['trackingType'];
  specifications: Prisma.JsonValue;
}

/** One serialized device: has an identifier and a lifecycle status. */
export interface InventoryUnitRow {
  kind: 'unit';
  id: Buffer;
  /** IMEI or serial — the canonical lookup key. */
  identifier: string;
  imeiPrimary: string | null;
  imeiSecondary: string | null;
  serialNo: string | null;
  status: UnitStatus;
  /** Stripped for callers without `cost.view`. */
  cost: Prisma.Decimal;
  dateIn: Date;
  productId: Buffer;
  product: InventoryProduct | null;
}

/** One product counted in bulk at this branch: has a quantity, no status. */
export interface InventoryStockRow {
  kind: 'stock';
  id: Buffer;
  productId: Buffer;
  /**
   * PHYSICAL stock owned at this branch. Deliberately unchanged by reservations
   * — the goods are still the company's, and inventory valuation counts them.
   */
  quantity: number;
  /** Promised to an open transfer and therefore not sellable (H1.1). */
  reservedQuantity: number;
  /**
   * What may actually be sold: `quantity - reservedQuantity`.
   *
   * Named separately rather than overwriting `quantity`, so a screen cannot
   * accidentally show "available" where it means "total owned" — the two
   * matter to different people, and conflating them is how a shop miscounts.
   */
  availableQuantity: number;
  /** Stripped for callers without `cost.view`. */
  cost: Prisma.Decimal;
  /**
   * `null` means **unpriced**, not free (`0034`).
   *
   * Stock delivered by a transfer into a branch that has never priced this
   * product arrives without one, because a selling price is a decision made in
   * one branch and must not travel with the goods.
   */
  price: Prisma.Decimal | null;
  product: InventoryProduct | null;
}

export type InventoryRow = InventoryUnitRow | InventoryStockRow;

export interface CreateUnitData {
  productId: Buffer;
  branchId: Buffer;
  imeiPrimary?: string | null;
  imeiSecondary?: string | null;
  serialNo?: string | null;
  cost: number;
  supplierId?: Buffer | null;
  purchaseId?: Buffer | null;
}

@Injectable()
export class InventoryService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly strategies: TrackingStrategyRegistry,
    /**
     * The UNSCOPED client, used for exactly one thing: counting whether an
     * identifier exists outside this company. It never selects a row.
     */
    private readonly system: PrismaService,
  ) {}

  /** Same-company identifier pre-check (the global unique index is the backstop). */
  async findExistingIdentifiers(identifiers: string[]): Promise<Set<string>> {
    if (identifiers.length === 0) return new Set();
    const found = await this.db.unit.findMany({
      where: {
        OR: [
          { imeiPrimary: { in: identifiers } },
          { imeiSecondary: { in: identifiers } },
          { serialNo: { in: identifiers } },
        ],
      },
      select: { imeiPrimary: true, imeiSecondary: true, serialNo: true },
    });
    const set = new Set<string>();
    for (const u of found) {
      if (u.imeiPrimary) set.add(u.imeiPrimary);
      if (u.imeiSecondary) set.add(u.imeiSecondary);
      if (u.serialNo) set.add(u.serialNo);
    }
    return set;
  }

  /**
   * Is this identifier already a phone we hold — and if not ours, is it taken?
   *
   * The authoritative answer to "can this be received", asked BEFORE anybody
   * types a cost. Until now the only answer came from the database trigger at
   * insert time, so a duplicate was discovered after the whole intake form had
   * been filled in.
   *
   * ## Two different questions, deliberately
   *
   * IMEI uniqueness in this database is **global** — migration 0042's trigger
   * queries `units` with no company filter, and the generated `identifier`
   * index is global too. The tenant client, meanwhile, is company-scoped. So a
   * phone belonging to another shop is invisible to a normal read and still
   * impossible to receive, which is the worst of both.
   *
   * This therefore asks twice:
   *
   *  1. **Scoped** — is it ours? Then the caller may see a safe summary: what
   *     the product is, which branch holds it, what state it is in.
   *  2. **Unscoped, count only** — is it anyone's? Then the caller learns
   *     nothing but `elsewhere: true`.
   *
   * The second query returns a NUMBER. Not a row, not an id, not a name — so
   * there is no shape for another company's data to travel in. That it reveals
   * "this IMEI exists somewhere" is not new: the insert trigger already says
   * exactly that, in words, a minute later. Saying it earlier costs the same
   * information and saves the typing.
   *
   * A unit in a branch this user is not assigned to is treated the same as
   * another company's: the duplicate is real, the details are not theirs.
   */
  async describeIdentifierConflict(identifiers: string[]): Promise<IdentifierConflict> {
    const wanted = identifiers.map((i) => i.trim()).filter(Boolean);
    if (wanted.length === 0) return NO_CONFLICT;

    // Same company: the authoritative columns, exactly as `findByIdentifier`
    // searches them — either IMEI finds the phone, and a serial does too.
    const ours = await this.db.unit.findMany({
      where: {
        OR: [
          { imeiPrimary: { in: wanted } },
          { imeiSecondary: { in: wanted } },
          { serialNo: { in: wanted } },
        ],
      },
      select: {
        id: true,
        status: true,
        imeiPrimary: true,
        imeiSecondary: true,
        branchId: true,
        branch: { select: { name: true } },
        product: { select: { brand: true, model: true, variant: true } },
      },
      take: 3,
    });

    /*
     * Two identifiers that resolve to two DIFFERENT units are not one phone.
     * Saying "already in inventory" and showing one of them would quietly pick
     * a winner, and the pair being scanned is then attached to whichever the
     * query happened to return first.
     */
    const distinct = new Set(ours.map((u) => u.id.toString('hex')));
    if (distinct.size > 1) {
      return { ...NO_CONFLICT, alreadyInInventory: true, conflictingUnits: true };
    }

    const match = ours[0];
    if (match) {
      const visible = await this.accessibleBranchIds();
      const inReach = visible.some((b) => b.equals(match.branchId));
      if (!inReach) {
        // Ours, but not this user's branch. Real duplicate, none of their business.
        return { ...NO_CONFLICT, alreadyInInventory: true, elsewhere: true };
      }
      return {
        alreadyInInventory: true,
        // Which column matched the FIRST identifier — the one that was scanned.
        matchedIdentifierPosition:
          match.imeiPrimary && wanted.includes(match.imeiPrimary)
            ? 'primary'
            : match.imeiSecondary && wanted.includes(match.imeiSecondary)
              ? 'secondary'
              : null,
        unit: {
          productLabel: [match.product.brand, match.product.model, match.product.variant]
            .filter(Boolean)
            .join(' '),
          branchName: match.branch.name,
          status: match.status,
        },
        elsewhere: false,
        conflictingUnits: false,
      };
    }

    /*
     * Not ours. Ask the unscoped client whether it exists at all — and ask for
     * a COUNT, so the answer cannot carry anything but a number.
     */
    const taken = await this.system.unit.count({
      where: {
        OR: [
          { imeiPrimary: { in: wanted } },
          { imeiSecondary: { in: wanted } },
          { serialNo: { in: wanted } },
        ],
      },
    });
    return taken > 0 ? { ...NO_CONFLICT, alreadyInInventory: true, elsewhere: true } : NO_CONFLICT;
  }

  /** Branches this user is actually assigned to — the visibility boundary. */
  private async accessibleBranchIds(): Promise<Buffer[]> {
    const userId = this.tenant.userId();
    if (!userId) return [];
    const rows = await this.db.userBranch.findMany({
      where: { userId },
      select: { branchId: true },
    });
    return rows.map((r) => r.branchId);
  }

  /**
   * Map a per-unit identifier onto the correct `units` column for the product's
   * tracking type — no branching on the type in callers.
   */
  identifierData(strategy: TrackingStrategy, identifier: string): Pick<CreateUnitData, 'imeiPrimary' | 'serialNo'> {
    if (strategy.identifierField === 'imeiPrimary') return { imeiPrimary: identifier };
    if (strategy.identifierField === 'serialNo') return { serialNo: identifier };
    return {};
  }

  /** Create one unit within a transaction (used by receiving + quick-add). */
  async createUnit(tx: UnitTxClient, data: CreateUnitData): Promise<Unit> {
    const unit = await tx.unit.create({
      data: {
        id: newUuidV7Bin(),
        companyId: this.tenant.companyId(),
        productId: data.productId,
        branchId: data.branchId,
        imeiPrimary: data.imeiPrimary ?? null,
        imeiSecondary: data.imeiSecondary ?? null,
        serialNo: data.serialNo ?? null,
        cost: data.cost,
        status: 'in_stock',
        supplierId: data.supplierId ?? null,
        purchaseId: data.purchaseId ?? null,
        createdById: this.tenant.userId() ?? null,
      },
    });
    await this.audit.recordTx(tx, {
      entityType: 'Unit',
      entityId: unit.id,
      action: 'create',
      after: { identifier: unitIdentifier(unit) },
      branchId: data.branchId,
    });
    return unit;
  }

  /**
   * Quick "Add Stock" — a single product, no supplier. The product's tracking
   * type drives the workflow: perUnit types create one unit from an identifier;
   * quantity types increment the branch StockItem.
   */
  async quickAdd(dto: QuickAddUnitDto): Promise<Unit | QuantityReceiptResult> {
    const branchId = this.tenant.requireBranchId();
    const product = await this.db.product.findUnique({ where: { id: uuidToBin(dto.productId) } });
    if (!product) throw new NotFoundException('Product not found');
    const strategy = this.strategies.get(product.trackingType);

    if (!strategy.perUnit) {
      /**
       * Counted goods, so per-unit identity is meaningless here. Sending one is
       * refused rather than dropped: these fields used to be silently ignored,
       * which meant a client that believed it was registering an IMEI got a
       * cheerful success and no IMEI anywhere. Refusing says which of the two
       * of us is wrong.
       */
      if (dto.identifier !== undefined || dto.imeiSecondary !== undefined) {
        throw new BadRequestException(
          'This product is counted by quantity, so it has no IMEI or serial number. Send a quantity instead.',
        );
      }
      const quantity = dto.quantity ?? 0;
      if (!Number.isInteger(quantity) || quantity < 1) {
        throw new BadRequestException('Receiving stock needs a whole quantity of at least one.');
      }
      return this.receiveQuantity(product, branchId, quantity, dto);
    }

    /**
     * Serialized goods arrive one at a time, each with its own identifier and
     * its own cost. A quantity above one has no meaning on this path and used
     * to be discarded — "receive 50" created a single phone and threw the other
     * 49 away, reporting success. It is now refused.
     */
    if (dto.quantity !== undefined && dto.quantity > 1) {
      throw new BadRequestException(
        `${strategy.identifierLabel} products are registered one at a time, each with its own identifier. Send them individually.`,
      );
    }

    if (!dto.identifier) throw new BadRequestException(`${strategy.identifierLabel} is required`);
    const check = strategy.validateIdentifier(dto.identifier);
    if (!check.ok) throw new BadRequestException(check.reason);
    const identifier = strategy.normalize(dto.identifier);

    const candidates = [identifier, ...(dto.imeiSecondary ? [dto.imeiSecondary] : [])];
    const existing = await this.findExistingIdentifiers(candidates);
    if (existing.size > 0) {
      throw new ConflictException(`Identifier already registered: ${[...existing].join(', ')}`);
    }

    try {
      return await this.db.$transaction((tx) =>
        this.createUnit(tx, {
          productId: product.id,
          branchId,
          ...this.identifierData(strategy, identifier),
          imeiSecondary: dto.imeiSecondary,
          cost: dto.cost,
        }),
      );
    } catch (e) {
      throw this.mapDuplicate(e);
    }
  }

  /**
   * Receive counted goods once, even if the request arrives twice.
   *
   * The balance in `stock_items` cannot tell a retry from a second delivery —
   * fifteen cables look like fifteen cables. So the receipt is written as an
   * event carrying the client's key, in the SAME transaction as the balance
   * change, and the unique index on `(company_id, client_uuid)` is what decides
   * the race. Two retries arriving together both find no prior receipt, both
   * insert, and exactly one survives; the loser is caught below and replays.
   *
   * Without a key the behaviour is exactly what it was before: a receipt is
   * recorded, stock moves, and a retry would move it again. That is the honest
   * outcome for a caller that did not ask for protection, and it keeps every
   * existing integration working.
   */
  private async receiveQuantity(
    product: Product,
    branchId: Buffer,
    quantity: number,
    dto: QuickAddUnitDto,
  ): Promise<QuantityReceiptResult> {
    const companyId = this.tenant.companyId();
    const price = dto.price ?? (product.defaultPrice === null ? null : Number(product.defaultPrice));
    const fingerprint = fingerprintReceipt({
      productId: binToUuid(product.id),
      branchId: branchId.toString('hex'),
      quantity,
      cost: dto.cost,
      price,
    });
    const clientUuid = dto.clientUuid ? uuidToBin(dto.clientUuid) : null;

    if (clientUuid) {
      const replay = await this.db.stockReceipt.findFirst({ where: { companyId, clientUuid } });
      if (replay) return this.replayOf(replay, fingerprint);
    }

    try {
      return await this.db.$transaction(async (tx) => {
        /*
         * Order matters. The receipt is inserted FIRST, so a duplicate key
         * aborts the transaction before the balance moves. Receiving first and
         * recording second would let the goods land and the guard fail after.
         */
        await tx.stockReceipt.create({
          data: {
            id: newUuidV7Bin(),
            companyId,
            branchId,
            productId: product.id,
            userId: this.tenant.userId() ?? null,
            clientUuid,
            clientRequestHash: clientUuid ? fingerprint : null,
            quantity,
            unitCost: dto.cost,
          },
        });
        // Unchanged rule, unchanged single statement (H1.4.1) — see stock-cost.ts.
        await receiveQuantityAtCost(tx, {
          companyId,
          productId: product.id,
          branchId,
          received: quantity,
          unitCost: dto.cost,
          priceIfNew: price,
        });
        return { productId: binToUuid(product.id), quantity, tracking: 'quantity' as const };
      });
    } catch (e) {
      /*
       * Lost the insert race against a simultaneous retry. The winner's receipt
       * is now committed, so this is the replay path, not an error.
       */
      if (clientUuid && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await this.db.stockReceipt.findFirst({ where: { companyId, clientUuid } });
        if (winner) return this.replayOf(winner, fingerprint);
      }
      throw e;
    }
  }

  /** Same key, same payload → the original answer. Same key, different payload → a conflict. */
  private replayOf(
    receipt: { productId: Buffer; quantity: number; clientRequestHash: string | null },
    fingerprint: string,
  ): QuantityReceiptResult {
    if (receipt.clientRequestHash !== fingerprint) {
      throw new ConflictException({
        code: 'idempotency_conflict',
        message: 'That request id was already used to receive different stock.',
      });
    }
    return { productId: binToUuid(receipt.productId), quantity: receipt.quantity, tracking: 'quantity' };
  }

  /**
   * Increment (or create) the branch quantity stock for a product, re-averaging
   * its cost (H1.4.1).
   *
   * This used to increment quantity and leave `cost` at whatever the first ever
   * receipt paid, so adding more of the same accessory at a different price
   * never changed the recorded cost. It now goes through the same single rule
   * as purchase receiving and transfer receipt — see `stock-cost.ts` for why
   * that has to be one statement rather than a read and a write.
   *
   * `price` is only consulted when the row does not exist yet; `null` leaves it
   * unpriced rather than free.
   */
  async upsertStock(
    productId: Buffer,
    branchId: Buffer,
    quantity: number,
    cost: number,
    price: number | null,
  ): Promise<void> {
    await receiveQuantityAtCost(this.db, {
      companyId: this.tenant.companyId(),
      productId,
      branchId,
      received: quantity,
      unitCost: cost,
      priceIfNew: price,
    });
  }

  /** Look up a unit by its identifier (IMEI or serial). */
  async findByIdentifier(identifier: string): Promise<Unit> {
    const unit = await this.db.unit.findFirst({
      // Either IMEI finds the phone. A dual-SIM unit stores both, so looking
      // up only the primary means the second identifier — printed on the same
      // box, scanned just as often — reports 'Unit not found'.
      where: {
        OR: [
          { imeiPrimary: identifier },
          { imeiSecondary: identifier },
          { serialNo: identifier },
        ],
      },
      include: {
        product: true,
        branch: { select: { id: true, name: true } },
        // The purchase reference and date only. First release: no supplier name
        // is sent: ordinary purchases are anonymous, and historical supplier
        // links stay in the database, dormant.
        purchase: { select: { referenceNo: true, date: true } },
      },
    });
    if (!unit) throw new NotFoundException('Unit not found');
    return unit;
  }

  /** Unit detail + audit-derived timeline (WF8). */
  async findByIdentifierWithTimeline(identifier: string) {
    const unit = await this.findByIdentifier(identifier);
    const timeline = await this.timeline(unit.id);
    return { ...unit, timeline };
  }

  /**
   * The unit's history as language-free facts — see `unit-timeline.ts`.
   *
   * The NEWEST 200 entries. This used to take the oldest 200 in ascending
   * order, so a busy phone's recent history was the part cut off.
   */
  private async timeline(unitId: Buffer) {
    const events = await this.db.auditLog.findMany({
      where: { entityId: unitId, entityType: { in: ['Unit', 'Return'] } },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: 200,
    });

    const { userIds, branchIds } = referencedIds(events);
    const [users, branches] = await Promise.all([
      userIds.length
        ? this.db.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true, userBranches: { select: { branchId: true, role: { select: { key: true } } } } },
          })
        : [],
      branchIds.length
        ? this.db.branch.findMany({ where: { id: { in: branchIds } }, select: { id: true, name: true } })
        : [],
    ]);

    return shapeUnitTimeline(events, {
      users: new Map(
        users.map((u) => [
          u.id.toString('hex'),
          { name: u.name, roles: new Map(u.userBranches.map((ub) => [ub.branchId.toString('hex'), ub.role.key as string])) },
        ]),
      ),
      branches: new Map(branches.map((br) => [br.id.toString('hex'), br.name])),
    });
  }

  /**
   * Everything physically in stock at the active branch.
   *
   * Returns a DISCRIMINATED union, because stock genuinely has two shapes and
   * flattening them would lie about one of them:
   *
   *   kind: 'unit'  — one serialized device. Has an identifier and a lifecycle
   *                   status. Phones, TVs, laptops.
   *   kind: 'stock' — one product counted in bulk at this branch. Has a
   *                   quantity and no status. Chargers, cables, adapters.
   *
   * Before this, the method returned `Unit[]` only, so quantity-tracked stock
   * was invisible to every caller — an electronics shop sells accessories
   * daily, and inventory that cannot show them is not inventory.
   *
   * `cost` on either shape is removed by the global cost-gating interceptor
   * for callers without `cost.view`; nothing extra is needed here.
   */
  /**
   * Stock counted the way a shopkeeper counts it: by model.
   *
   * A phone is one `Unit` with its own IMEI, and that never changes — it is how
   * a specific handset is found, sold and warranted. But nobody stands in a
   * shop and says "I have IMEI 01000004… and IMEI 01000012…"; they say "I have
   * four 17 Pro Max". Both are true, and the list has only ever shown the
   * first.
   *
   * Counted from the Unit rows themselves, server-side, every time. There is
   * deliberately no stored total and no client-side counter: a number that is
   * maintained rather than derived is a number that drifts the first time a
   * sale, a transfer or a refusal takes a path nobody remembered to update.
   *
   * Scoped to the company by the tenant client, and to the active branch — with
   * the same branch-assignment check `listStock` makes, for the same reason.
   */
  async countByModel(): Promise<ModelStockRow[]> {
    const branchId = this.tenant.branchId();
    if (branchId) {
      await assertAssignedToBranch(this.db, this.tenant.requireUserId(), branchId);
    }

    /*
     * `in_stock` and nothing else. A reserved, sold, faulty, in-transit or
     * consigned unit is not stock somebody can sell today, and the existing
     * status model already carries every one of those transitions — so a sale
     * moves the count without anything here being told about it.
     */
    const grouped = await this.db.unit.groupBy({
      by: ['productId'],
      where: { status: 'in_stock', ...(branchId ? { branchId } : {}) },
      _count: { _all: true },
    });

    if (grouped.length === 0) return [];

    const products = await this.db.product.findMany({
      where: { id: { in: grouped.map((g) => g.productId) } },
      select: { id: true, brand: true, model: true, variant: true, trackingType: true },
    });
    const byId = new Map(products.map((p) => [p.id.toString('hex'), p]));

    /*
     * Folded by brand and model, NOT by product id.
     *
     * Storage and colour live in `products.variant`, which is part of the
     * `(company, brand, model, variant)` unique key — so four 17 Pro Max in
     * four colours are four product rows. Grouping by product id would report
     * that as "1, 1, 1, 1", which is arithmetically true and useless: the
     * shopkeeper has four of that phone. The colours are still there, one level
     * down, for whoever needs to know which four.
     */
    const rows = new Map<string, ModelStockRow>();
    for (const g of grouped) {
      const product = byId.get(g.productId.toString('hex'));
      if (!product) continue; // deleted mid-read; the unit is counted next time
      const key = `${product.brand} ${product.model}`;
      const row = rows.get(key) ?? {
        brand: product.brand,
        model: product.model,
        trackingType: product.trackingType,
        inStock: 0,
        productIds: [],
        variants: [],
      };
      row.inStock += g._count._all;
      row.productIds.push(binToUuid(g.productId));
      row.variants.push({ variant: product.variant, inStock: g._count._all });
      rows.set(key, row);
    }

    for (const row of rows.values()) {
      row.variants.sort((a, b) => (a.variant ?? '').localeCompare(b.variant ?? ''));
    }

    return [...rows.values()].sort(
      (a, b) => a.brand.localeCompare(b.brand) || a.model.localeCompare(b.model),
    );
  }

  /**
   * The Stock screen: one row per exact variant, with what it sells for and
   * whether it is running low.
   *
   * Branch-scoped and assignment-checked like `countByModel`. A price is a
   * decision made in one branch, so without an active branch there is no honest
   * price to show — this requires one rather than guessing.
   *
   * Every figure is read fresh and passed through `buildStockSummary`, which
   * resolves each unit through the sale's own price ladder and never carries
   * cost. See that file for what the row deliberately omits.
   */
  async summarizeStock(): Promise<StockSummaryRow[]> {
    const branchId = this.tenant.requireBranchId();
    await assertAssignedToBranch(this.db, this.tenant.requireUserId(), branchId);
    const companyId = this.tenant.companyId();

    const [units, stockItems] = await Promise.all([
      // `in_stock` and nothing else: sold, reserved, faulty, in-transit and
      // consigned units are not stock anyone can sell today.
      this.db.unit.findMany({
        where: { status: 'in_stock', branchId },
        select: { id: true, productId: true, branchId: true },
      }),
      this.db.stockItem.findMany({
        where: { branchId },
        select: { productId: true, quantity: true, reservedQuantity: true, price: true, version: true },
      }),
    ]);

    const productIds = [
      ...new Map(
        [...units.map((u) => u.productId), ...stockItems.map((s) => s.productId)].map((id) => [
          id.toString('hex'),
          id,
        ]),
      ).values(),
    ];
    if (productIds.length === 0) return [];

    const [products, overrides, branchVariants] = await Promise.all([
      this.db.product.findMany({
        where: { id: { in: productIds } },
        select: {
          id: true,
          brand: true,
          model: true,
          variant: true,
          barcode: true,
          trackingType: true,
          specifications: true,
          defaultPrice: true,
        },
      }),
      units.length
        ? this.db.unitPriceOverride.findMany({
            where: { companyId, unitId: { in: units.map((u) => u.id) } },
            select: { unitId: true, price: true, version: true, branchId: true },
          })
        : Promise.resolve([]),
      this.db.branchVariantPrice.findMany({
        where: { companyId, branchId, productId: { in: productIds } },
        select: { productId: true, price: true, version: true },
      }),
    ]);

    return buildStockSummary({
      activeBranchId: branchId,
      products: products.map((p) => ({
        ...p,
        defaultPrice: p.defaultPrice === null ? null : Number(p.defaultPrice),
      })),
      units,
      overrides: overrides.map((o) => ({ ...o, price: Number(o.price) })),
      branchVariants: branchVariants.map((v) => ({ ...v, price: Number(v.price) })),
      stockItems: stockItems.map((s) => ({ ...s, price: s.price === null ? null : Number(s.price) })),
    });
  }

  async listStock(filter: InventoryFilter): Promise<InventoryPage> {
    const branchId = this.tenant.branchId();
    /**
     * This route carries no `@RequirePermissions`, so `PermissionsGuard` exits
     * early and never checks that the caller belongs to the branch in the
     * header — which means the list was scoped to whatever branch was CLAIMED.
     * Any signed-in user could read another branch's stock, and with it its
     * average cost. Found live in H1.4.1; the same defect G2A-CP3 fixed on the
     * pricing reads.
     */
    if (branchId) {
      await assertAssignedToBranch(this.db, this.tenant.requireUserId(), branchId);
    }
    const productId = filter.productId ? uuidToBin(filter.productId) : undefined;
    const limit = Math.min(Math.max(filter.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const cursor = filter.cursor ? decodeCursor(filter.cursor) : null;
    const search = filter.search?.trim() || undefined;

    // Quantity stock has no lifecycle, so it only belongs under "in stock" and
    // the unfiltered view. Listing it under Sold or Faulty would be meaningless.
    const includeQuantity = !filter.status || filter.status === 'in_stock';

    const unitWhere = {
      ...(branchId ? { branchId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(productId ? { productId } : {}),
      ...(search ? { OR: unitSearchClauses(search) } : {}),
    };
    const stockWhere = {
      ...(branchId ? { branchId } : {}),
      ...(productId ? { productId } : {}),
      // A zero row is a product that once had stock here; it is not stock.
      quantity: { gt: 0 },
      ...(search ? { OR: stockSearchClauses(search) } : {}),
    };

    // Totals are counted, never inferred from the page. A client that derives
    // "12 items" from a 12-row first page would understate real stock, which is
    // the exact failure this pagination exists to remove.
    const [unitTotal, stockTotal] = await Promise.all([
      this.db.unit.count({ where: unitWhere }),
      includeQuantity ? this.db.stockItem.count({ where: stockWhere }) : Promise.resolve(0),
    ]);

    const rows: InventoryRow[] = [];
    let nextCursor: string | null = null;

    // ── Units first, then stock. A page may span the boundary. ──
    if (!cursor || cursor.section === 'unit') {
      const anchor = cursor?.section === 'unit' ? uuidToBin(cursor.id) : undefined;
      const units = await this.db.unit.findMany({
        where: unitWhere,
        include: { product: { select: INVENTORY_PRODUCT_SELECT } },
        // `id` alone is the sort key: UUIDv7 is unique and time-ordered, so
        // this is "newest first" with no ties to break.
        orderBy: { id: 'desc' },
        take: limit + 1,
        ...(anchor ? { cursor: { id: anchor }, skip: 1 } : {}),
      });

      const page = units.slice(0, limit);
      rows.push(...page.map(toUnitRow));

      if (units.length > limit) {
        nextCursor = encodeCursor(buildCursor('unit', page));
        return { rows, nextCursor, hasMore: true, totals: { units: unitTotal, stock: stockTotal } };
      }
    }

    if (!includeQuantity) {
      return { rows, nextCursor: null, hasMore: false, totals: { units: unitTotal, stock: 0 } };
    }

    // Fill the rest of the page from stock so a page is never short merely
    // because it crossed the boundary between the two shapes.
    const remaining = limit - rows.length;
    const stockAnchor = cursor?.section === 'stock' ? uuidToBin(cursor.id) : undefined;
    const stock = await this.db.stockItem.findMany({
      where: stockWhere,
      include: { product: { select: INVENTORY_PRODUCT_SELECT } },
      orderBy: { id: 'desc' },
      take: remaining + 1,
      ...(stockAnchor ? { cursor: { id: stockAnchor }, skip: 1 } : {}),
    });

    const stockPage = stock.slice(0, remaining);
    rows.push(...stockPage.map(toStockRow));

    if (stock.length > remaining) {
      nextCursor = encodeCursor(buildCursor('stock', stockPage));
    }

    return {
      rows,
      nextCursor,
      hasMore: nextCursor !== null,
      totals: { units: unitTotal, stock: stockTotal },
    };
  }

  async markFaulty(unitId: string): Promise<Unit> {
    const id = uuidToBin(unitId);
    const unit = await this.db.unit.findUnique({ where: { id } });
    if (!unit) throw new NotFoundException('Unit not found');
    assertTransition(unit.status, 'faulty');

    return this.db.$transaction(async (tx) => {
      const updated = await tx.unit.update({ where: { id }, data: { status: 'faulty' } });
      await this.audit.recordTx(tx, {
        entityType: 'Unit',
        entityId: id,
        action: 'status_change',
        before: { status: unit.status },
        after: { status: 'faulty' },
        branchId: unit.branchId,
      });
      return updated;
    });
  }

  /** Resolve the tracking strategy for a product (shared with receiving). */
  strategyFor(product: Pick<Product, 'trackingType'>): TrackingStrategy {
    return this.strategies.get(product.trackingType);
  }

  private mapDuplicate(e: unknown): Error {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return new ConflictException('Identifier already registered');
    }
    return e as Error;
  }

  toUuid(bin: Buffer): string {
    return binToUuid(bin);
  }
}
