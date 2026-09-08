import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ProductCategory } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { ProductAttributesService } from '../tracking/product-attributes.service';
import { newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { assertSelectableTrackingType } from '../tracking/tracking-modes';

@Injectable()
export class CategoriesService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly attributes: ProductAttributesService,
  ) {}

  /** Active only by default; pickers never show retired categories. */
  list(includeInactive = false): Promise<ProductCategory[]> {
    return this.db.productCategory.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { name: 'asc' },
      take: 200,
    });
  }

  async getById(idStr: string): Promise<ProductCategory> {
    const category = await this.db.productCategory.findUnique({ where: { id: uuidToBin(idStr) } });
    if (!category) throw new NotFoundException('Category not found');
    return category;
  }

  async create(dto: CreateCategoryDto): Promise<ProductCategory> {
    assertSelectableTrackingType(dto.defaultTrackingType);
    const schema = this.attributes.validateSchema(dto.attributeSchema);
    const category = await this.db.productCategory.create({
      data: {
        id: newUuidV7Bin(),
        companyId: this.tenant.companyId(),
        name: dto.name,
        defaultTrackingType: dto.defaultTrackingType,
        attributeSchema: schema as unknown as Prisma.InputJsonValue,
      },
    });
    await this.audit.record({
      entityType: 'ProductCategory',
      entityId: category.id,
      action: 'create',
      after: { name: category.name, defaultTrackingType: category.defaultTrackingType },
    });
    return category;
  }

  async update(idStr: string, dto: UpdateCategoryDto): Promise<ProductCategory> {
    const existing = await this.getById(idStr);

    const data: Prisma.ProductCategoryUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    /**
     * Changing a category's mode is the real misconfiguration risk.
     *
     * The category is what every product in it derives its intake workflow
     * from, so flipping it does not change one product — it changes the meaning
     * of all of them at once, including their existing units and stock rows.
     * A shop owner tidying up category names must not be able to turn a shelf of
     * counted accessories into things the app demands IMEIs for.
     *
     * So it may only move while the category is still empty. After that the
     * answer is a new category, which costs nothing and reinterprets nothing.
     */
    if (dto.defaultTrackingType !== undefined && dto.defaultTrackingType !== existing.defaultTrackingType) {
      assertSelectableTrackingType(dto.defaultTrackingType, existing.defaultTrackingType);
      const inUse = await this.db.product.count({ where: { categoryId: existing.id } });
      if (inUse > 0) {
        throw new ConflictException({
          code: 'category_tracking_change_blocked',
          message:
            `${inUse} product(s) already use this category, so its tracking mode cannot change from ` +
            `'${existing.defaultTrackingType}' to '${dto.defaultTrackingType}'. Create a new category instead.`,
        });
      }
      data.defaultTrackingType = dto.defaultTrackingType;
    }

    if (dto.attributeSchema !== undefined) {
      data.attributeSchema = this.attributes.validateSchema(dto.attributeSchema) as unknown as Prisma.InputJsonValue;
    }

    const category = await this.db.productCategory.update({ where: { id: existing.id }, data });
    await this.audit.record({
      entityType: 'ProductCategory',
      entityId: category.id,
      action: 'update',
      before: { name: existing.name, isActive: existing.isActive, defaultTrackingType: existing.defaultTrackingType },
      after: { name: category.name, isActive: category.isActive, defaultTrackingType: category.defaultTrackingType },
    });
    return category;
  }
}
