import { ConflictException } from '@nestjs/common';
import { assertTransferTransition, canTransferTransition } from './transfer-state-machine';

describe('TransferStateMachine', () => {
  it('allows the shipping lifecycle', () => {
    expect(canTransferTransition('ready_to_ship', 'in_transit')).toBe(true);
    expect(canTransferTransition('in_transit', 'received')).toBe(true);
    expect(canTransferTransition('ready_to_ship', 'cancelled')).toBe(true);
    expect(canTransferTransition('in_transit', 'cancelled')).toBe(true);
  });

  it('rejects illegal transitions', () => {
    expect(canTransferTransition('received', 'cancelled')).toBe(false);
    expect(canTransferTransition('cancelled', 'in_transit')).toBe(false);
    expect(canTransferTransition('ready_to_ship', 'received')).toBe(false);
  });

  it('assert throws 409 on illegal move', () => {
    expect(() => assertTransferTransition('received', 'in_transit')).toThrow(ConflictException);
    expect(() => assertTransferTransition('ready_to_ship', 'in_transit')).not.toThrow();
  });
});
