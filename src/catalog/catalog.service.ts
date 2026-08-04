import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Product, TrackingType } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { ProductAttributesService } from '../tracking/product-attributes.service';
import { RecognitionService } from '../scanner/recognition.service';
import { RecognitionOutboxService } from '../scanner/recognition-outbox.service';
import { newUuidV7Bin, binToUuid, uuidToBin } from '../common/utils/uuid.util';
import { isValidImei, tacOf } from '../inventory/imei.util';
import { CreateProductDto } from './dto/create-product.dto';

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

@Injectable()
export class CatalogService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly attributes: ProductAttributesService,
    private readonly recognition: RecognitionService,
    private readonly outbox: RecognitionOutboxService,
  ) {}

  async create(dto: CreateProductDto): Promise<Product> {
    const companyId = this.tenant.companyId();

    let categoryId: Buffer | null = null;
    let trackingType = dto.trackingType;
    let schemaRaw: unknown = null;
    if (dto.categoryId) {
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
          brand: dto.brand,
          model: dto.model,
          variant: dto.variant ?? null,
          trackingType: trackingType ?? 'imei',
          specifications: (dto.specifications ?? undefined) as Prisma.InputJsonValue | undefined,
          barcode: dto.barcode ?? null,
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

  list(): Promise<Product[]> {
    return this.db.product.findMany({
      where: { deletedAt: null },
      orderBy: [{ brand: 'asc' }, { model: 'asc' }],
      take: 200,
    });
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
