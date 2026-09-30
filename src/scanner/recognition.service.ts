import { Inject, Injectable } from '@nestjs/common';
import { CodeType, ProductRecognition, Prisma } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { newUuidV7Bin, binToUuid } from '../common/utils/uuid.util';
import {
  CONFIDENCE_SCORER,
  ConfidenceScorer,
  RecognitionSignals,
} from './confidence/confidence-scorer';

export interface RecognitionMatch {
  productId: Buffer;
  signals: RecognitionSignals;
}

/** Where a learning signal originated. Receiving is the strongest signal. */
export type LearningSource = 'receiving' | 'sale' | 'scan' | 'manual';

/**
 * One learning event: "for code X, the employee confirmed product Y". The
 * service decides whether that is a NEW mapping, a REINFORCEMENT, or a
 * CORRECTION — the caller never says. Barcode aliases (many codes → one
 * product) are natural: each distinct code is its own mapping row.
 */
export interface LearningEvent {
  codeType: CodeType;
  code: string;
  productId: Buffer;
  source: LearningSource;
  /** Optional supplier context — stamped into the event for later supplier
   *  intelligence (RecognitionSignals.supplierConsistency), no schema change. */
  supplierId?: Buffer | null;
}

/**
 * The company's recognition memory. `resolve()` reads the confirmed mapping;
 * `learn()` records what receipts, sales and scans said about a code and
 * maintains the statistics that a pluggable ConfidenceScorer consumes (0010).
 *
 * Guarantees:
 *  - Confidence is delegated to CONFIDENCE_SCORER — never hardcoded here.
 *  - Every learn emits an append-only audit event → observations never lost.
 *  - Learning is evidence, never authority: it proposes, agrees or disagrees,
 *    and never confirms a mapping or moves one to another product. That is
 *    the mapping ladder's decision (Milestone C, `TacMappingService`).
 */
/** The subset of Prisma the learning path touches — request client or a tx. */
type LearningTxClient = {
  productRecognition: {
    findMany: (args: unknown) => Promise<any[]>;
    create: (args: unknown) => Promise<any>;
    update: (args: unknown) => Promise<any>;
  };
};

@Injectable()
export class RecognitionService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    @Inject(CONFIDENCE_SCORER) private readonly scorer: ConfidenceScorer,
  ) {}

  /**
   * The authoritative mapping for a code, if this company has one.
   *
   * **Confirmed only.** A pending Employee proposal is evidence, not a
   * decision, and must never be returned here — anything reading `resolve()`
   * treats the answer as authoritative, so a proposal reaching it would be
   * auto-selected somewhere. Proposals are surfaced through
   * `mappingsForCode()`, which the caller must handle deliberately.
   */
  async resolve(codeType: CodeType, code: string): Promise<RecognitionMatch | null> {
    const row = await this.db.productRecognition.findFirst({
      where: { codeType, code, status: 'confirmed' },
    });
    return row ? { productId: row.productId, signals: this.signalsOf(row) } : null;
  }

  /**
   * Every mapping this company holds for a code — confirmed, proposed and
   * superseded alike. For the TAC resolution ladder, which has to distinguish
   * "nobody has said" from "somebody suggested, nobody agreed".
   *
   * Tenant-scoped by the extension, so another company's mappings are not
   * merely filtered out — they are unreachable.
   */
  async mappingsForCode(codeType: CodeType, code: string) {
    return this.db.productRecognition.findMany({
      where: { codeType, code },
      orderBy: { id: 'desc' },
    });
  }

  confidenceOf(signals: RecognitionSignals): number {
    return this.scorer.score(signals);
  }

  /**
   * Record what a receipt (or a sale, scan or manual choice) said about a code.
   *
   * Learning is EVIDENCE, never authority (Milestone C, docs/21). Which product
   * a code stands for is decided through the mapping ladder — an Employee
   * proposes, an Owner or Manager confirms, a replaced mapping is superseded
   * under a version — so this method never confirms anything and never moves
   * a mapping:
   *
   *  - a code the company holds no mapping for gets a PROPOSAL, which the
   *    ladder shows for review and never auto-selects;
   *  - a sighting with the product the mapping already names counts as
   *    agreement;
   *  - a sighting with another product counts as DISAGREEMENT, and the mapping
   *    keeps its product. It used to be re-pointed in place: one delivery
   *    received under the wrong product silently changed what every later
   *    scan of that model suggested, with no `catalog.manage`, no version and
   *    no superseded row.
   *
   * Every event is appended to the audit trail, so an observation is never
   * lost, and the counts stay what CONFIDENCE_SCORER reads.
   *
   * `opts` exists for the outbox worker, which runs OUTSIDE a request: there is
   * no CLS tenant context to read a company from, and the learning mutation
   * must share a transaction with marking the outbox row done — otherwise a
   * crash between the two would re-increment evidence on recovery.
   */
  async learn(
    ev: LearningEvent,
    opts?: { tx?: LearningTxClient; companyId?: Buffer },
  ): Promise<void> {
    const db = (opts?.tx ?? this.db) as LearningTxClient;
    const companyId = opts?.companyId ?? this.tenant.companyId();
    const now = new Date();

    // The mapping that stands for this code: the confirmed one, else the open
    // proposal. A superseded row is history, not a mapping.
    const standing = await db.productRecognition.findMany({
      where: { codeType: ev.codeType, code: ev.code, companyId, status: { in: ['confirmed', 'proposed'] } },
      orderBy: { id: 'desc' },
    });
    const existing = standing.find((r) => r.status === 'confirmed') ?? standing[0] ?? null;

    // Nothing held — propose. Never `confirmed`: that takes somebody with
    // `catalog.manage`, and the database refuses a confirmed row without a
    // `confirmed_at` (ck_prodrec_confirmed_fields) — which is what every
    // receipt's learning used to fail on, eight times, then give up.
    if (!existing) {
      const id = newUuidV7Bin();
      await db.productRecognition.create({
        data: {
          id,
          companyId,
          codeType: ev.codeType,
          code: ev.code,
          productId: ev.productId,
          status: 'proposed',
          evidenceSource: ev.source,
          timesSeen: 1,
          confirmations: 0,
          corrections: 0,
          lastSeenAt: now,
          sourceStats: this.bumpSource(null, ev.source),
        },
      });
      await this.recordEvent(id, `proposed:${ev.source}`, null, ev.productId, ev.supplierId);
      return;
    }

    // Agreement — the code seen again with the product it stands for. Under a
    // CONFIRMED mapping that is one more confirmation of it; a proposal only
    // accumulates sightings, so its count is never mistaken for authority.
    if (existing.productId.equals(ev.productId)) {
      const confirmed = existing.status === 'confirmed';
      await db.productRecognition.update({
        where: { id: existing.id },
        data: {
          timesSeen: { increment: 1 },
          lastSeenAt: now,
          ...(confirmed ? { confirmations: { increment: 1 }, lastConfirmedAt: now } : {}),
          sourceStats: this.bumpSource(existing.sourceStats, ev.source),
        },
      });
      await this.recordEvent(existing.id, `reinforce:${ev.source}`, ev.productId, ev.productId, ev.supplierId);
      return;
    }

    // Disagreement — the code seen with another product. The mapping stands;
    // the disagreement is counted (the "confusing code" signal the scorer
    // reads) and kept as an event naming what was seen, so a reviewer can act
    // on it. Changing the product is the ladder's decision, made on purpose.
    await this.recordEvent(existing.id, `disagreement:${ev.source}`, existing.productId, existing.productId, ev.supplierId, ev.productId);
    await db.productRecognition.update({
      where: { id: existing.id },
      data: {
        timesSeen: { increment: 1 },
        corrections: { increment: 1 },
        lastSeenAt: now,
        lastCorrectedAt: now,
        sourceStats: this.bumpSource(existing.sourceStats, ev.source),
      },
    });
  }

  private bumpSource(current: Prisma.JsonValue | null | undefined, source: LearningSource): Prisma.InputJsonValue {
    const stats: Record<string, number> =
      current && typeof current === 'object' && !Array.isArray(current)
        ? { ...(current as Record<string, number>) }
        : {};
    stats[source] = (stats[source] ?? 0) + 1;
    return stats;
  }

  private recordEvent(
    entityId: Buffer,
    reason: string,
    beforeProductId: Buffer | null,
    afterProductId: Buffer,
    supplierId?: Buffer | null,
    /** A product the code was seen with that the mapping does NOT follow. */
    observedProductId?: Buffer,
  ): Promise<void> {
    return this.audit.record({
      entityType: 'ProductRecognition',
      entityId,
      action: beforeProductId ? 'update' : 'create',
      reason,
      before: beforeProductId ? { productId: binToUuid(beforeProductId) } : undefined,
      after: {
        productId: binToUuid(afterProductId),
        ...(observedProductId ? { observedProductId: binToUuid(observedProductId) } : {}),
        ...(supplierId ? { supplierId: binToUuid(supplierId) } : {}),
      },
    });
  }

  private signalsOf(row: ProductRecognition): RecognitionSignals {
    return {
      timesSeen: row.timesSeen,
      confirmations: row.confirmations,
      corrections: row.corrections,
      lastSeenAt: row.lastSeenAt,
      lastConfirmedAt: row.lastConfirmedAt,
      lastCorrectedAt: row.lastCorrectedAt,
      sourceStats:
        row.sourceStats && typeof row.sourceStats === 'object' && !Array.isArray(row.sourceStats)
          ? (row.sourceStats as Record<string, number>)
          : {},
    };
  }
}
