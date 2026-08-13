import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { CreateTransferDto, TransferLineDto } from './dto/transfer.dto';

/**
 * Turning what a client asked for into the two kinds of thing a transfer moves.
 *
 * Kept free of Prisma and Nest request state so the rules can be tested
 * directly — the duplicate rule and the fingerprint are exactly the sort of
 * logic that looks obviously right and is not.
 */

export interface QuantityLine {
  productId: string;
  quantity: number;
}

export interface NormalizedLines {
  /** IMEI/serial, de-duplicated and trimmed, in request order. */
  identifiers: string[];
  /** One entry per product, in request order. */
  quantities: QuantityLine[];
}

export interface LineProblem {
  identifier?: string;
  productId?: string;
  reason: string;
}

/**
 * Read the request's lines, refusing anything ambiguous.
 *
 * **Duplicates are reported, never merged.** Scanning the same phone twice, or
 * sending the same accessory on two lines, means the person's count is wrong —
 * quietly collapsing it hands them a transfer that does not match what they
 * think they did. It also closes a real hole: two lines of 6 against 10
 * available would each pass an individual check and together promise 12.
 */
export function normalizeLines(dto: CreateTransferDto): NormalizedLines {
  const lines: TransferLineDto[] = dto.lines?.length
    ? dto.lines
    : (dto.identifiers ?? []).map((identifier) => ({ kind: 'unit', identifier }) as const);

  if (lines.length === 0) {
    throw new BadRequestException('A transfer needs at least one item');
  }

  const identifiers: string[] = [];
  const quantities: QuantityLine[] = [];
  const seenIdentifier = new Set<string>();
  const seenProduct = new Set<string>();
  const problems: LineProblem[] = [];

  for (const line of lines) {
    if (line.kind === 'unit') {
      const identifier = line.identifier.trim();
      if (!identifier) {
        problems.push({ reason: 'empty identifier' });
        continue;
      }
      if (seenIdentifier.has(identifier)) {
        problems.push({ identifier, reason: 'scanned twice' });
        continue;
      }
      seenIdentifier.add(identifier);
      identifiers.push(identifier);
    } else {
      const productId = line.productId;
      if (seenProduct.has(productId)) {
        problems.push({ productId, reason: 'listed twice' });
        continue;
      }
      seenProduct.add(productId);
      quantities.push({ productId, quantity: line.quantity });
    }
  }

  if (problems.length > 0) {
    throw new BadRequestException({
      message: 'The same item was listed more than once',
      problems,
    });
  }
  return { identifiers, quantities };
}

/**
 * A stable fingerprint of what was asked for, so replaying a request id with a
 * DIFFERENT request is a conflict rather than a misleading success.
 *
 * **Order carries no meaning and must not change the answer.** The same phones
 * scanned in a different sequence, or the same accessories chosen in a
 * different order, are the same movement. Quantity is part of the fingerprint
 * because 10 cables and 4 cables are emphatically not.
 *
 * The source branch is included: the same key sent from another branch is a
 * different movement of different goods.
 */
export function transferFingerprint(
  lines: NormalizedLines,
  fromBranchId: Buffer,
  toBranchId: string,
): string {
  const canonical = {
    fromBranchId: fromBranchId.toString('hex'),
    toBranchId: toBranchId.toLowerCase(),
    units: [...lines.identifiers].sort(),
    stock: lines.quantities
      .map((q) => `${q.productId.toLowerCase()}:${q.quantity}`)
      .sort(),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** What a transfer carries, as the list and detail contracts report it. */
export interface LineCounts {
  unitCount: number;
  quantityLineCount: number;
  totalQuantity: number;
}

/**
 * Counts for display. `totalQuantity` deliberately includes serialized units —
 * "2 phones · 10 accessories" is 12 things arriving, and a destination counting
 * cartons cares about all of them.
 */
export function countLines(
  items: { unitId: Buffer | null; quantity: number }[],
): LineCounts {
  let unitCount = 0;
  let quantityLineCount = 0;
  let totalQuantity = 0;
  for (const item of items) {
    if (item.unitId) {
      unitCount += 1;
      totalQuantity += 1;
    } else {
      quantityLineCount += 1;
      totalQuantity += item.quantity;
    }
  }
  return { unitCount, quantityLineCount, totalQuantity };
}
