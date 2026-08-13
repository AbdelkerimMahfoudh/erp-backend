import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { AppClsStore } from '../common/context/request-context';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import {
  CurrentRow,
  PriceSource,
  PriceTargetType,
  ResolvedPrice,
  resolveProductLevel,
  resolveQuantity,
  resolveSerialized,
} from './price-resolution';
import { PriceHistoryQueryDto, RemovePriceDto, SetPriceDto } from './dto/pricing.dto';

/**
 * The transaction client of the TENANT-scoped Prisma client — not the plain
 * `Prisma.TransactionClient`. Using the extended type keeps company scoping in
 * force inside transactions instead of silently dropping to an unscoped client.
 */
type Tx = Omit<TenantPrisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

/** What a caller needs to display and edit a price. Never cost, never margin. */
export interface EffectivePrice {
  price: number | null;
  source: PriceSource;
  version: number | null;
  targetType: PriceTargetType | null;
  branchId: string;
  /** True when a removable row (not a fallback) is producing the price. */
  canRemove: boolean;
  /** What the price would become if the current row were removed. */
  fallback: { price: number | null; source: PriceSource } | null;
  /** An override exists but does not apply here — explained, never applied. */
  staleOverrideIgnored: boolean;
}

const HISTORY_DEFAULT_LIMIT = 25;

/**
 * The one authority on selling price.
 *
 * Every caller — Sell, product detail, the pricing API, and later the mobile app
 * — asks this service rather than reassembling the precedence itself. When two
 * screens each implement "override, else branch, else default", they drift, and
 * the shop finds out at the counter.
 *
 * Tenant safety: every query runs on the tenant-scoped client, which injects the
 * caller's `companyId`, and every write additionally states `companyId` in its
 * `where`/`data` explicitly. So an id belonging to another company simply does
 * not resolve — it 404s rather than being found and rejected, which also avoids
 * confirming that the id exists.
 */
@Injectable()
export class PricingService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  // ───────────────────────────── reads ─────────────────────────────

  /**
   * Effective price for a product in the active branch, with no unit chosen.
   *
   * Quantity products resolve from their own stock row; serialized products from
   * the branch variant price. A unit override is never consulted here — see
   * `resolveProductLevel`.
   */
  async getProductPricing(productIdStr: string): Promise<EffectivePrice> {
    const branchId = await this.activeBranch();
    const product = await this.loadProduct(productIdStr);

    if (product.trackingType === 'quantity') {
      const stock = await this.db.stockItem.findFirst({
        where: { productId: product.id, branchId },
        select: { price: true, version: true },
      });
      const resolved = resolveQuantity(row(stock), num(product.defaultPrice));
      return this.present(resolved, branchId, num(product.defaultPrice), null);
    }

    const variant = await this.loadBranchVariant(product.id, branchId);
    const resolved = resolveProductLevel(row(variant), num(product.defaultPrice));
    return this.present(resolved, branchId, num(product.defaultPrice), null);
  }

  /**
   * Effective price for one exact unit, found by scanned or typed identifier.
   *
   * Resolution by identifier rather than by id is deliberate: the counter scans
   * an IMEI, and making the client translate that to an internal id first would
   * be a round trip and a chance to send someone else's id.
   */
  async getUnitPricing(
    identifier: string,
  ): Promise<EffectivePrice & { unitId: string; status: string; canPrice: boolean }> {
    const branchId = await this.activeBranch();
    const unit = await this.loadUnitByIdentifier(identifier);

    const [override, variant] = await Promise.all([
      this.loadOverride(unit.id),
      this.loadBranchVariant(unit.productId, branchId),
    ]);

    const productDefault = num(unit.product.defaultPrice);
    const resolved = resolveSerialized({
      activeBranchId: branchId,
      unitBranchId: unit.branchId,
      override: override
        ? { price: Number(override.price), version: override.version, branchId: override.branchId }
        : null,
      branchVariant: row(variant),
      productDefault,
    });

    return {
      ...this.present(resolved, branchId, productDefault, row(variant)),
      unitId: binToUuid(unit.id),
      status: unit.status,
      /**
       * Whether this phone may be given its own price at all. Returned so the
       * app can explain instead of offering a control that is going to be
       * refused — a button whose only outcome is an error teaches staff the app
       * is unreliable.
       */
      canPrice: unit.status === 'in_stock' && unit.branchId.equals(branchId),
    };
  }

  /**
   * Price history, newest first, keyset-paginated on the UUIDv7 id.
   *
   * Restricted to `price.edit` at the controller: an employee needs today's
   * selling price to do their job, but who changed what and when is pricing
   * authority's business.
   */
  async history(query: PriceHistoryQueryDto) {
    const branchId = await this.activeBranch();
    const limit = query.limit ?? HISTORY_DEFAULT_LIMIT;

    const rows = await this.db.priceChangeEvent.findMany({
      where: {
        branchId,
        ...(query.productId ? { productId: uuidToBin(query.productId) } : {}),
        ...(query.unitId ? { unitId: uuidToBin(query.unitId) } : {}),
      },
      // Keyset pagination on the UUIDv7 primary key, same as the catalog.
      ...(query.cursor ? { cursor: { id: uuidToBin(query.cursor) }, skip: 1 } : {}),
      orderBy: { id: 'desc' },
      take: limit + 1,
      select: {
        id: true,
        productId: true,
        unitId: true,
        scope: true,
        initiator: true,
        previousPrice: true,
        newPrice: true,
        reason: true,
        createdAt: true,
        actor: { select: { name: true } },
      },
    });

    const page = rows.slice(0, limit);
    return {
      rows: page.map((r) => ({
        id: binToUuid(r.id),
        productId: binToUuid(r.productId),
        unitId: r.unitId ? binToUuid(r.unitId) : null,
        scope: r.scope,
        initiator: r.initiator,
        previousPrice: num(r.previousPrice),
        newPrice: num(r.newPrice),
        reason: r.reason,
        actorName: r.actor?.name ?? null,
        at: r.createdAt,
      })),
      nextCursor: rows.length > limit ? binToUuid(page[page.length - 1]!.id) : null,
    };
  }

  // ───────────────────────────── writes ─────────────────────────────

  /**
   * Set (create or replace) the branch price for one exact variant.
   *
   * `expectedVersion` is required whenever a row already exists. Omitting it on
   * a create is safe because the unique key decides the race: the loser gets a
   * 409 telling it to refresh, not a silent overwrite of the winner's price.
   */
  async setBranchVariantPrice(productIdStr: string, dto: SetPriceDto): Promise<EffectivePrice> {
    const companyId = this.tenant.companyId();
    const branchId = await this.activeBranch();
    const actorId = this.tenant.requireUserId();
    const product = await this.loadProduct(productIdStr);
    this.assertSerialized(product.trackingType, 'branch variant price');

    const affected = await this.assertVariantNotBelowCost(product.id, branchId, dto.price, dto.reason);

    return this.db.$transaction(async (tx) => {
      const existing = await tx.branchVariantPrice.findFirst({
        where: { companyId, productId: product.id, branchId },
        select: { id: true, price: true, version: true },
      });

      let previous: number | null = null;
      if (existing) {
        if (dto.expectedVersion === undefined) {
          throw new ConflictException({
            code: 'refresh_required',
            message: 'A price already exists for this variant in this branch. Refresh and retry.',
          });
        }
        const updated = await tx.branchVariantPrice.updateMany({
          where: { id: existing.id, companyId, version: dto.expectedVersion },
          data: { price: dto.price, version: { increment: 1 }, setById: actorId },
        });
        if (updated.count === 0) throw staleWrite();
        previous = Number(existing.price);
      } else {
        try {
          await tx.branchVariantPrice.create({
            data: {
              id: newUuidV7Bin(),
              companyId,
              branchId,
              productId: product.id,
              price: dto.price,
              setById: actorId,
            },
          });
        } catch (e) {
          // Someone else created it between the read and the insert. The unique
          // key is what decides; we translate its rejection into "refresh".
          if (isUniqueViolation(e)) throw staleWrite();
          throw e;
        }
      }

      await this.recordChangeTx(tx, {
        branchId,
        productId: product.id,
        unitId: null,
        scope: 'branch_variant',
        previousPrice: previous,
        newPrice: dto.price,
        reason: dto.reason ?? null,
        actorId,
      });
      await this.audit.recordTx(tx, {
        entityType: 'BranchVariantPrice',
        entityId: product.id,
        action: existing ? 'update' : 'create',
        before: previous === null ? undefined : { price: previous },
        after: { price: dto.price, affectedUnits: affected },
        reason: dto.reason,
        branchId,
      });
      await this.notifyOwnersTx(tx, {
        branchId,
        actorId,
        productId: product.id,
        scope: 'branch_variant',
        previousPrice: previous,
        newPrice: dto.price,
      });

      return this.readBackProduct(tx, product.id, branchId, num(product.defaultPrice));
    });
  }

  /** Remove the branch price, revealing whatever the fallback turns out to be. */
  async removeBranchVariantPrice(productIdStr: string, dto: RemovePriceDto): Promise<EffectivePrice> {
    const companyId = this.tenant.companyId();
    const branchId = await this.activeBranch();
    const actorId = this.tenant.requireUserId();
    const product = await this.loadProduct(productIdStr);

    return this.db.$transaction(async (tx) => {
      const existing = await tx.branchVariantPrice.findFirst({
        where: { companyId, productId: product.id, branchId },
        select: { id: true, price: true },
      });
      if (!existing) throw new NotFoundException('No branch price to remove');

      const deleted = await tx.branchVariantPrice.deleteMany({
        where: { id: existing.id, companyId, version: dto.expectedVersion },
      });
      if (deleted.count === 0) throw staleWrite();

      await this.recordChangeTx(tx, {
        branchId,
        productId: product.id,
        unitId: null,
        scope: 'branch_variant',
        previousPrice: Number(existing.price),
        // null = removed. The row is gone; history keeps what it was.
        newPrice: null,
        reason: dto.reason ?? null,
        actorId,
      });
      await this.audit.recordTx(tx, {
        entityType: 'BranchVariantPrice',
        entityId: product.id,
        action: 'delete',
        before: { price: Number(existing.price) },
        reason: dto.reason,
        branchId,
      });
      await this.notifyOwnersTx(tx, {
        branchId,
        actorId,
        productId: product.id,
        scope: 'branch_variant',
        previousPrice: Number(existing.price),
        newPrice: null,
      });

      return this.readBackProduct(tx, product.id, branchId, num(product.defaultPrice));
    });
  }

  /**
   * Set the override for one exact unit, addressed by identifier.
   *
   * The unit must be in the active branch. Pricing a phone that lives somewhere
   * else would create precisely the cross-branch authority the override's
   * `branchId` exists to prevent.
   */
  async setUnitOverride(identifier: string, dto: SetPriceDto) {
    const companyId = this.tenant.companyId();
    const branchId = await this.activeBranch();
    const actorId = this.tenant.requireUserId();
    const unit = await this.loadUnitByIdentifier(identifier);
    this.assertUnitInActiveBranch(unit.branchId, branchId);
    this.assertUnitPriceable(unit.status, identifier);
    this.assertNotBelowCost(dto.price, Number(unit.cost), dto.reason, 'this phone');

    await this.db.$transaction(async (tx) => {
      const existing = await tx.unitPriceOverride.findFirst({
        where: { companyId, unitId: unit.id },
        select: { id: true, price: true },
      });

      let previous: number | null = null;
      if (existing) {
        if (dto.expectedVersion === undefined) {
          throw new ConflictException({
            code: 'refresh_required',
            message: 'This phone already has a price. Refresh and retry.',
          });
        }
        const updated = await tx.unitPriceOverride.updateMany({
          where: { id: existing.id, companyId, version: dto.expectedVersion },
          data: { price: dto.price, version: { increment: 1 }, setById: actorId, branchId },
        });
        if (updated.count === 0) throw staleWrite();
        previous = Number(existing.price);
      } else {
        try {
          await tx.unitPriceOverride.create({
            data: {
              id: newUuidV7Bin(),
              companyId,
              // The branch whose authority is setting it — checked on every read.
              branchId,
              unitId: unit.id,
              price: dto.price,
              setById: actorId,
            },
          });
        } catch (e) {
          if (isUniqueViolation(e)) throw staleWrite();
          throw e;
        }
      }

      await this.recordChangeTx(tx, {
        branchId,
        productId: unit.productId,
        unitId: unit.id,
        scope: 'unit',
        previousPrice: previous,
        newPrice: dto.price,
        reason: dto.reason ?? null,
        actorId,
      });
      await this.audit.recordTx(tx, {
        entityType: 'UnitPriceOverride',
        entityId: unit.id,
        action: existing ? 'update' : 'create',
        before: previous === null ? undefined : { price: previous },
        after: { price: dto.price },
        reason: dto.reason,
        branchId,
      });
      await this.notifyOwnersTx(tx, {
        branchId,
        actorId,
        productId: unit.productId,
        unitId: unit.id,
        scope: 'unit',
        previousPrice: previous,
        newPrice: dto.price,
      });
    });

    return this.getUnitPricing(identifier);
  }

  /** Remove a unit override, revealing the branch or default price beneath it. */
  async removeUnitOverride(identifier: string, dto: RemovePriceDto) {
    const companyId = this.tenant.companyId();
    const branchId = await this.activeBranch();
    const actorId = this.tenant.requireUserId();
    const unit = await this.loadUnitByIdentifier(identifier);
    this.assertUnitInActiveBranch(unit.branchId, branchId);

    await this.db.$transaction(async (tx) => {
      const existing = await tx.unitPriceOverride.findFirst({
        where: { companyId, unitId: unit.id },
        select: { id: true, price: true },
      });
      if (!existing) throw new NotFoundException('This phone has no price of its own');

      const deleted = await tx.unitPriceOverride.deleteMany({
        where: { id: existing.id, companyId, version: dto.expectedVersion },
      });
      if (deleted.count === 0) throw staleWrite();

      await this.recordChangeTx(tx, {
        branchId,
        productId: unit.productId,
        unitId: unit.id,
        scope: 'unit',
        previousPrice: Number(existing.price),
        newPrice: null,
        reason: dto.reason ?? null,
        actorId,
      });
      await this.audit.recordTx(tx, {
        entityType: 'UnitPriceOverride',
        entityId: unit.id,
        action: 'delete',
        before: { price: Number(existing.price) },
        reason: dto.reason,
        branchId,
      });
      await this.notifyOwnersTx(tx, {
        branchId,
        actorId,
        productId: unit.productId,
        unitId: unit.id,
        scope: 'unit',
        previousPrice: Number(existing.price),
        newPrice: null,
      });
    });

    return this.getUnitPricing(identifier);
  }

  /**
   * Change the branch price of quantity stock.
   *
   * This updates the existing `stock_items` row rather than creating a pricing
   * row, because `StockItem.price` has always been the branch price for quantity
   * products. A second source would just be a second answer.
   */
  async setQuantityPrice(productIdStr: string, dto: SetPriceDto & { expectedVersion: number }): Promise<EffectivePrice> {
    const companyId = this.tenant.companyId();
    const branchId = await this.activeBranch();
    const actorId = this.tenant.requireUserId();
    const product = await this.loadProduct(productIdStr);
    if (product.trackingType !== 'quantity') {
      throw new BadRequestException('This product is tracked individually — price it per branch or per item');
    }

    return this.db.$transaction(async (tx) => {
      const stock = await tx.stockItem.findFirst({
        where: { companyId, productId: product.id, branchId },
        select: { id: true, price: true, cost: true },
      });
      if (!stock) throw new NotFoundException('This product has no stock in this branch yet');

      this.assertNotBelowCost(dto.price, Number(stock.cost), dto.reason, 'this item');

      const updated = await tx.stockItem.updateMany({
        where: { id: stock.id, companyId, version: dto.expectedVersion },
        data: { price: dto.price, version: { increment: 1 } },
      });
      if (updated.count === 0) throw staleWrite();

      await this.recordChangeTx(tx, {
        branchId,
        productId: product.id,
        unitId: null,
        scope: 'stock_item',
        previousPrice: Number(stock.price),
        newPrice: dto.price,
        reason: dto.reason ?? null,
        actorId,
      });
      await this.audit.recordTx(tx, {
        entityType: 'StockItem',
        entityId: stock.id,
        action: 'update',
        before: { price: Number(stock.price) },
        after: { price: dto.price },
        reason: dto.reason,
        branchId,
      });
      await this.notifyOwnersTx(tx, {
        branchId,
        actorId,
        productId: product.id,
        scope: 'stock_item',
        previousPrice: Number(stock.price),
        newPrice: dto.price,
      });

      const fresh = await tx.stockItem.findFirst({
        where: { companyId, productId: product.id, branchId },
        select: { price: true, version: true },
      });
      return this.present(
        resolveQuantity(row(fresh), num(product.defaultPrice)),
        branchId,
        num(product.defaultPrice),
        null,
      );
    });
  }

  // ────────────────────── used by other services ──────────────────────

  /**
   * The price Sell should charge when the counter did not type one.
   *
   * Sell owns the sale; pricing owns what a thing costs. Returning the resolved
   * value (rather than having Sell rebuild the ladder) is what keeps the two
   * from drifting apart.
   */
  async resolveForSaleTx(
    tx: Tx,
    input:
      | { kind: 'unit'; unitId: Buffer; productId: Buffer; unitBranchId: Buffer; productDefault: number | null }
      | { kind: 'quantity'; productId: Buffer; stock: CurrentRow | null; productDefault: number | null },
    branchId: Buffer,
  ): Promise<ResolvedPrice> {
    const companyId = this.tenant.companyId();
    if (input.kind === 'quantity') {
      return resolveQuantity(input.stock, input.productDefault);
    }
    const [override, variant] = await Promise.all([
      tx.unitPriceOverride.findFirst({
        where: { companyId, unitId: input.unitId },
        select: { price: true, version: true, branchId: true },
      }),
      tx.branchVariantPrice.findFirst({
        where: { companyId, productId: input.productId, branchId },
        select: { price: true, version: true },
      }),
    ]);
    return resolveSerialized({
      activeBranchId: branchId,
      unitBranchId: input.unitBranchId,
      override: override
        ? { price: Number(override.price), version: override.version, branchId: override.branchId }
        : null,
      branchVariant: row(variant),
      productDefault: input.productDefault,
    });
  }

  /**
   * Retire unit overrides when units actually change branch.
   *
   * Called from inside the transfer's own transaction, so the move and the
   * invalidation commit or roll back together — a transfer that fails must not
   * leave a phone stripped of its price.
   *
   * The row is deleted rather than flagged: a phone that comes back later must
   * not silently resurrect a price nobody re-approved. History keeps the value.
   */
  async invalidateOnBranchMoveTx(
    tx: Tx,
    moves: { unitId: Buffer; productId: Buffer; fromBranchId: Buffer; toBranchId: Buffer }[],
  ): Promise<number> {
    const companyId = this.tenant.companyId();
    let invalidated = 0;

    for (const move of moves) {
      if (move.fromBranchId.equals(move.toBranchId)) continue; // not a move

      const override = await tx.unitPriceOverride.findFirst({
        where: { companyId, unitId: move.unitId },
        select: { id: true, price: true, branchId: true },
      });
      if (!override) continue;

      await tx.unitPriceOverride.deleteMany({ where: { id: override.id, companyId } });
      await tx.priceChangeEvent.create({
        data: {
          id: newUuidV7Bin(),
          companyId,
          // Recorded against the branch that held the authority being retired.
          branchId: override.branchId,
          productId: move.productId,
          unitId: move.unitId,
          scope: 'unit',
          initiator: 'system',
          previousPrice: override.price,
          newPrice: null,
          reason: 'branch_transfer',
          actorId: this.tenant.userId() ?? null,
        },
      });
      invalidated += 1;
    }
    return invalidated;
  }

  // ───────────────────────────── internals ─────────────────────────────

  /**
   * The active branch, proven to be one the caller may act in.
   *
   * Writes are covered by `PermissionsGuard`, which 403s when the user is not
   * assigned to the branch. Reads of the effective price require no permission —
   * the counter needs them — so nothing else would check the branch, and an
   * employee in one branch could read another branch's prices just by changing a
   * header. The assignment lookup runs on the tenant client, so a branch from
   * another company cannot match either.
   */
  private async activeBranch(): Promise<Buffer> {
    const branchId = this.tenant.requireBranchId();
    const assignment = await this.db.userBranch.findFirst({
      where: { userId: this.tenant.requireUserId(), branchId },
      select: { id: true },
    });
    if (!assignment) throw new ForbiddenException('No access to the requested branch');
    return branchId;
  }

  private async loadProduct(productIdStr: string) {
    const product = await this.db.product.findFirst({
      where: { id: uuidToBin(productIdStr) },
      select: { id: true, trackingType: true, defaultPrice: true, brand: true, model: true, variant: true },
    });
    // Another company's id resolves to nothing here, because the tenant client
    // has already narrowed the query — so it 404s without revealing existence.
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  private async loadUnitByIdentifier(identifier: string) {
    const trimmed = identifier?.trim();
    if (!trimmed) throw new BadRequestException('Scan or type an IMEI or serial number');
    const unit = await this.db.unit.findFirst({
      where: { OR: [{ imeiPrimary: trimmed }, { serialNo: trimmed }] },
      select: {
        id: true,
        productId: true,
        branchId: true,
        cost: true,
        status: true,
        product: { select: { defaultPrice: true, brand: true, model: true, variant: true } },
      },
    });
    if (!unit) throw new NotFoundException(`Not found: ${trimmed}`);
    return unit;
  }

  private loadOverride(unitId: Buffer) {
    return this.db.unitPriceOverride.findFirst({
      where: { unitId },
      select: { price: true, version: true, branchId: true },
    });
  }

  private loadBranchVariant(productId: Buffer, branchId: Buffer) {
    return this.db.branchVariantPrice.findFirst({
      where: { productId, branchId },
      select: { price: true, version: true },
    });
  }

  private assertSerialized(trackingType: string, what: string): void {
    if (trackingType === 'quantity') {
      throw new BadRequestException(`Quantity stock does not use a ${what} — set its branch price instead`);
    }
  }

  private assertUnitInActiveBranch(unitBranchId: Buffer, activeBranchId: Buffer): void {
    if (!unitBranchId.equals(activeBranchId)) {
      throw new ForbiddenException('This item is not in your branch');
    }
  }

  /**
   * Only a unit that could actually be sold may be given its own price.
   *
   * A sold, returned, faulty or in-transit phone is not on the shelf, so a price
   * for it is a decision about nothing — and worse, the override would sit there
   * waiting: a returned phone put back into stock would silently resurrect a
   * price nobody re-approved, which is exactly what transfer invalidation exists
   * to prevent.
   *
   * `in_stock` mirrors `SalesPolicyService.assertSellable`, deliberately: the set
   * of things you can price and the set you can sell should not drift apart.
   * Removal is NOT gated — clearing a stale override must stay possible.
   */
  private assertUnitPriceable(status: string, identifier: string): void {
    if (status !== 'in_stock') {
      throw new ConflictException(`${identifier} is '${status}' and cannot be priced`);
    }
  }

  /**
   * Below cost is a soft block, not a wall: it needs `discount.override` and a
   * stated reason.
   *
   * Expressed purely in permissions — a Store Manager is refused because
   * `discount.override` is Owner-only and never delegatable, not because anyone
   * compared their role name. The reason is recorded in history.
   */
  private assertNotBelowCost(
    price: number,
    cost: number,
    reason: string | undefined,
    subject: string,
  ): void {
    if (price >= cost) return;
    if (!this.has('discount.override')) {
      throw new ForbiddenException(`That price is below what you paid for ${subject}. Ask the owner to approve it.`);
    }
    if (!reason || reason.trim().length === 0) {
      throw new BadRequestException('Say why you are selling below cost');
    }
  }

  /**
   * A branch price applies to every phone of that variant in the branch, so it
   * has to clear the most expensive one currently in stock.
   *
   * Returns how many units would be affected — a count is safe to show, whereas
   * the costs themselves belong to `cost.view` holders only. With no units in
   * stock the price is allowed: there is nothing to sell below cost yet, and
   * Sell re-checks the real unit cost at the counter anyway.
   */
  private async assertVariantNotBelowCost(
    productId: Buffer,
    branchId: Buffer,
    price: number,
    reason: string | undefined,
  ): Promise<number> {
    const below = await this.db.unit.count({
      where: { productId, branchId, status: 'in_stock', cost: { gt: price } },
    });
    if (below === 0) return 0;

    if (!this.has('discount.override')) {
      throw new ForbiddenException(
        `That price is below cost for ${below} item(s) of this model in this branch. Ask the owner to approve it.`,
      );
    }
    if (!reason || reason.trim().length === 0) {
      throw new BadRequestException('Say why you are selling below cost');
    }
    return below;
  }

  private has(permission: string): boolean {
    return this.cls.get('permissions')?.has(permission) ?? false;
  }

  private recordChangeTx(
    tx: Tx,
    p: {
      branchId: Buffer;
      productId: Buffer;
      unitId: Buffer | null;
      scope: string;
      previousPrice: number | null;
      newPrice: number | null;
      reason: string | null;
      actorId: Buffer;
    },
  ) {
    return tx.priceChangeEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId: this.tenant.companyId(),
        branchId: p.branchId,
        productId: p.productId,
        unitId: p.unitId,
        scope: p.scope,
        initiator: 'user',
        previousPrice: p.previousPrice,
        newPrice: p.newPrice,
        reason: p.reason,
        actorId: p.actorId,
      },
    });
  }

  /**
   * Tell the Owner when someone else changes a price.
   *
   * The actor is excluded, which handles both rules at once: a Manager's change
   * reaches every Owner, and an Owner's own change notifies nobody — it is still
   * audited and still in price history.
   *
   * Deliberately carries no cost, no margin and no below-cost threshold: a
   * notification is delivered outside the request that authorized it, so it must
   * not become a way to read figures the recipient's permissions would gate.
   * Created inside the price transaction, so there is no notification for a
   * change that rolled back.
   */
  private async notifyOwnersTx(
    tx: Tx,
    p: {
      branchId: Buffer;
      actorId: Buffer;
      productId: Buffer;
      unitId?: Buffer;
      scope: string;
      previousPrice: number | null;
      newPrice: number | null;
    },
  ): Promise<void> {
    const companyId = this.tenant.companyId();

    const owners = await tx.userBranch.findMany({
      where: {
        companyId,
        role: { key: 'owner' },
        user: { isActive: true, deletedAt: null },
        userId: { not: p.actorId },
      },
      select: { userId: true },
    });
    // An Owner assigned to several branches appears once per assignment — one
    // person should get one notification, not one per branch they happen to own.
    const unique = new Map(owners.map((o) => [o.userId.toString('hex'), o.userId]));
    if (unique.size === 0) return;

    const [product, actor] = await Promise.all([
      tx.product.findFirst({
        where: { id: p.productId },
        select: { brand: true, model: true, variant: true },
      }),
      tx.user.findFirst({ where: { id: p.actorId }, select: { name: true } }),
    ]);

    const label = [product?.brand, product?.model, product?.variant].filter(Boolean).join(' ');
    const scopeText = p.scope === 'unit' ? 'this exact item' : 'all of this model in the branch';
    const change =
      p.newPrice === null
        ? `removed the price (was ${p.previousPrice})`
        : p.previousPrice === null
          ? `set the price to ${p.newPrice}`
          : `changed the price from ${p.previousPrice} to ${p.newPrice}`;

    for (const userId of unique.values()) {
      await tx.notification.create({
        data: {
          id: newUuidV7Bin(),
          companyId,
          branchId: p.branchId,
          targetUserId: userId,
          type: 'price.changed',
          title: `Price changed: ${label || 'product'}`,
          body: `${actor?.name ?? 'A manager'} ${change} for ${scopeText}.`,
          actionLink: p.unitId
            ? `/catalog/${binToUuid(p.productId)}?unit=${binToUuid(p.unitId)}`
            : `/catalog/${binToUuid(p.productId)}`,
        },
      });
    }
  }

  /** Shape a resolution for the wire, including what removal would reveal. */
  private present(
    resolved: ResolvedPrice,
    branchId: Buffer,
    productDefault: number | null,
    variantBeneath: CurrentRow | null,
  ): EffectivePrice {
    const canRemove = resolved.source === 'unit_override' || resolved.source === 'branch_variant';
    let fallback: EffectivePrice['fallback'] = null;
    if (canRemove) {
      const beneath =
        resolved.source === 'unit_override'
          ? resolveProductLevel(variantBeneath, productDefault)
          : resolveProductLevel(null, productDefault);
      fallback = { price: beneath.price, source: beneath.source };
    }
    return {
      price: resolved.price,
      source: resolved.source,
      version: resolved.version,
      targetType: resolved.targetType,
      branchId: binToUuid(branchId),
      canRemove,
      fallback,
      staleOverrideIgnored: resolved.staleOverrideIgnored,
    };
  }

  private async readBackProduct(
    tx: Tx,
    productId: Buffer,
    branchId: Buffer,
    productDefault: number | null,
  ): Promise<EffectivePrice> {
    const variant = await tx.branchVariantPrice.findFirst({
      where: { companyId: this.tenant.companyId(), productId, branchId },
      select: { price: true, version: true },
    });
    return this.present(resolveProductLevel(row(variant), productDefault), branchId, productDefault, null);
  }
}

// ───────────────────────────── helpers ─────────────────────────────

function num(d: Prisma.Decimal | number | null | undefined): number | null {
  return d === null || d === undefined ? null : Number(d);
}

/**
 * A price row for the ladder, or `null` if this rung has no answer.
 *
 * Since `0034` a `stock_items` row may exist with **no price** — stock a
 * transfer delivered into a branch that has never priced it. A row whose price
 * is NULL must behave exactly like no row at all, so the ladder falls through
 * to the product default and then to `unpriced`. `Number(null)` is `0`, which
 * would have quietly advertised free goods, so the check is explicit.
 */
function row(
  r: { price: Prisma.Decimal | number | null; version: number } | null | undefined,
): CurrentRow | null {
  if (!r || r.price === null) return null;
  return { price: Number(r.price), version: r.version };
}

function staleWrite(): ConflictException {
  return new ConflictException({
    code: 'refresh_required',
    message: 'Someone else changed this price. Refresh and try again.',
  });
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}
