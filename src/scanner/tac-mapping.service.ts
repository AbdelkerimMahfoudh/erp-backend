import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { AppClsStore } from '../common/context/request-context';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { binToUuid, isUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { isValidTac, resolveTac, type CompanyMapping } from './tac-resolution';
import { isStagingEnvironment } from '../common/config/environment';

/**
 * A company teaching its own TAC→Product mapping (Milestone C).
 *
 * **The globally shared `tac_catalog` is never written here, by anybody.** It is
 * platform-controlled reference data holding generic manufacturer and model
 * only; it has no `company_id` and no `product_id`, so it cannot name one
 * tenant's product even by accident. Everything a store confirms lands in
 * `product_recognition`, which is company-scoped.
 *
 * The authority split, which is the point of the whole feature:
 *
 *   an Employee    may PROPOSE a mapping while receiving stock
 *   Owner/Manager  may CONFIRM one, or replace a confirmed one
 *
 * A proposal changes no suggestion anybody acts on. Only a confirmation does.
 */
@Injectable()
export class TacMappingService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  private has(permission: string): boolean {
    return this.cls.get('permissions')?.has(permission) ?? false;
  }

  /** Owner and Store Manager confirm; an Employee never does. */
  private canConfirm(): boolean {
    return this.has('catalog.manage');
  }

  // ──────────────────────────────── read ─────────────────────────────────

  /**
   * What this company knows about a TAC, run through the deterministic ladder.
   *
   * The global catalogue is read too, but only ever for generic identity — it
   * can never supply a product id.
   */
  async resolve(tac: string) {
    if (!isValidTac(tac)) {
      throw new BadRequestException({
        code: 'invalid_tac',
        message: 'A TAC is exactly eight digits.',
      });
    }

    const [rows, globalEntry] = await Promise.all([
      this.db.productRecognition.findMany({
        where: { codeType: 'tac', code: tac },
        include: {
          product: { select: { brand: true, model: true, variant: true } },
          proposedBy: { select: { name: true } },
          confirmedBy: { select: { name: true } },
        },
        orderBy: { id: 'desc' },
      }),
      /*
       * Synthetic fixture mappings are readable in staging and nowhere else.
       *
       * They exist so the recognition ladder can be exercised end to end
       * against the retained test shop. If those rows ever travelled — a dump
       * restored into the wrong place, a copied database — they must not become
       * suggestions somebody acts on, so the guard is here at the read rather
       * than only in the command that writes them.
       */
      this.db.tacCatalog.findFirst({
        where: {
          tac,
          isActive: true,
          ...(isStagingEnvironment() ? {} : { source: { not: 'synthetic_staging' } }),
        },
      }),
    ]);

    const mappings: CompanyMapping[] = rows.map((r) => ({
      productId: binToUuid(r.productId),
      status: r.status,
    }));

    const suggestion = resolveTac({ tac, companyMappings: mappings, globalEntry });

    /**
     * The product's own name, when a confirmed mapping named one. Taken from
     * the company's catalogue rather than the global table, because that is
     * what the shop actually calls it.
     */
    const chosen = suggestion.productId
      ? rows.find((r) => binToUuid(r.productId) === suggestion.productId)
      : null;

    return {
      tac,
      ...suggestion,
      product: chosen
        ? {
            id: binToUuid(chosen.productId),
            brand: chosen.product.brand,
            model: chosen.product.model,
            variant: chosen.product.variant,
          }
        : null,
      /** Everything held, so a reviewer can see what is being decided between. */
      mappings: rows.map((r) => ({
        id: binToUuid(r.id),
        productId: binToUuid(r.productId),
        product: [r.product.brand, r.product.model, r.product.variant]
          .filter(Boolean)
          .join(' '),
        status: r.status,
        proposedBy: r.proposedBy?.name ?? null,
        confirmedBy: r.confirmedBy?.name ?? null,
        confirmedAt: r.confirmedAt?.toISOString() ?? null,
        evidenceSource: r.evidenceSource,
        timesSeen: r.timesSeen,
        version: r.version,
      })),
    };
  }

  // ─────────────────────────────── write ─────────────────────────────────

  /**
   * Propose or confirm a mapping.
   *
   * The caller's permission decides which: an Employee's write is a proposal,
   * an Owner's or Manager's is a confirmation. The client does not choose —
   * asking it to would make "am I allowed to confirm?" a question the client
   * could answer wrongly.
   */
  async submit(dto: {
    tac: string;
    productId: string;
    evidenceSource?: string;
    /** Required when replacing an existing confirmed mapping. */
    expectedVersion?: number;
  }) {
    if (!isValidTac(dto.tac)) {
      throw new BadRequestException({
        code: 'invalid_tac',
        message: 'A TAC is exactly eight digits.',
      });
    }
    if (!isUuid(dto.productId)) throw new NotFoundException('Product not found');

    const companyId = this.tenant.companyId();
    const userId = this.tenant.userId();

    /**
     * The product must be this company's. Read through the tenant client, so a
     * forged id belonging to another company is simply not found — the same
     * 404 an unknown id produces, and no information about whose it was.
     */
    const product = await this.db.product.findFirst({
      where: { id: uuidToBin(dto.productId), deletedAt: null },
      select: { id: true },
    });
    if (!product) throw new NotFoundException('Product not found');

    const confirming = this.canConfirm();
    const existing = await this.db.productRecognition.findFirst({
      where: { codeType: 'tac', code: dto.tac, status: 'confirmed' },
    });

    // ── An Employee proposes ────────────────────────────────────────────
    if (!confirming) {
      if (existing) {
        /**
         * A confirmed mapping already exists and this caller cannot replace it.
         * Refused rather than silently stored: a proposal that can never be
         * seen is worse than being told who to ask.
         */
        throw new ForbiddenException({
          code: 'already_confirmed',
          message: 'This model is already confirmed for that code. Ask an owner or manager to change it.',
        });
      }
      const id = newUuidV7Bin();
      await this.db.productRecognition.create({
        data: {
          id,
          companyId,
          codeType: 'tac',
          code: dto.tac,
          productId: product.id,
          status: 'proposed',
          proposedById: userId ?? null,
          evidenceSource: dto.evidenceSource ?? 'receiving',
          // A proposal is not a sighting of a confirmed mapping.
          timesSeen: 1,
          confirmations: 0,
        },
      });
      await this.audit.record({
        entityType: 'ProductRecognition',
        entityId: id,
        action: 'create',
        after: { tac: dto.tac, productId: dto.productId, status: 'proposed' },
      });
      return this.resolve(dto.tac);
    }

    // ── An Owner or Manager confirms ────────────────────────────────────

    if (existing) {
      /**
       * Replacing a confirmed mapping. Guarded on version, so two managers
       * deciding at once produce ONE winner — and the loser is told to look
       * again rather than silently overwriting the other's decision.
       */
      if (dto.expectedVersion === undefined) {
        throw new ConflictException({
          code: 'confirmation_exists',
          message: 'This code is already confirmed for a product. Send the version you saw to replace it.',
        });
      }
      const superseded = await this.db.productRecognition.updateMany({
        where: { id: existing.id, version: dto.expectedVersion, status: 'confirmed' },
        data: { status: 'superseded', version: { increment: 1 } },
      });
      if (superseded.count === 0) {
        throw new ConflictException({
          code: 'refresh_required',
          message: 'That mapping changed while you were looking at it. Open it again.',
        });
      }
      // The old row is kept, never deleted: what the shop once believed about
      // this code is part of the record.
    }

    const id = newUuidV7Bin();
    await this.db.productRecognition.create({
      data: {
        id,
        companyId,
        codeType: 'tac',
        code: dto.tac,
        productId: product.id,
        status: 'confirmed',
        confirmedById: userId ?? null,
        confirmedAt: new Date(),
        evidenceSource: dto.evidenceSource ?? 'manual',
        timesSeen: 1,
        confirmations: 1,
        lastConfirmedAt: new Date(),
      },
    });

    await this.audit.record({
      entityType: 'ProductRecognition',
      entityId: id,
      action: existing ? 'status_change' : 'create',
      after: {
        tac: dto.tac,
        productId: dto.productId,
        status: 'confirmed',
        replaced: existing ? binToUuid(existing.id) : null,
      },
    });

    return this.resolve(dto.tac);
  }
}
