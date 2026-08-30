import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normaliseSearch } from './device-catalogue';

/**
 * Reading the device catalogue.
 *
 * Reference data, so there is no tenant filter and no permission beyond being
 * signed in: "Samsung" does not differ between shops, and knowing that Samsung
 * makes phones is not a disclosure. What a *company* believes about a specific
 * code stays in `ProductRecognition`, which is company-scoped.
 *
 * Every read is served from the database rather than from the TypeScript
 * constant beside it. That is the point of migrating the rows: the catalogue
 * can be corrected and extended through guarded reference-data tooling, on a
 * running system, **without a new mobile release**. The constant is the
 * generator's source and the drift test's reference, not the runtime's.
 */
@Injectable()
export class DeviceCatalogueService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every brand a shop can pick, in display order.
   *
   * `Other brand` is an ordinary row that happens to sort last, not a special
   * case the client has to know about — so the selector needs no branch for
   * "the thing that is not in the list".
   */
  async brands(search?: string) {
    const term = search?.trim() ? normaliseSearch(search) : null;

    const rows = await this.prisma.deviceBrand.findMany({
      where: {
        isActive: true,
        ...(term ? { searchTerms: { contains: term } } : {}),
      },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
      select: { key: true, name: true, parentKey: true, displayOrder: true },
    });

    return rows.map((r) => ({
      key: r.key,
      name: r.name,
      /**
       * Recorded, and deliberately not acted on by the picker. Redmi and POCO
       * are Xiaomi's, and a shop that sells a Redmi sells a Redmi — nesting
       * them under Xiaomi would hide them from somebody searching the name
       * printed on the box.
       */
      manufacturerKey: r.parentKey,
    }));
  }

  /**
   * The models of one brand, newest first.
   *
   * Empty for an unknown brand rather than an error: an unrecognised brand key
   * means "no catalogue models", which is a state the manual-entry path already
   * handles, and a 404 here would make the selector fail where it should simply
   * offer to let somebody type.
   */
  async models(brandKey: string, search?: string) {
    const term = search?.trim() ? normaliseSearch(search) : null;

    const rows = await this.prisma.deviceModel.findMany({
      where: {
        brandKey,
        isActive: true,
        ...(term ? { searchTerms: { contains: term } } : {}),
      },
      // Newest first, then alphabetically within a release rank.
      orderBy: [{ releaseRank: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true, family: true, releaseRank: true },
    });

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      family: r.family,
      releaseRank: r.releaseRank,
    }));
  }

  /**
   * A version stamp, so a client can tell whether its cache is stale without
   * downloading the whole catalogue to find out.
   *
   * The newest `updatedAt` across both tables plus the row counts: any insert,
   * edit or retirement moves it, and nothing else does.
   */
  async version() {
    const [brandAgg, modelAgg, brandCount, modelCount] = await Promise.all([
      this.prisma.deviceBrand.aggregate({ _max: { updatedAt: true } }),
      this.prisma.deviceModel.aggregate({ _max: { updatedAt: true } }),
      this.prisma.deviceBrand.count({ where: { isActive: true } }),
      this.prisma.deviceModel.count({ where: { isActive: true } }),
    ]);

    const newest = [brandAgg._max.updatedAt, modelAgg._max.updatedAt]
      .filter((d): d is Date => d instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime())[0];

    return {
      updatedAt: newest?.toISOString() ?? null,
      brands: brandCount,
      models: modelCount,
      /**
       * Said plainly, in the payload, because a client that believes it holds
       * every phone ever made will stop offering the manual field — which is
       * the one thing that must never happen.
       */
      complete: false,
    };
  }
}
