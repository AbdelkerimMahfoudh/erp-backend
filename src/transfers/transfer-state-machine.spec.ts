import { ConflictException } from '@nestjs/common';
import {
  assertTransferTransition,
  canTransferTransition,
  RESERVING_STATUSES,
  TERMINAL_STATUSES,
} from './transfer-state-machine';

describe('TransferStateMachine', () => {
  it('allows the approval lifecycle', () => {
    expect(canTransferTransition('pending_approval', 'approved')).toBe(true);
    expect(canTransferTransition('approved', 'in_transit')).toBe(true);
    expect(canTransferTransition('in_transit', 'received')).toBe(true);
  });

  it('allows refusal and withdrawal before shipment', () => {
    expect(canTransferTransition('pending_approval', 'rejected')).toBe(true);
    expect(canTransferTransition('pending_approval', 'cancelled')).toBe(true);
    expect(canTransferTransition('approved', 'cancelled')).toBe(true);
  });

  it('never lets a request skip approval', () => {
    // The whole point of H1.2: an employee cannot ship what nobody agreed to.
    expect(canTransferTransition('pending_approval', 'in_transit')).toBe(false);
    expect(canTransferTransition('pending_approval', 'received')).toBe(false);
  });

  it('refuses to cancel a shipment that has already left', () => {
    /**
     * Cancelling in transit would mean deciding where the goods physically are,
     * and rewriting the unit back to the source branch would be a guess.
     * Return-to-source is future work; the machine refuses rather than
     * inventing an answer.
     */
    expect(canTransferTransition('in_transit', 'cancelled')).toBe(false);
    expect(canTransferTransition('in_transit', 'rejected')).toBe(false);
    expect(canTransferTransition('in_transit', 'approved')).toBe(false);
  });

  it('treats received, rejected and cancelled as final', () => {
    for (const terminal of TERMINAL_STATUSES) {
      for (const to of ['approved', 'in_transit', 'received', 'cancelled'] as const) {
        expect(canTransferTransition(terminal, to)).toBe(false);
      }
    }
  });

  it('rejects illegal transitions', () => {
    expect(canTransferTransition('received', 'cancelled')).toBe(false);
    expect(canTransferTransition('cancelled', 'in_transit')).toBe(false);
    expect(canTransferTransition('rejected', 'approved')).toBe(false);
  });

  it('assert throws 409 on an illegal move', () => {
    expect(() => assertTransferTransition('received', 'in_transit')).toThrow(ConflictException);
    expect(() => assertTransferTransition('approved', 'in_transit')).not.toThrow();
  });

  it('holds stock reserved from request until it is refused or shipped', () => {
    // H1.1 reserves at request; H1.2 must not let approval quietly release it.
    expect(RESERVING_STATUSES).toEqual(['pending_approval', 'approved']);
    expect(RESERVING_STATUSES).not.toContain('in_transit'); // shipped, not reserved
    expect(RESERVING_STATUSES).not.toContain('rejected');
    expect(RESERVING_STATUSES).not.toContain('cancelled');
  });
});
