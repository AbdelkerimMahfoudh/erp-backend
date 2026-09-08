import { BadRequestException, ConflictException } from '@nestjs/common';
import { TrackingType } from '@prisma/client';
import { CategoriesService } from './categories.service';
import { ProductAttributesService } from '../tracking/product-attributes.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

/**
 * The category is where the intake workflow is decided, so it is also where a
 * misconfiguration does the most damage: changing it does not affect one
 * product, it changes what every product in the category means at once.
 */

const COMPANY = Buffer.alloc(16, 1);

function makeService(seed: { categories?: any[]; productsPerCategory?: number } = {}) {
  const categories = seed.categories ?? [];
  const audits: any[] = [];

  const db: any = {
    productCategory: {
      findMany: jest.fn(async () => categories),
      /*
       * A COPY, as Prisma returns. Handing back the stored object would let a
       * later `update` mutate what the service is holding as "before", which
       * would quietly make any before/after audit assertion vacuous.
       */
      findUnique: jest.fn(async ({ where }: any) => {
        const row = categories.find((c) => c.id.equals(where.id));
        return row ? { ...row } : null;
      }),
      create: jest.fn(async ({ data }: any) => (categories.push(data), data)),
      update: jest.fn(async ({ where, data }: any) => {
        const row = categories.find((c) => c.id.equals(where.id));
        Object.assign(row, data);
        return row;
      }),
    },
    product: { count: jest.fn(async () => seed.productsPerCategory ?? 0) },
  };
  const tenant: any = { companyId: () => COMPANY };
  const audit: any = { record: jest.fn(async (e: any) => audits.push(e)) };

  const service = new CategoriesService(db, tenant, audit, new ProductAttributesService());
  return { service, categories, audits, db };
}

const category = (over: Partial<any> = {}) => ({
  id: Buffer.alloc(16, 9),
  companyId: COMPANY,
  name: 'Accessories',
  defaultTrackingType: TrackingType.quantity,
  attributeSchema: null,
  isActive: true,
  ...over,
});

const createDto = (over: Partial<CreateCategoryDto> = {}): CreateCategoryDto =>
  ({ name: 'Laptops', defaultTrackingType: TrackingType.quantity, ...over }) as CreateCategoryDto;

describe('creating a category', () => {
  it('accepts the two modes the product offers', async () => {
    for (const mode of [TrackingType.imei, TrackingType.quantity]) {
      const { service, categories } = makeService();
      await service.create(createDto({ defaultTrackingType: mode }));
      expect(categories[0].defaultTrackingType).toBe(mode);
    }
  });

  it('refuses serial, which is no longer a selectable workflow', async () => {
    const { service, categories } = makeService();
    await expect(service.create(createDto({ defaultTrackingType: TrackingType.serial }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(categories).toHaveLength(0);
  });

  it('records the mode it was created with, so the choice is auditable', async () => {
    const { service, audits } = makeService();
    await service.create(createDto({ defaultTrackingType: TrackingType.imei }));
    expect(audits[0].after).toMatchObject({ defaultTrackingType: 'imei' });
  });
});

describe('changing a category tracking mode', () => {
  it('allows it while no product uses the category', async () => {
    const cat = category();
    const { service } = makeService({ categories: [cat], productsPerCategory: 0 });

    await service.update(cat.id.toString('hex'), {
      defaultTrackingType: TrackingType.imei,
    } as UpdateCategoryDto);

    expect(cat.defaultTrackingType).toBe('imei');
  });

  /**
   * The accident this exists to stop: an owner tidying up categories turning a
   * shelf of counted accessories into things the app demands IMEIs for.
   */
  it('refuses once products already use the category', async () => {
    const cat = category();
    const { service } = makeService({ categories: [cat], productsPerCategory: 12 });

    await expect(
      service.update(cat.id.toString('hex'), { defaultTrackingType: TrackingType.imei } as UpdateCategoryDto),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(cat.defaultTrackingType).toBe('quantity');
  });

  it('says how many products are affected, and offers the safe alternative', async () => {
    const cat = category();
    const { service } = makeService({ categories: [cat], productsPerCategory: 12 });

    await expect(
      service.update(cat.id.toString('hex'), { defaultTrackingType: TrackingType.imei } as UpdateCategoryDto),
    ).rejects.toMatchObject({ response: { code: 'category_tracking_change_blocked' } });
  });

  it('refuses moving to serial even on an empty category', async () => {
    const cat = category();
    const { service } = makeService({ categories: [cat], productsPerCategory: 0 });

    await expect(
      service.update(cat.id.toString('hex'), { defaultTrackingType: TrackingType.serial } as UpdateCategoryDto),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  /**
   * A category stored as `serial` before the rule keeps working. Renaming it
   * must not fail merely because its mode is no longer selectable.
   */
  it('lets a historical serial category be renamed without touching its mode', async () => {
    const cat = category({ defaultTrackingType: TrackingType.serial, name: 'Old TVs' });
    const { service } = makeService({ categories: [cat], productsPerCategory: 40 });

    await service.update(cat.id.toString('hex'), { name: 'Televisions' } as UpdateCategoryDto);

    expect(cat.name).toBe('Televisions');
    expect(cat.defaultTrackingType).toBe('serial');
  });

  it('lets an unchanged mode be resent without complaint', async () => {
    const cat = category({ defaultTrackingType: TrackingType.serial });
    const { service } = makeService({ categories: [cat], productsPerCategory: 40 });

    await service.update(cat.id.toString('hex'), {
      defaultTrackingType: TrackingType.serial,
    } as UpdateCategoryDto);

    expect(cat.defaultTrackingType).toBe('serial');
  });

  it('records the mode change in the audit trail', async () => {
    const cat = category();
    const { service, audits } = makeService({ categories: [cat], productsPerCategory: 0 });

    await service.update(cat.id.toString('hex'), { defaultTrackingType: TrackingType.imei } as UpdateCategoryDto);

    expect(audits[0].before).toMatchObject({ defaultTrackingType: 'quantity' });
    expect(audits[0].after).toMatchObject({ defaultTrackingType: 'imei' });
  });

  it('does not consult the product count when the mode is not changing', async () => {
    const cat = category();
    const { service, db } = makeService({ categories: [cat], productsPerCategory: 12 });

    await service.update(cat.id.toString('hex'), { name: 'Cables' } as UpdateCategoryDto);

    expect(db.product.count).not.toHaveBeenCalled();
  });
});
