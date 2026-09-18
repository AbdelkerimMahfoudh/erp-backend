import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AppClsStore } from '../common/context/request-context';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { binToUuid } from '../common/utils/uuid.util';
import { PricingService } from '../pricing/pricing.service';
import {
  assertLookupIdentifier,
  availabilityOf,
  branchDisclosure,
  NOT_AVAILABLE_HERE,
  maskIdentifier,
  normalizeIdentifier,
  variantParts,
} from './sale-selection-rules';

/**
 * The phone a sale is about to sell, found by scan, typed IMEI or the shelf.
 *
 * One answer for all three: the existing Unit, whether it can be sold here and
 * now, and the price the sale will actually charge — resolved by the same price
 * ladder `POST /sales` uses, so the screen never quotes one price and the sale
 * charges another.
 *
 * Deliberately narrow. It reads; it never creates a Product, a Unit or stock.
 * It returns no margin, no history, no staff names, no full identifier and no
 * other branch's existence or name unless the caller holds `branch.manage` — only what the person at the counter needs to decide
 * whether to hand this phone over. Cost reaches only a caller with `cost.view`.
 */
@Injectable()
export class SaleSelectionService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly pricing: PricingService,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  private may(permission: string): boolean {
    return this.cls.get('permissions')?.has(permission) ?? false;
  }

  async select(raw: string) {
    const branchId = this.tenant.requireBranchId();
    const identifier = normalizeIdentifier(raw ?? '');
    assertLookupIdentifier(identifier);

    // Company-scoped by the tenant client: another company's phone is simply
    // not found. Either IMEI, or the serial, finds the same Unit.
    const unit = await this.db.unit.findFirst({
      where: { OR: [{ imeiPrimary: identifier }, { imeiSecondary: identifier }, { serialNo: identifier }] },
      select: {
        id: true,
        status: true,
        branchId: true,
        branch: { select: { name: true } },
        cost: true,
        dateIn: true,
        imeiPrimary: true,
        imeiSecondary: true,
        serialNo: true,
        product: { select: { brand: true, model: true, variant: true, specifications: true, trackingType: true } },
      },
    });
    const canViewBranches = this.may('branch.manage');
    // Without branch.manage, "nowhere" and "another branch" are one answer, so
    // the difference cannot reveal another branch's stock.
    if (!unit) {
      throw new NotFoundException(
        canViewBranches ? { code: 'not_found', message: 'No phone in this shop has that number' } : NOT_AVAILABLE_HERE,
      );
    }
    const disclosure = branchDisclosure(unit.branchId, branchId, canViewBranches);
    if (disclosure === 'hidden') throw new NotFoundException(NOT_AVAILABLE_HERE);

    const availability = availabilityOf(unit.status, unit.branchId, branchId);
    const matchedBy =
      unit.imeiPrimary === identifier ? 'imei1' : unit.imeiSecondary === identifier ? 'imei2' : 'serial';
    // Only a phone that can be sold here gets a price: quoting one for a sold or
    // absent phone invites selling it.
    const price = availability === 'available' ? (await this.pricing.getUnitPricing(identifier)).price : null;
    const { storage, colour } = variantParts(
      unit.product.variant,
      (unit.product.specifications as Record<string, unknown> | null) ?? null,
    );

    return {
      unitId: binToUuid(unit.id),
      availability,
      status: unit.status,
      matchedBy,
      identifierMasked: maskIdentifier(identifier),
      hasSecondImei: Boolean(unit.imeiSecondary),
      product: {
        brand: unit.product.brand,
        model: unit.product.model,
        variant: unit.product.variant,
        storage,
        colour,
        trackingType: unit.product.trackingType,
      },
      price,
      /** Only for a caller with branch.manage, and only when the phone is elsewhere. */
      otherBranch: disclosure === 'shown' ? { name: unit.branch.name } : null,
      /**
       * For the seller's private summary only. `cost` is removed by the global
       * financial-fields interceptor for any caller without `cost.view`, so a
       * role that may not see cost never receives it.
       */
      cost: Number(unit.cost),
      dateIn: unit.dateIn,
    };
  }
}
