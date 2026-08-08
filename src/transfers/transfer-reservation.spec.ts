import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { canTransition, assertTransition } from '../inventory/unit-state-machine';
import { CreateTransferDto } from './dto/transfer.dto';

/**
 * Reservation contract (H1.1).
 *
 * The H0 audit proved two things live: a requested phone stayed sellable, and
 * two transfers could claim the same unit. The fix is that a request reserves.
 * These tests pin the parts that are pure — the legal transitions and the
 * mandatory request id. The parts a database must arbitrate (the claim race,
 * the CHECK constraints, concurrent sales) are proven against real MySQL in the
 * H1.1 live verification, because a double would only agree with itself.
 */

describe('a reserved unit is not sellable', () => {
  it('cannot go straight from reserved to sold', () => {
    /**
     * This is the correction. The machine used to allow `reserved → sold` while
     * SalesPolicyService.assertSellable required `in_stock` and refused it. Two
     * rules disagreeing about whether a promised phone may be sold is exactly
     * the gap that eventually gets resolved in the wrong direction.
     */
    expect(canTransition('reserved', 'sold')).toBe(false);
    expect(() => assertTransition('reserved', 'sold')).toThrow(/cannot become 'sold'/);
  });

  it('becomes sellable again only by being released first', () => {
    expect(canTransition('reserved', 'in_stock')).toBe(true);
    expect(canTransition('in_stock', 'sold')).toBe(true);
  });

  it('can be shipped, which is its own transfer moving it on', () => {
    expect(canTransition('reserved', 'in_transit')).toBe(true);
  });

  it('is reachable from in_stock, which is what a transfer request does', () => {
    expect(canTransition('in_stock', 'reserved')).toBe(true);
  });

  it('does not become faulty, returned or transferred_out directly', () => {
    // Release it first; those are decisions about stock the shop actually holds.
    for (const to of ['faulty', 'returned', 'transferred_out'] as const) {
      expect(canTransition('reserved', to)).toBe(false);
    }
  });

  it('leaves every other transition exactly as it was', () => {
    expect(canTransition('in_transit', 'in_stock')).toBe(true);
    expect(canTransition('sold', 'returned')).toBe(true);
    expect(canTransition('returned', 'in_stock')).toBe(true);
    expect(canTransition('faulty', 'in_stock')).toBe(true);
    expect(canTransition('transferred_out', 'in_stock')).toBe(false);
  });
});

describe('a transfer request must carry a client request id', () => {
  const valid = {
    clientUuid: '018f0000-0000-7000-8000-00000000e001',
    toBranchId: '018f0000-0000-7000-8000-0000000000b2',
    identifiers: ['356938035643809'],
  };

  const errorsFor = async (payload: Record<string, unknown>) =>
    validate(plainToInstance(CreateTransferDto, payload));

  it('accepts a request that supplies one', async () => {
    await expect(errorsFor(valid)).resolves.toHaveLength(0);
  });

  it('rejects a request with no key, so a retry cannot move stock twice', async () => {
    const { clientUuid, ...withoutKey } = valid;
    void clientUuid;
    const errors = await errorsFor(withoutKey);
    expect(errors.some((e) => e.property === 'clientUuid')).toBe(true);
  });

  it('rejects a key that is not a uuid', async () => {
    const errors = await errorsFor({ ...valid, clientUuid: 'retry-1' });
    expect(errors.some((e) => e.property === 'clientUuid')).toBe(true);
  });

  it('still requires a destination and at least one item', async () => {
    const noDest = await errorsFor({ ...valid, toBranchId: undefined });
    expect(noDest.some((e) => e.property === 'toBranchId')).toBe(true);
    const noItems = await errorsFor({ ...valid, identifiers: [] });
    expect(noItems.some((e) => e.property === 'identifiers')).toBe(true);
  });
});
