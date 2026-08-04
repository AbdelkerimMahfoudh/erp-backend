import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ProductCategory } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { ProductAttributesService } from '../tracking/product-attributes.service';
import { newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

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
    if (dto.defaultTrackingType !== undefined) data.defaultTrackingType = dto.defaultTrackingType;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.attributeSchema !== undefined) {
      data.attributeSchema = this.attributes.validateSchema(dto.attributeSchema) as unknown as Prisma.InputJsonValue;
    }

    const category = await this.db.productCategory.update({ where: { id: existing.id }, data });
    await this.audit.record({
      entityType: 'ProductCategory',
      entityId: category.id,
      action: 'update',
      before: { name: existing.name, isActive: existing.isActive },
      after: { name: category.name, isActive: category.isActive },
    });
    return category;
  }
}
