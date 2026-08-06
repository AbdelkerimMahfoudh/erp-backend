import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Prisma, Product, TrackingType } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { AccessService } from '../rbac/access.service';
import { AppClsStore } from '../common/context/request-context';
import { ProductAttributesService } from '../tracking/product-attributes.service';
import { RecognitionService } from '../scanner/recognition.service';
import { RecognitionOutboxService } from '../scanner/recognition-outbox.service';
import { newUuidV7Bin, binToUuid, isUuid, uuidToBin } from '../common/utils/uuid.util';
import { isValidImei, tacOf } from '../inventory/imei.util';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ListProductsDto } from './dto/list-products.dto';
import { CatalogCursor, decodeCatalogCursor, encodeCatalogCursor } from './catalog-cursor';

/**
 * Bounds on the adaptive `specifications` JSON. Unbounded client JSON on a row
 * every screen reads is a denial-of-service waiting to happen, so the shape is
 * capped: a flat-ish object, few keys, short values. Depth 2 allows a nested
 * object of scalars and nothing deeper.
 */
const SPEC_MAX_KEYS = 40;
const SPEC_MAX_KEY_LEN = 60;
const SPEC_MAX_VALUE_LEN = 200;
const SPEC_MAX_DEPTH = 2;
/** Keys that would smuggle money into metadata — rejected outright. */
const SPEC_FORBIDDEN = /(^|_)(cost|price|margin|profit)($|_)/i;

const DEFAULT_PAGE = 30;
/** Cap on the specification-search id lookup — bounded, company-scoped. */
const SPEC_SEARCH_LIMIT = 500;

/**
 * A confirm-card for the scan→confirm→cost/quantity flow. The employee scans a
 * code, sees this, taps ✓, and only then enters cost & quantity — brand, model,
 * specs, category and attributes are never re-typed (Product is the template).
 */
export interface ProductSuggestion {
  productId: string;
  brand: string;
  model: string;
  variant: string | null;
  trackingType: TrackingType;
  keySpecifications: Record<string, unknown>;
  image: string | null; // reserved — no product image field yet
  defaultCost: number | null;
  defaultPrice: number | null;
}

/** One catalog row — the exact-variant identity, never a price or a cost. */
export interface ProductListRow {
  id: string;
  brand: string;
  model: string;
  variant: string | null;
  /** "Apple iPhone 13 Pro Max 256GB Sierra Blue" — one label, agreed everywhere. */
  label: string;
  trackingType: TrackingType;
  serialized: boolean;
  barcode: string | null;
  categoryId: string | null;
  isActive: boolean;
}

export interface ProductStockRow {
  branchId: string;
  branchName: string;
  quantity: number;
  /** Per-branch quantity price (`StockItem.price`); null for serialized stock. */
  price: number | null;
}

export interface ProductDetail extends ProductListRow {
  specifications: Record<string, unknown>;
  categoryName: string | null;
  reorderThreshold: number;
  /**
   * False once units, stock, purchases or sales exist under this product —
   * changing the tracking mode would reinterpret that history, so the edit form
   * disables the control and explains why rather than letting the user try and
   * collect a 409. The server enforces the rule regardless (G1).
   */
  canChangeTracking: boolean;
  stockByBranch: ProductStockRow[];
  totalStock: number;
  defaultPrice: number | null;
  defaultCost: number | null;
  lastSoldPrice: number | null;
  lastSoldAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Exactly the columns a catalog row may expose. */
const LIST_SELECT = {
  id: true,
  brand: true,
  model: true,
  variant: true,
  trackingType: true,
  barcode: true,
  categoryId: true,
  deletedAt: true,
} satisfies Prisma.ProductSelect;

@Injectable()
export class CatalogService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly attributes: ProductAttributesService,
    private readonly recognition: RecognitionService,
    private readonly outbox: RecognitionOutboxService,
    private readonly access: AccessService,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  // ------------------------------------------------------------- guards/util

  /**
   * `catalog.manage` must never imply `price.edit` (G1). A caller may only send
   * a selling price if they separately hold pricing authority; otherwise the
   * request is refused rather than silently ignored, so nobody believes they set
   * a price that was dropped.
   */
  private async assertMaySetPrice(): Promise<void> {
    const cached = this.cls.get('permissions');
    const userId = this.cls.get('userId');
    const permissions =
      cached ??
      (userId
        ? await this.access.getEffectivePermissions(uuidToBin(userId), this.tenant.branchId())
        : new Set<string>());
    if (!permissions.has('price.edit')) {
      throw new ForbiddenException(
        'Setting a selling price needs price.edit. Catalog administration does not include pricing.',
      );
    }
  }

  /** Trim, upper-case and collapse a barcode; '' means "no barcode". */
  private normalizeBarcode(raw: string | null | undefined): string | null {
    if (raw === null || raw === undefined) return null;
    const cleaned = String(raw).trim().replace(/\s+/g, '').toUpperCase();
    return cleaned.length ? cleaned : null;
  }

  /** A different product already holding this barcode is a 409, never a silent steal. */
  private async assertBarcodeFree(barcode: string, excludeProductId?: Buffer): Promise<void> {
    const clash = await this.db.product.findFirst({ where: { barcode }, select: { id: true } });
    if (clash && !(excludeProductId && clash.id.equals(excludeProductId))) {
      throw new ConflictException('Another product already uses that barcode');
    }
  }

  /** Bounded, money-free specifications. Rejects rather than truncating. */
  private assertSpecificationsSafe(specs: Record<string, unknown> | undefined): void {
    if (specs === undefined) return;
    if (typeof specs !== 'object' || specs === null || Array.isArray(specs)) {
      throw new BadRequestException('Specifications must be an object');
    }

    const walk = (value: unknown, depth: number): void => {
      if (depth > SPEC_MAX_DEPTH) {
        throw new BadRequestException('Specifications are nested too deeply');
      }
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
        if (typeof value === 'string' && value.length > SPEC_MAX_VALUE_LEN) {
          throw new BadRequestException('A specification value is too long');
        }
        return;
      }
      if (Array.isArray(value)) {
        if (value.length > SPEC_MAX_KEYS) throw new BadRequestException('A specification list is too long');
        for (const item of value) walk(item, depth + 1);
        return;
      }
      if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length > SPEC_MAX_KEYS) throw new BadRequestException('Too many specification fields');
        for (const [key, child] of entries) {
          if (key.length > SPEC_MAX_KEY_LEN) throw new BadRequestException('A specification name is too long');
          if (SPEC_FORBIDDEN.test(key)) {
            throw new BadRequestException(
              `"${key}" cannot be a specification. Cost and price live on receiving and stock, not on product metadata.`,
            );
          }
          walk(child, depth + 1);
        }
        return;
      }
      throw new BadRequestException('Unsupported specification value');
    };

    walk(specs, 1);
  }

  async create(dto: CreateProductDto): Promise<Product> {
    const companyId = this.tenant.companyId();

    // Price is authority, not metadata (G1). Cost is never product metadata at
    // all — it belongs to receiving — so it is refused the same way.
    if (dto.defaultPrice !== undefined || dto.defaultCost !== undefined) {
      await this.assertMaySetPrice();
    }
    this.assertSpecificationsSafe(dto.specifications);
    const barcode = this.normalizeBarcode(dto.barcode);
    if (barcode) await this.assertBarcodeFree(barcode);

    let categoryId: Buffer | null = null;
    let trackingType = dto.trackingType;
    let schemaRaw: unknown = null;
    if (dto.categoryId) {
      // The tenant client scopes this lookup, so a category from another company
      // is simply not found — cross-company references cannot be created.
      const category = await this.db.productCategory.findUnique({ where: { id: uuidToBin(dto.categoryId) } });
      if (!category) throw new NotFoundException('Category not found');
      categoryId = category.id;
      trackingType = trackingType ?? category.defaultTrackingType; // category drives the default
      schemaRaw = category.attributeSchema;
    }

    // Strict on required + wrong type; unknown keys are allowed and flagged.
    const schema = this.attributes.parseSchema(schemaRaw);
    const { extras } = this.attributes.validateValues(schema, dto.specifications);

    const product = await this.db.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          id: newUuidV7Bin(),
          companyId,
          categoryId,
          brand: dto.brand.trim(),
          model: dto.model.trim(),
          variant: dto.variant?.trim() || null,
          trackingType: trackingType ?? 'imei',
          specifications: (dto.specifications ?? undefined) as Prisma.InputJsonValue | undefined,
          barcode,
          defaultCost: dto.defaultCost ?? null,
          defaultPrice: dto.defaultPrice ?? null,
          reorderThreshold: dto.reorderThreshold ?? 0,
        },
      });

      await this.audit.recordTx(tx, {
        entityType: 'Product',
        entityId: created.id,
        action: 'create',
        after: {
          brand: created.brand,
          model: created.model,
          trackingType: created.trackingType,
          ...(extras.length ? { attributesForReview: extras } : {}),
        },
      });

      /**
       * A product's barcode becomes a recognition alias. Queued in the SAME
       * transaction as the product, so a crash cannot leave a product whose
       * barcode the scanner never learned.
       */
      if (created.barcode) {
        await this.outbox.enqueueTx(tx as never, [
          {
            companyId,
            // Catalog creation has no purchase; the unique event key is
            // (company, null, barcode, code), so re-creating the same barcode
            // alias is a no-op rather than duplicate evidence.
            purchaseId: null,
            codeType: 'barcode',
            code: created.barcode,
            productId: created.id,
            source: 'manual',
          },
        ]);
      }

      return created;
    });

    await this.outbox.processNow();
    return product;
  }

  /**
   * Resolve a reusable product template into a confirm-card. Lookup order:
   * explicit productId → company barcode. Returns null (client shows search)
   * when nothing matches. The 2C.5c scanner feeds recognized ids/barcodes here.
   */
  async findOrSuggest(params: { productId?: string; barcode?: string }): Promise<ProductSuggestion | null> {
    let product: Product | null = null;
    if (params.productId) {
      product = await this.db.product.findFirst({ where: { id: uuidToBin(params.productId), deletedAt: null } });
    } else if (params.barcode) {
      product = await this.db.product.findFirst({ where: { barcode: params.barcode, deletedAt: null } });
    }
    return product ? this.toSuggestion(product) : null;
  }

  private toSuggestion(p: Product): ProductSuggestion {
    return {
      productId: binToUuid(p.id),
      brand: p.brand,
      model: p.model,
      variant: p.variant,
      trackingType: p.trackingType,
      keySpecifications: (p.specifications as Record<string, unknown>) ?? {},
      image: null,
      defaultCost: p.defaultCost ? Number(p.defaultCost) : null,
      defaultPrice: p.defaultPrice ? Number(p.defaultPrice) : null,
    };
  }

  // ------------------------------------------------------------- G1 browsing

  /**
   * The catalog page: server-side search, cursor pagination, and filters.
   *
   * Read-only and open to any signed-in user — Sell, Receive and Inventory all
   * need to find products. Only the WRITE paths carry `catalog.manage`.
   *
   * Archived (`deleted_at`) products are excluded by default, which is exactly
   * what the receiving and product-creation selectors want; a manager can ask
   * for `inactive` or `all` explicitly.
   */
  async listPage(query: ListProductsDto): Promise<{
    rows: ProductListRow[];
    nextCursor: string | null;
    totalActive: number;
  }> {
    const limit = query.limit ?? DEFAULT_PAGE;
    const where = this.buildWhere(query, await this.specificationMatches(query.q));

    let cursor: CatalogCursor | undefined;
    if (query.cursor) cursor = decodeCatalogCursor(query.cursor);

    const rows = await this.db.product.findMany({
      where,
      // `id` is a UUIDv7 primary key: unique, immutable and time-ordered, so
      // this is a total order and no row can be skipped or repeated.
      orderBy: { id: 'desc' },
      take: limit + 1, // one extra decides whether another page exists
      ...(cursor ? { cursor: { id: uuidToBin(cursor.id) }, skip: 1 } : {}),
      select: LIST_SELECT,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    // A count of the *filtered* set is genuinely useful ("18 accessories") and
    // cheap on an indexed, company-scoped table. It is deliberately not a count
    // of everything ever created.
    const totalActive = await this.db.product.count({ where });

    return {
      rows: page.map((p) => this.toListRow(p)),
      nextCursor: hasMore ? encodeCatalogCursor({ id: binToUuid(page[page.length - 1].id) }) : null,
      totalActive,
    };
  }

  /**
   * Ids whose adaptive `specifications` contain the term.
   *
   * Done as a raw query on purpose. Prisma's `string_contains` on a MySQL JSON
   * column needs an explicit `path`, and these specifications are
   * category-defined — the keys are not known in advance — so there is no path
   * to give. Without one the filter silently matches NOTHING, which a mocked
   * test cannot reveal; it took a live query against MySQL to see it.
   *
   * Casting the document to text and matching it is the honest equivalent of
   * "the words the user typed appear in this product's specs". The result feeds
   * back into the main query as one more `OR id IN (…)` predicate, so keyset
   * pagination and every other filter keep working unchanged. It is company
   * scoped and capped, so it can never become an unbounded scan.
   */
  private async specificationMatches(term: string | undefined): Promise<Buffer[]> {
    const q = term?.trim();
    if (!q) return [];
    // Escape the LIKE wildcards so a user typing '%' searches for a literal '%'.
    const needle = `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await this.db.$queryRaw<{ id: Buffer }[]>`
      SELECT id FROM products
      WHERE company_id = ${this.tenant.companyId()}
        AND specifications IS NOT NULL
        AND LOWER(CAST(specifications AS CHAR)) LIKE ${needle}
      LIMIT ${SPEC_SEARCH_LIMIT}
    `;
    return rows.map((r) => r.id);
  }

  private buildWhere(query: ListProductsDto, specIds: Buffer[] = []): Prisma.ProductWhereInput {
    const where: Prisma.ProductWhereInput = {};

    const active = query.active ?? 'active';
    if (active === 'active') where.deletedAt = null;
    else if (active === 'inactive') where.deletedAt = { not: null };

    if (query.categoryId) where.categoryId = uuidToBin(query.categoryId);
    if (query.trackingType) where.trackingType = query.trackingType;

    const term = query.q?.trim();
    if (term) {
      // Exact-variant search: the fields a person actually types. Storage and
      // colour live inside `specifications`, which is matched separately by
      // `specificationMatches` and joined in here as an id list.
      where.OR = [
        { brand: { contains: term } },
        { model: { contains: term } },
        { variant: { contains: term } },
        { barcode: { contains: term } },
        ...(specIds.length ? [{ id: { in: specIds } }] : []),
      ];
    }
    return where;
  }

  /**
   * One product in full, for the detail screen.
   *
   * Includes a stock summary **only for branches the caller is assigned to**, so
   * the response cannot become a company-wide stock report for someone with one
   * branch. Individual IMEIs are deliberately absent — unit lists stay on the
   * separately paginated, permission-checked inventory endpoints.
   */
  async getDetail(idStr: string): Promise<ProductDetail> {
    const product = await this.requireProduct(idStr);
    const branchIds = await this.accessibleBranchIds();

    const [units, stock, lastSale] = await Promise.all([
      // Serialized: count in-stock units per accessible branch.
      this.db.unit.groupBy({
        by: ['branchId'],
        where: { productId: product.id, status: 'in_stock', branchId: { in: branchIds } },
        _count: { _all: true },
      }),
      // Quantity: the per-branch stock row, which also carries its own price.
      this.db.stockItem.findMany({
        where: { productId: product.id, branchId: { in: branchIds } },
        select: { branchId: true, quantity: true, price: true },
      }),
      this.db.saleItem.findFirst({
        where: { productId: product.id },
        orderBy: { id: 'desc' },
        select: { price: true, sale: { select: { soldAt: true } } },
      }),
    ]);

    const branches = await this.db.branch.findMany({
      where: { id: { in: branchIds } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(branches.map((b) => [b.id.toString('hex'), b.name]));

    const serialized = product.trackingType !== 'quantity';
    const stockByBranch = serialized
      ? units.map((u) => ({
          branchId: binToUuid(u.branchId),
          branchName: nameOf.get(u.branchId.toString('hex')) ?? '',
          quantity: u._count._all,
          price: null as number | null,
        }))
      : stock.map((s) => ({
          branchId: binToUuid(s.branchId),
          branchName: nameOf.get(s.branchId.toString('hex')) ?? '',
          quantity: s.quantity,
          price: Number(s.price),
        }));

    return {
      ...this.toListRow(product),
      specifications: (product.specifications as Record<string, unknown>) ?? {},
      categoryName: product.category?.name ?? null,
      reorderThreshold: product.reorderThreshold,
      canChangeTracking: !(await this.hasHistory(product.id)),
      stockByBranch,
      totalStock: stockByBranch.reduce((sum, s) => sum + s.quantity, 0),
      // The existing authoritative fallback price. G1 displays it; it does not
      // introduce a competing source, and editing it is the Pricing phase.
      defaultPrice: product.defaultPrice === null ? null : Number(product.defaultPrice),
      // `defaultCost` is stripped downstream by the cost-gating interceptor for
      // anyone without `cost.view`, exactly as everywhere else.
      defaultCost: product.defaultCost === null ? null : Number(product.defaultCost),
      lastSoldPrice: lastSale ? Number(lastSale.price) : null,
      lastSoldAt: lastSale?.sale?.soldAt ? lastSale.sale.soldAt.toISOString() : null,
      createdAt: product.createdAt.toISOString(),
      updatedAt: product.updatedAt.toISOString(),
    };
  }

  // -------------------------------------------------------------- G1 writing

  /**
   * Edit product METADATA. Never touches stock, units or sale history, and has
   * no price field at all — see {@link UpdateProductDto}.
   */
  async update(idStr: string, dto: UpdateProductDto): Promise<ProductDetail> {
    const before = await this.requireProduct(idStr);
    const data: Prisma.ProductUpdateInput = {};
    const changed: string[] = [];

    if (dto.brand !== undefined && dto.brand !== before.brand) {
      if (!dto.brand) throw new BadRequestException('Brand cannot be empty');
      data.brand = dto.brand;
      changed.push('brand');
    }
    if (dto.model !== undefined && dto.model !== before.model) {
      if (!dto.model) throw new BadRequestException('Model cannot be empty');
      data.model = dto.model;
      changed.push('model');
    }
    if (dto.variant !== undefined) {
      const next = dto.variant || null; // '' clears it
      if (next !== before.variant) {
        data.variant = next;
        changed.push('variant');
      }
    }
    if (dto.reorderThreshold !== undefined && dto.reorderThreshold !== before.reorderThreshold) {
      data.reorderThreshold = dto.reorderThreshold;
      changed.push('reorderThreshold');
    }

    if (dto.specifications !== undefined) {
      this.assertSpecificationsSafe(dto.specifications);
      data.specifications = dto.specifications as Prisma.InputJsonValue;
      changed.push('specifications');
    }

    if (dto.categoryId !== undefined) {
      const nextId = dto.categoryId === null ? null : uuidToBin(dto.categoryId);
      if (nextId) {
        const category = await this.db.productCategory.findUnique({ where: { id: nextId } });
        if (!category) throw new NotFoundException('Category not found');
      }
      const sameCategory =
        (nextId === null && before.categoryId === null) ||
        (nextId !== null && before.categoryId !== null && nextId.equals(before.categoryId));
      if (!sameCategory) {
        data.category = nextId ? { connect: { id: nextId } } : { disconnect: true };
        changed.push('categoryId');
      }
    }

    // Tracking mode decides how stock is counted. Once anything has been
    // received, purchased or sold under it, changing it would silently
    // reinterpret existing history.
    if (dto.trackingType !== undefined && dto.trackingType !== before.trackingType) {
      if (await this.hasHistory(before.id)) {
        throw new ConflictException(
          'Tracking mode cannot change once this product has stock, purchase or sale history. Create a new product instead.',
        );
      }
      data.trackingType = dto.trackingType;
      changed.push('trackingType');
    }

    let newBarcode: string | null | undefined;
    if (dto.barcode !== undefined) {
      newBarcode = this.normalizeBarcode(dto.barcode);
      if (newBarcode !== before.barcode) {
        if (newBarcode) await this.assertBarcodeFree(newBarcode, before.id);
        data.barcode = newBarcode;
        changed.push('barcode');
      } else {
        newBarcode = undefined; // unchanged
      }
    }

    if (changed.length === 0) throw new BadRequestException('No changes were provided');

    await this.db.$transaction(async (tx) => {
      await tx.product.update({ where: { id: before.id }, data });

      /*
       * Keep scanner learning honest. A barcode that moved away from this
       * product must stop resolving to it, or the next scan of the OLD code
       * would confidently open the wrong product. The old alias is removed and
       * the new one queued in the same transaction as the edit.
       */
      if (newBarcode !== undefined) {
        if (before.barcode) {
          await tx.productRecognition.deleteMany({
            where: { codeType: 'barcode', code: before.barcode, productId: before.id },
          });
        }
        if (newBarcode) {
          await this.outbox.enqueueTx(tx as never, [
            {
              companyId: this.tenant.companyId(),
              purchaseId: null,
              codeType: 'barcode',
              code: newBarcode,
              productId: before.id,
              source: 'manual',
            },
          ]);
        }
      }

      // Re-read rather than merging the Prisma input: `data` uses relation
      // syntax (`category.connect`), so the row is the only honest "after".
      const after = await tx.product.findUniqueOrThrow({ where: { id: before.id } });
      await this.audit.recordTx(tx, {
        entityType: 'Product',
        entityId: before.id,
        action: 'update',
        before: this.auditable(before, changed),
        after: this.auditable(after, changed),
      });
    });

    if (newBarcode) await this.outbox.processNow();
    return this.getDetail(idStr);
  }

  /**
   * Archive or restore a product. **Never a hard delete** — history must stay
   * readable and stock must stay sellable.
   *
   * Archiving sets `deleted_at`, which removes the product from the catalog
   * selectors (list/search/suggest all filter it) while Inventory, Sell,
   * Receive and Scanner keep working on existing stock, because none of them
   * filter on it. Restoring clears the timestamp.
   */
  async setActive(idStr: string, active: boolean): Promise<ProductDetail> {
    const product = await this.requireProduct(idStr, { includeArchived: true });
    const isActive = product.deletedAt === null;
    if (isActive === active) return this.getDetail(idStr); // idempotent

    await this.db.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: product.id },
        data: { deletedAt: active ? null : new Date() },
      });
      await this.audit.recordTx(tx, {
        entityType: 'Product',
        entityId: product.id,
        action: 'status_change',
        before: { isActive },
        after: { isActive: active },
        reason: active ? 'Product restored to the catalog' : 'Product archived (existing stock still sells)',
      });
    });

    return this.getDetail(idStr);
  }

  // ------------------------------------------------------------- G1 internals

  private async requireProduct(idStr: string, opts: { includeArchived?: boolean } = {}) {
    if (!isUuid(idStr)) throw new NotFoundException('Product not found');
    const product = await this.db.product.findFirst({
      where: { id: uuidToBin(idStr), ...(opts.includeArchived ? {} : {}) },
      include: { category: { select: { name: true } } },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  /** Any stock, purchase or sale history that a tracking-mode change would reinterpret. */
  private async hasHistory(productId: Buffer): Promise<boolean> {
    const [units, stock, purchases, sales] = await Promise.all([
      this.db.unit.count({ where: { productId } }),
      this.db.stockItem.count({ where: { productId } }),
      this.db.purchaseItem.count({ where: { productId } }),
      this.db.saleItem.count({ where: { productId } }),
    ]);
    return units + stock + purchases + sales > 0;
  }

  /** Branches the caller is actually assigned to — the stock-summary boundary. */
  private async accessibleBranchIds(): Promise<Buffer[]> {
    const userId = this.cls.get('userId');
    if (!userId) return [];
    const assignments = await this.db.userBranch.findMany({
      where: { userId: uuidToBin(userId) },
      select: { branchId: true },
    });
    return assignments.map((a) => a.branchId);
  }

  private toListRow(p: {
    id: Buffer;
    brand: string;
    model: string;
    variant: string | null;
    trackingType: TrackingType;
    barcode: string | null;
    categoryId: Buffer | null;
    deletedAt: Date | null;
  }): ProductListRow {
    return {
      id: binToUuid(p.id),
      brand: p.brand,
      model: p.model,
      variant: p.variant,
      // The exact-variant label, assembled once here so every screen agrees.
      label: [p.brand, p.model, p.variant].filter(Boolean).join(' '),
      trackingType: p.trackingType,
      serialized: p.trackingType !== 'quantity',
      barcode: p.barcode,
      categoryId: p.categoryId ? binToUuid(p.categoryId) : null,
      isActive: p.deletedAt === null,
    };
  }

  /** Only the fields the request touched, and never a price or a cost. */
  private auditable(row: Product, changed: string[]): Prisma.InputJsonValue {
    const all: Record<string, unknown> = {
      brand: row.brand,
      model: row.model,
      variant: row.variant,
      trackingType: row.trackingType,
      barcode: row.barcode,
      categoryId: row.categoryId ? binToUuid(row.categoryId) : null,
      reorderThreshold: row.reorderThreshold,
      specifications: row.specifications,
    };
    const out: Record<string, unknown> = {};
    for (const key of changed) if (key in all) out[key] = all[key];
    return out as Prisma.InputJsonValue;
  }

  search(q: string): Promise<Product[]> {
    const term = (q ?? '').trim();
    if (!term) return Promise.resolve([]);
    return this.db.product.findMany({
      where: {
        deletedAt: null,
        OR: [
          { brand: { contains: term } },
          { model: { contains: term } },
          { variant: { contains: term } },
        ],
      },
      take: 50,
    });
  }

  /**
   * Recognize a product from an IMEI: validate → TAC → global `tac_catalog`
   * lookup → match against the company's own catalog. Never blocks; returns a
   * best-effort suggestion the client confirms (WF3).
   */
  async recognize(imei: string) {
    if (!isValidImei(imei)) {
      throw new BadRequestException('Invalid IMEI (must be 15 digits, Luhn-valid)');
    }
    const tac = tacOf(imei);
    const tacEntry = await this.db.tacCatalog.findUnique({ where: { tac } });

    let matches: Product[] = [];
    if (tacEntry?.brand && tacEntry?.model) {
      matches = await this.db.product.findMany({
        where: { deletedAt: null, brand: tacEntry.brand, model: tacEntry.model },
        take: 5,
      });
    }

    return {
      imei,
      tac,
      known: Boolean(tacEntry),
      suggestion: tacEntry
        ? {
            brand: tacEntry.brand,
            model: tacEntry.model,
            variant: tacEntry.defaultVariant,
            productId: matches.length === 1 ? binToUuid(matches[0].id) : null,
          }
        : null,
      matches,
    };
  }
}
