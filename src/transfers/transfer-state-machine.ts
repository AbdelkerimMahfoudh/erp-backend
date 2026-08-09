import { ConflictException } from '@nestjs/common';
import { TransferStatus } from '@prisma/client';

/**
 * Transfer lifecycle (H1.2 — data-driven, so a new state is one entry here plus
 * an enum migration).
 *
 * ```
 *  request ──► pending_approval ──approve──► approved ──ship──► in_transit ──receive──► received
 *                    │                          │
 *                    ├─reject──► rejected       └─cancel──► cancelled
 *                    └─cancel──► cancelled
 * ```
 *
 * `pending_approval` and `approved` both hold their units RESERVED, so stock is
 * unsellable from the moment it is promised (H1.1) rather than from shipment.
 * Only `rejected` and `cancelled` release it.
 *
 * **Nothing leaves `in_transit` except `received`.** Cancelling a shipment would
 * mean deciding where the goods physically are, and rewriting the unit back to
 * the source branch would be a guess. Return-to-source and discrepancy handling
 * are deliberately future work, so the machine refuses rather than inventing an
 * answer.
 */
const TRANSITIONS: Record<TransferStatus, TransferStatus[]> = {
  pending_approval: ['approved', 'rejected', 'cancelled'],
  approved: ['in_transit', 'cancelled'],
  in_transit: ['received'],
  received: [],
  rejected: [],
  cancelled: [],
};

/** Statuses whose units are reserved and therefore not sellable. */
export const RESERVING_STATUSES: readonly TransferStatus[] = ['pending_approval', 'approved'];

/** Terminal statuses — the transfer is finished and cannot move again. */
export const TERMINAL_STATUSES: readonly TransferStatus[] = ['received', 'rejected', 'cancelled'];

export function canTransferTransition(from: TransferStatus, to: TransferStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransferTransition(from: TransferStatus, to: TransferStatus): void {
  if (!canTransferTransition(from, to)) {
    throw new ConflictException(`A transfer that is '${from}' cannot become '${to}'`);
  }
}
