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
 * The company's recognition memory. `resolve()` reads the learned mapping;
 * `learn()` records confirmations/corrections and maintains the statistics that
 * a pluggable ConfidenceScorer consumes (0010).
 *
 * Guarantees:
 *  - Confidence is delegated to CONFIDENCE_SCORER — never hardcoded here.
 *  - Every learn emits an append-only audit event → observations never lost.
 *  - A correction re-points the aggregate but preserves the prior mapping in
 *    the event; it never hard-deletes.
 */
/** The subset of Prisma the learning path touches — request client or a tx. */
type LearningTxClient = {
  productRecognition: {
    findFirst: (args: unknown) => Promise<any>;
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

  async resolve(codeType: CodeType, code: string): Promise<RecognitionMatch | null> {
    const row = await this.db.productRecognition.findFirst({ where: { codeType, code } });
    return row ? { productId: row.productId, signals: this.signalsOf(row) } : null;
  }

  confidenceOf(signals: RecognitionSignals): number {
    return this.scorer.score(signals);
  }

  /**
   * Record a confirmed code -> product association.
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
    const existing = await db.productRecognition.findFirst({
      where: { codeType: ev.codeType, code: ev.code, companyId },
    });

    // New mapping — first time this code is taught.
    if (!existing) {
      const id = newUuidV7Bin();
      await db.productRecognition.create({
        data: {
          id,
          companyId,
          codeType: ev.codeType,
          code: ev.code,
          productId: ev.productId,
          timesSeen: 1,
          confirmations: 1,
          corrections: 0,
          lastSeenAt: now,
          lastConfirmedAt: now,
          sourceStats: this.bumpSource(null, ev.source),
        },
      });
      await this.recordEvent(id, `learned:${ev.source}`, null, ev.productId, ev.supplierId);
      return;
    }

    // Reinforcement — same code confirms the same product.
    if (existing.productId.equals(ev.productId)) {
      await db.productRecognition.update({
        where: { id: existing.id },
        data: {
          timesSeen: { increment: 1 },
          confirmations: { increment: 1 },
          lastSeenAt: now,
          lastConfirmedAt: now,
          sourceStats: this.bumpSource(existing.sourceStats, ev.source),
        },
      });
      await this.recordEvent(existing.id, `reinforce:${ev.source}`, ev.productId, ev.productId, ev.supplierId);
      return;
    }

    // Correction — same code now maps to a different product. The aggregate
    // follows the newest decision (confirmations reset for the new mapping;
    // corrections is cumulative — a "confusing code" signal). The prior mapping
    // survives as an append-only event.
    await this.recordEvent(existing.id, `correction:${ev.source}`, existing.productId, ev.productId, ev.supplierId);
    await db.productRecognition.update({
      where: { id: existing.id },
      data: {
        productId: ev.productId,
        timesSeen: { increment: 1 },
        confirmations: 1,
        corrections: { increment: 1 },
        lastSeenAt: now,
        lastConfirmedAt: now,
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
  ): Promise<void> {
    return this.audit.record({
      entityType: 'ProductRecognition',
      entityId,
      action: beforeProductId ? 'update' : 'create',
      reason,
      before: beforeProductId ? { productId: binToUuid(beforeProductId) } : undefined,
      after: {
        productId: binToUuid(afterProductId),
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
