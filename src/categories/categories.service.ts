import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ProductCategory, TrackingType } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { ProductAttributesService } from '../tracking/product-attributes.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { allowedTrackingTypes, assertSelectableTrackingType } from '../tracking/tracking-modes';

/** A unique-key refusal: in this table, a shop's own category name already in use. */
const isUniqueClash = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

@Injectable()
export class CategoriesService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly attributes: ProductAttributesService,
  ) {}

  /**
   * Active only by default; pickers never show retired categories.
   *
   * Each row carries the tracking modes it allows (D223), from the same rule the
   * server enforces, so the product form offers exactly those and a correction
   * it offers is never refused.
   */
  async list(includeInactive = false): Promise<(ProductCategory & { allowedTrackingTypes: readonly TrackingType[] })[]> {
    const rows = await this.db.productCategory.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { name: 'asc' },
      take: 200,
      include: { parent: { select: { key: true } } },
    });
    return rows.map(({ parent, ...row }) => ({ ...row, allowedTrackingTypes: allowedTrackingTypes({ ...row, parent }) }));
  }

  async getById(idStr: string): Promise<ProductCategory> {
    const category = await this.db.productCategory.findUnique({ where: { id: uuidToBin(idStr) } });
    if (!category) throw new NotFoundException('Category not found');
    return category;
  }

  /**
   * A shop's own category (D223). Built-in categories are seeded with a stable
   * key and are never created here; this one has no key and its name is unique
   * among the shop's own. It may sit under a top-level category, one level
   * only, and under a built-in it recommends only a mode that parent allows.
   */
  async create(dto: CreateCategoryDto): Promise<ProductCategory> {
    assertSelectableTrackingType(dto.defaultTrackingType);
    const schema = this.attributes.validateSchema(dto.attributeSchema);
    const parent = dto.parentId ? await this.assertParent(dto.parentId) : null;
    if (parent) this.assertModeUnderParent(dto.defaultTrackingType, parent);
    const category = await this.db.productCategory
      .create({
        data: {
          id: newUuidV7Bin(),
          companyId: this.tenant.companyId(),
          name: dto.name,
          defaultTrackingType: dto.defaultTrackingType,
          attributeSchema: schema as unknown as Prisma.InputJsonValue,
          parentId: parent?.id ?? null,
        },
      })
      .catch((e) => {
        throw isUniqueClash(e) ? this.nameTaken() : e;
      });
    await this.audit.record({
      entityType: 'ProductCategory',
      entityId: category.id,
      action: 'create',
      after: { name: category.name, defaultTrackingType: category.defaultTrackingType, parentId: dto.parentId ?? null },
    });
    return category;
  }

  /** A category something may be filed under: this company's, active, and itself top-level. */
  private async assertParent(idStr: string, child?: ProductCategory): Promise<ProductCategory> {
    const parent = await this.db.productCategory.findUnique({ where: { id: uuidToBin(idStr) } });
    if (!parent) throw new NotFoundException('Parent category not found');
    if (child && parent.id.equals(child.id)) {
      throw new BadRequestException({ code: 'category_depth', message: 'A category cannot be its own parent' });
    }
    if (parent.parentId) {
      throw new BadRequestException({
        code: 'category_depth',
        message: 'Subcategories go one level deep: choose a top-level category as the parent',
      });
    }
    if (!parent.isActive) {
      throw new BadRequestException({ code: 'category_inactive', message: 'That parent category is retired' });
    }
    return parent;
  }

  /** Under a built-in parent, the recommended mode must be one that parent allows. */
  private assertModeUnderParent(mode: ProductCategory['defaultTrackingType'], parent: ProductCategory): void {
    const allowed = allowedTrackingTypes({ defaultTrackingType: mode, key: null, parent: { key: parent.key } });
    if (!allowed.includes(mode)) {
      throw new BadRequestException({
        code: 'category_mode_not_allowed',
        message: 'Under this category products are tracked by: ' + allowed.join(', ') + '.',
      });
    }
  }

  private nameTaken(): ConflictException {
    return new ConflictException({ code: 'category_name_taken', message: 'You already have a category with that name' });
  }

  async update(idStr: string, dto: UpdateCategoryDto): Promise<ProductCategory> {
    const existing = await this.getById(idStr);

    /**
     * A built-in category is shared vocabulary: its key, translated name, modes
     * and fields are the product's, the same in every shop. The Owner may hide
     * it (and show it again); anything else is a subcategory of their own.
     */
    if (existing.key) {
      const other = (['name', 'defaultTrackingType', 'attributeSchema', 'parentId'] as const).filter(
        (field) => dto[field] !== undefined,
      );
      if (other.length) {
        throw new ConflictException({
          code: 'builtin_category_fixed',
          message: 'Built-in categories can only be hidden or shown. Add a subcategory of your own instead.',
        });
      }
    }

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

    // Where it sits, and what mode it recommends there.
    let parent: ProductCategory | null = null;
    if (dto.parentId === undefined) {
      parent = existing.parentId ? await this.db.productCategory.findUnique({ where: { id: existing.parentId } }) : null;
    } else if (dto.parentId !== null) {
      parent = await this.assertParent(dto.parentId, existing);
      const children = await this.db.productCategory.count({ where: { parentId: existing.id } });
      if (children > 0) {
        throw new BadRequestException({
          code: 'category_depth',
          message: 'This category has subcategories of its own, so it stays top-level',
        });
      }
    }
    if (dto.parentId !== undefined) {
      data.parent = parent ? { connect: { id: parent.id } } : { disconnect: true };
    }
    if (parent && (dto.parentId !== undefined || dto.defaultTrackingType !== undefined)) {
      this.assertModeUnderParent(dto.defaultTrackingType ?? existing.defaultTrackingType, parent);
    }

    const category = await this.db.productCategory.update({ where: { id: existing.id }, data }).catch((e) => {
      throw isUniqueClash(e) ? this.nameTaken() : e;
    });
    await this.audit.record({
      entityType: 'ProductCategory',
      entityId: category.id,
      action: 'update',
      before: {
        name: existing.name,
        isActive: existing.isActive,
        defaultTrackingType: existing.defaultTrackingType,
        parentId: existing.parentId ? binToUuid(existing.parentId) : null,
      },
      after: {
        name: category.name,
        isActive: category.isActive,
        defaultTrackingType: category.defaultTrackingType,
        parentId: category.parentId ? binToUuid(category.parentId) : null,
      },
    });
    return category;
  }
}
