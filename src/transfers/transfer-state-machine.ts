import { ConflictException } from '@nestjs/common';
import { TransferStatus } from '@prisma/client';

/**
 * Transfer lifecycle (data-driven → extensible). Current states per Sub-phase 2C.
 * Future states (design-only): `draft`, `pending_approval`, `rejected` — each
 * added with one enum value (migration) + an entry here; no rework needed.
 */
const TRANSITIONS: Record<TransferStatus, TransferStatus[]> = {
  ready_to_ship: ['in_transit', 'cancelled'],
  in_transit: ['received', 'cancelled'],
  received: [],
  cancelled: [],
};

export function canTransferTransition(from: TransferStatus, to: TransferStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransferTransition(from: TransferStatus, to: TransferStatus): void {
  if (!canTransferTransition(from, to)) {
    throw new ConflictException(`A transfer that is '${from}' cannot become '${to}'`);
  }
}
