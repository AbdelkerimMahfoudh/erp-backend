import { ConflictException } from '@nestjs/common';
import { assertTransition, canTransition } from './unit-state-machine';

describe('UnitStateMachine', () => {
  it('allows legal transitions', () => {
    expect(canTransition('in_stock', 'sold')).toBe(true);
    expect(canTransition('in_stock', 'in_transit')).toBe(true);
    expect(canTransition('in_transit', 'in_stock')).toBe(true);
    expect(canTransition('sold', 'returned')).toBe(true);
    expect(canTransition('returned', 'in_stock')).toBe(true);
  });

  it('rejects illegal transitions', () => {
    expect(canTransition('sold', 'sold')).toBe(false);
    expect(canTransition('in_transit', 'sold')).toBe(false);
    expect(canTransition('faulty', 'sold')).toBe(false);
    expect(canTransition('transferred_out', 'in_stock')).toBe(false);
  });

  it('assertTransition throws 409 on an illegal move', () => {
    expect(() => assertTransition('sold', 'sold')).toThrow(ConflictException);
    expect(() => assertTransition('in_stock', 'sold')).not.toThrow();
  });
});
