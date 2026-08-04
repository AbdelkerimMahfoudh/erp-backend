import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Product, Unit, UnitStatus } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { TrackingStrategyRegistry } from '../tracking/tracking-strategy.registry';
import { TrackingStrategy } from '../tracking/tracking-strategy';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { assertTransition } from './unit-state-machine';
import { unitIdentifier } from './unit-identifier.util';
import { QuickAddUnitDto } from './dto/quick-add-unit.dto';

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

/**
 * Row cap per shape. A single branch's live stock sits far below this, so no
 * pagination framework is warranted yet; revisit if a real store approaches it.
 */
const INVENTORY_PAGE_SIZE = 200;

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
  quantity: number;
  /** Stripped for callers without `cost.view`. */
  cost: Prisma.Decimal;
  price: Prisma.Decimal;
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
  async quickAdd(dto: QuickAddUnitDto): Promise<Unit | { productId: string; quantity: number; tracking: 'quantity' }> {
    const branchId = this.tenant.requireBranchId();
    const product = await this.db.product.findUnique({ where: { id: uuidToBin(dto.productId) } });
    if (!product) throw new NotFoundException('Product not found');
    const strategy = this.strategies.get(product.trackingType);

    if (!strategy.perUnit) {
      const quantity = dto.quantity ?? 0;
      if (quantity < 1) throw new BadRequestException(`${product.trackingType} products require a quantity`);
      await this.upsertStock(product.id, branchId, quantity, dto.cost, dto.price ?? Number(product.defaultPrice ?? 0));
      return { productId: binToUuid(product.id), quantity, tracking: 'quantity' };
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

  /** Increment (or create) the branch quantity stock for a product. */
  async upsertStock(productId: Buffer, branchId: Buffer, quantity: number, cost: number, price: number): Promise<void> {
    const companyId = this.tenant.companyId();
    await this.db.stockItem.upsert({
      where: { companyId_productId_branchId: { companyId, productId, branchId } },
      create: { id: newUuidV7Bin(), companyId, productId, branchId, quantity, cost, price },
      update: { quantity: { increment: quantity } },
    });
  }

  /** Look up a unit by its identifier (IMEI or serial). */
  async findByIdentifier(identifier: string): Promise<Unit> {
    const unit = await this.db.unit.findFirst({
      where: { OR: [{ imeiPrimary: identifier }, { serialNo: identifier }] },
      include: { product: true, branch: { select: { id: true, name: true } } },
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

  private async timeline(unitId: Buffer) {
    const events = await this.db.auditLog.findMany({
      where: { entityId: unitId, entityType: { in: ['Unit', 'Return'] } },
      orderBy: { at: 'asc' },
      take: 200,
    });
    return events.map((e) => ({
      at: e.at,
      entity: e.entityType,
      action: e.action,
      before: e.before,
      after: e.after,
      reason: e.reason,
      by: e.userId ? binToUuid(e.userId) : null,
    }));
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
  async listStock(filter: {
    status?: UnitStatus;
    productId?: string;
  }): Promise<InventoryRow[]> {
    const branchId = this.tenant.branchId();
    const productId = filter.productId ? uuidToBin(filter.productId) : undefined;

    const units = await this.db.unit.findMany({
      where: {
        ...(branchId ? { branchId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(productId ? { productId } : {}),
      },
      include: { product: { select: INVENTORY_PRODUCT_SELECT } },
      orderBy: { dateIn: 'desc' },
      take: INVENTORY_PAGE_SIZE,
    });

    const unitRows: InventoryRow[] = units.map((unit) => ({
      kind: 'unit',
      id: unit.id,
      // The DB has a generated `identifier` column Prisma cannot model, so it
      // is derived here to keep one canonical lookup key for the client.
      identifier: unit.imeiPrimary ?? unit.serialNo ?? '',
      imeiPrimary: unit.imeiPrimary,
      imeiSecondary: unit.imeiSecondary,
      serialNo: unit.serialNo,
      status: unit.status,
      cost: unit.cost,
      dateIn: unit.dateIn,
      productId: unit.productId,
      product: unit.product,
    }));

    // Quantity stock has no lifecycle, so it only belongs under "in stock" and
    // the unfiltered view. Listing it under Sold or Faulty would be meaningless.
    const includeQuantity = !filter.status || filter.status === 'in_stock';
    if (!includeQuantity) return unitRows;

    const stock = await this.db.stockItem.findMany({
      where: {
        ...(branchId ? { branchId } : {}),
        ...(productId ? { productId } : {}),
        // A zero row is a product that once had stock here; it is not stock.
        quantity: { gt: 0 },
      },
      include: { product: { select: INVENTORY_PRODUCT_SELECT } },
      orderBy: { updatedAt: 'desc' },
      take: INVENTORY_PAGE_SIZE,
    });

    const stockRows: InventoryRow[] = stock.map((line) => ({
      kind: 'stock',
      id: line.id,
      productId: line.productId,
      quantity: line.quantity,
      cost: line.cost,
      price: line.price,
      product: line.product,
    }));

    return [...unitRows, ...stockRows];
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
