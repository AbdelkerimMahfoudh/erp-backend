import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';

/** The transaction client the tenant-extended Prisma actually hands back. */
type Tx = Parameters<Parameters<TenantPrisma['$transaction']>[0]>[0];
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { readSheet } from './sheet-reader';
import {
  guessMapping,
  kindOf,
  missingRequirements,
  type HeaderGuess,
  type ImportField,
  type ImportKind,
} from './column-mapping';
import { summarise, validateRow, type RowVerdict } from './row-validation';

/**
 * Bringing a shop's existing stock list in (Milestone G).
 *
 * Two phases, and the separation is the whole product value:
 *
 *   **Preview** reads the file, guesses what the columns mean, checks every row
 *   and writes NOTHING to inventory. The shop sees "197 will be added, 3
 *   cannot, and here is why".
 *
 *   **Commit** creates stock from the rows that passed, using the mapping the
 *   shop already approved — never a fresh guess, or they would approve one
 *   interpretation and receive another.
 *
 * A bad row fails alone. 200 phones with three mistyped IMEIs gives 197 phones
 * and three things to fix; refusing the file would send somebody back to the
 * notebook.
 */
@Injectable()
export class ImportsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
  ) {}

  /** Read a file, decide every row, and write only the preview. */
  async preview(file: { buffer: Buffer; originalname: string }, clientUuid?: string) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.userId() ?? null;

    if (clientUuid) {
      // An offline retry must not import the same file twice.
      const replay = await this.db.importBatch.findFirst({
        where: { clientUuid: uuidToBin(clientUuid) },
      });
      if (replay) return this.get(binToUuid(replay.id));
    }

    const sheet = await readSheet(file.buffer, file.originalname);
    if (sheet.rows.length < 2) {
      throw new BadRequestException('That file has a header but no rows');
    }

    const [headers, ...body] = sheet.rows;
    const mapping = guessMapping(headers);
    const problems = missingRequirements(mapping);
    const kind = kindOf(mapping);

    const batchId = newUuidV7Bin();

    /**
     * A file whose columns cannot be understood is recorded as `failed` rather
     * than refused outright. The shop can then see WHICH columns were found and
     * which were missing — a bare 400 tells them nothing about their own file.
     */
    if (problems.length > 0 || !kind) {
      await this.db.importBatch.create({
        data: {
          id: batchId,
          companyId,
          branchId,
          userId,
          fileRef: '',
          originalFilename: file.originalname,
          status: 'failed',
          mapping: mapping as unknown as Prisma.InputJsonValue,
          totalRows: body.length,
          clientUuid: clientUuid ? uuidToBin(clientUuid) : null,
        },
      });
      return {
        ...(await this.get(binToUuid(batchId))),
        problems,
      };
    }

    const verdicts = await this.decideRows(body, mapping, kind);

    const counts = summarise(verdicts.map((v) => v.verdict));
    await this.db.$transaction(async (tx) => {
      await tx.importBatch.create({
        data: {
          id: batchId,
          companyId,
          branchId,
          userId,
          fileRef: '',
          originalFilename: file.originalname,
          status: 'preview',
          kind,
          mapping: mapping as unknown as Prisma.InputJsonValue,
          totalRows: counts.total,
          validRows: counts.valid,
          warningRows: counts.warning,
          errorRows: counts.error,
          clientUuid: clientUuid ? uuidToBin(clientUuid) : null,
        },
      });
      await tx.importRow.createMany({
        data: verdicts.map((v) => ({
          id: newUuidV7Bin(),
          companyId,
          batchId,
          rowNumber: v.rowNumber,
          raw: v.raw as unknown as Prisma.InputJsonValue,
          parsed: v.verdict.parsed as unknown as Prisma.InputJsonValue,
          status: v.verdict.status,
          message: v.verdict.messages.join(' · ') || null,
          identifier: v.identifier,
        })),
      });
    });

    return { ...(await this.get(binToUuid(batchId))), source: sheet.source, delimiter: sheet.delimiter };
  }

  async get(id: string) {
    const branchId = this.tenant.requireBranchId();
    const batch = await this.db.importBatch.findFirst({
      where: { id: uuidToBin(id), branchId },
      include: { rows: { orderBy: { rowNumber: 'asc' }, take: 500 } },
    });
    if (!batch) throw new NotFoundException('No such import');

    return {
      id: binToUuid(batch.id),
      filename: batch.originalFilename,
      status: batch.status,
      kind: batch.kind,
      mapping: batch.mapping,
      counts: {
        total: batch.totalRows,
        valid: batch.validRows,
        warning: batch.warningRows,
        error: batch.errorRows,
        /** Valid AND warning both import — that is what a warning means. */
        willImport: batch.validRows + batch.warningRows,
        imported: batch.importedRows,
      },
      committedAt: batch.committedAt,
      version: batch.version,
      /**
       * Problem rows first. Somebody opening a preview of 200 rows wants the 3
       * that need attention, not to scroll for them.
       */
      rows: [...batch.rows]
        .sort((a, b) => rank(a.status) - rank(b.status) || a.rowNumber - b.rowNumber)
        .map((r) => ({
          rowNumber: r.rowNumber,
          status: r.status,
          message: r.message,
          identifier: r.identifier,
          parsed: r.parsed,
          createdId: r.createdEntityId ? binToUuid(r.createdEntityId) : null,
        })),
    };
  }

  async list() {
    const branchId = this.tenant.requireBranchId();
    const rows = await this.db.importBatch.findMany({
      where: { branchId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return {
      rows: rows.map((b) => ({
        id: binToUuid(b.id),
        filename: b.originalFilename,
        status: b.status,
        kind: b.kind,
        total: b.totalRows,
        imported: b.importedRows,
        createdAt: b.createdAt,
        committedAt: b.committedAt,
      })),
    };
  }

  /**
   * Create the stock, from the rows that passed and the mapping already shown.
   *
   * Error rows are skipped, never guessed at. Everything runs in one
   * transaction so a failure halfway leaves no half-imported shop.
   */
  async commit(id: string, expectedVersion?: number) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.userId();
    if (!userId) throw new BadRequestException('No authenticated user');

    const batch = await this.db.importBatch.findFirst({
      where: { id: uuidToBin(id), branchId },
      include: { rows: true },
    });
    if (!batch) throw new NotFoundException('No such import');
    if (batch.status === 'committed') {
      throw new ConflictException('That import has already been brought in');
    }
    if (batch.status !== 'preview') {
      throw new BadRequestException('That file could not be read, so there is nothing to bring in');
    }
    if (expectedVersion != null && expectedVersion !== batch.version) {
      throw new ConflictException('refresh_required: this import changed while you were reviewing it');
    }

    const importable = batch.rows.filter((r) => r.status !== 'error');
    if (importable.length === 0) {
      throw new BadRequestException('Every row has a problem, so there is nothing to bring in');
    }

    const kind = batch.kind as ImportKind;
    const now = new Date();

    const created = await this.db.$transaction(async (tx) => {
      /**
       * The version guard is inside the transaction and part of the write, so
       * two people committing the same batch produce one import and one 409 —
       * never two sets of stock from one file.
       */
      const won = await tx.importBatch.updateMany({
        where: { id: batch.id, version: batch.version, status: 'preview' },
        data: { version: { increment: 1 } },
      });
      if (won.count === 0) {
        throw new ConflictException('refresh_required: this import was already being brought in');
      }

      let count = 0;
      for (const row of importable) {
        const parsed = (row.parsed ?? {}) as Record<string, unknown>;
        const productId = await this.findOrCreateProduct(tx, companyId, parsed, kind);

        if (kind === 'quantity') {
          const qty = Number(parsed.quantity ?? 0);
          /**
           * Quantity stock MERGES rather than duplicating. Importing 50 cables
           * when the shop already has 20 means 70 cables, not two rows nobody
           * can reconcile — the same rule the transfer draft follows.
           */
          const existing = await tx.stockItem.findFirst({ where: { productId, branchId } });
          const stockId = existing?.id ?? newUuidV7Bin();
          if (existing) {
            await tx.stockItem.update({
              where: { id: existing.id },
              data: { quantity: { increment: qty } },
            });
          } else {
            await tx.stockItem.create({
              data: {
                id: stockId,
                companyId,
                branchId,
                productId,
                quantity: qty,
                cost: new Prisma.Decimal(Number(parsed.cost ?? 0)),
              },
            });
          }
          await tx.importRow.update({
            where: { id: row.id },
            data: { createdEntityId: stockId, createdKind: 'stock_item' },
          });
        } else {
          const unitId = newUuidV7Bin();
          await tx.unit.create({
            data: {
              id: unitId,
              companyId,
              branchId,
              productId,
              imeiPrimary: kind === 'imei' ? (parsed.imei as string) : null,
              serialNo: kind === 'serial' ? (parsed.serialNo as string) : null,
              cost: new Prisma.Decimal(Number(parsed.cost ?? 0)),
              status: 'in_stock',
            },
          });
          await tx.importRow.update({
            where: { id: row.id },
            data: { createdEntityId: unitId, createdKind: 'unit' },
          });
        }
        count++;
      }

      await tx.importBatch.update({
        where: { id: batch.id },
        data: {
          status: 'committed',
          committedAt: now,
          committedById: userId,
          importedRows: count,
          version: { increment: 1 },
        },
      });

      await this.audit.recordTx(tx, {
        entityType: 'ImportBatch',
        entityId: batch.id,
        action: 'create',
        after: {
          file: batch.originalFilename,
          kind,
          imported: count,
          skipped: batch.rows.length - count,
        },
        branchId,
      });
      return count;
    });

    return { ...(await this.get(id)), imported: created };
  }

  // --- helpers --------------------------------------------------------------

  /**
   * Decide every row, tracking identifiers seen so far.
   *
   * Duplicates are checked against the file as well as the shop: a sheet that
   * lists the same phone twice would otherwise import it once and fail once,
   * which reads as a mysterious error rather than "you typed it twice".
   */
  private async decideRows(body: string[][], mapping: HeaderGuess[], kind: ImportKind) {
    const byField = new Map<ImportField, number>();
    for (const m of mapping) if (m.field) byField.set(m.field, m.index);

    const identifierField: ImportField =
      kind === 'imei' ? 'imei' : kind === 'serial' ? 'serialNo' : 'barcode';

    // Every identifier the file mentions, looked up in ONE query rather than
    // one per row — a 500-row import must not be 500 round trips.
    const claimed = body
      .map((r) => (byField.has(identifierField) ? r[byField.get(identifierField) as number] : undefined))
      .map((v) => (v ?? '').replace(/[\s-]/g, '').trim())
      .filter(Boolean);

    const existsInShop = new Set<string>();
    if (claimed.length > 0) {
      const units = await this.db.unit.findMany({
        // A spreadsheet claiming an identifier already held as another unit's
        // SECOND IMEI is a duplicate too — 0042 would refuse the insert, so
        // catching it here turns a crash into a readable row error.
        where: {
          OR: [
            { imeiPrimary: { in: claimed } },
            { imeiSecondary: { in: claimed } },
            { serialNo: { in: claimed } },
          ],
        },
        select: { imeiPrimary: true, imeiSecondary: true, serialNo: true },
      });
      for (const u of units) {
        if (u.imeiPrimary) existsInShop.add(u.imeiPrimary);
        // Selecting the row by its second IMEI and then not reading it back
        // would find the duplicate and forget it again.
        if (u.imeiSecondary) existsInShop.add(u.imeiSecondary);
        if (u.serialNo) existsInShop.add(u.serialNo);
      }
    }

    const seenInFile = new Set<string>();
    const out: { rowNumber: number; raw: string[]; identifier: string | null; verdict: RowVerdict }[] = [];

    for (let i = 0; i < body.length; i++) {
      const raw = body[i];
      const cells: Partial<Record<ImportField, string>> = {};
      for (const [field, index] of byField) cells[field] = raw[index] ?? '';

      const verdict = validateRow({ cells, kind, seenInFile, existsInShop });
      const identifier =
        (verdict.parsed.imei ?? verdict.parsed.serialNo ?? verdict.parsed.barcode ?? null) || null;
      if (identifier) seenInFile.add(identifier);

      out.push({
        // Row 1 is the header, so the first data row is line 2 — the number the
        // shop sees in their own spreadsheet.
        rowNumber: i + 2,
        raw,
        identifier,
        verdict,
      });
    }
    return out;
  }

  /**
   * Reuse the product if the shop already has it; create it if not.
   *
   * Matching on brand + model + variant, because an import of forty A15s must
   * produce forty units of ONE product, not forty products that happen to share
   * a name and cannot be reported on together.
   */
  private async findOrCreateProduct(
    tx: Tx,
    companyId: Buffer,
    parsed: Record<string, unknown>,
    kind: ImportKind,
  ): Promise<Buffer> {
    const brand = ((parsed.brand as string) ?? '').trim() || 'Unbranded';
    const model = ((parsed.model as string) ?? '').trim();
    const variant = ((parsed.variant as string) ?? '').trim() || null;

    const existing = await tx.product.findFirst({
      where: { companyId, brand, model, variant },
      select: { id: true },
    });
    if (existing) return existing.id;

    const id = newUuidV7Bin();
    await tx.product.create({
      data: {
        id,
        companyId,
        brand,
        model,
        variant,
        trackingType: kind === 'quantity' ? 'quantity' : kind === 'imei' ? 'imei' : 'serial',
      },
    });
    return id;
  }
}

/** Errors first, then warnings, then the rows that are simply fine. */
function rank(status: string): number {
  return status === 'error' ? 0 : status === 'warning' ? 1 : 2;
}
