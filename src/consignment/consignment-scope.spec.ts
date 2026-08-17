import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  assertDestination,
  assertSource,
  ledgerVisibleToCompany,
  lineVisibleToCompany,
  sideOf,
  visibleToCompany,
} from './consignment-scope';

/**
 * **The guard that replaces the tenant extension** (Milestone H).
 *
 * Every other table in this schema is scoped automatically by
 * `tenant.extension.ts`. `consignments` cannot be — it belongs to two companies
 * at once — so these are the tests that stand in for the guard that is no
 * longer there.
 */

const A = Buffer.from('a'.repeat(32), 'hex');
const B = Buffer.from('b'.repeat(32), 'hex');
const C = Buffer.from('c'.repeat(32), 'hex');

describe('who can see a consignment', () => {
  it('filters on BOTH company columns, never just one', () => {
    /**
     * Filtering on `sourceCompanyId` alone would make every consignment
     * invisible to the shop holding the phone. Filtering on neither would show
     * every shop everybody's trades.
     */
    expect(visibleToCompany(A)).toEqual({
      OR: [{ sourceCompanyId: A }, { destinationCompanyId: A }],
    });
  });

  it('scopes ledger rows the same way, on their own columns', () => {
    // The ledger carries both company ids of its own so a balance can be read
    // without joining — the filter has to match that shape.
    expect(ledgerVisibleToCompany(A)).toEqual({
      OR: [{ sourceCompanyId: A }, { destinationCompanyId: A }],
    });
  });

  it('scopes lines through their parent, never independently', () => {
    /**
     * A line carries `sourceCompanyId` for indexing, and scoping on it directly
     * would hide every line from the destination — who is precisely the party
     * that needs to see what they are holding.
     */
    expect(lineVisibleToCompany(A)).toEqual({ consignment: visibleToCompany(A) });
  });
});

describe('which side a company is on', () => {
  const between = { sourceCompanyId: A, destinationCompanyId: B };

  it('recognises the source', () => {
    expect(sideOf(between, A)).toBe('source');
  });

  it('recognises the destination', () => {
    expect(sideOf(between, B)).toBe('destination');
  });

  it('refuses a company on neither side with a 404, NOT a 403', () => {
    /**
     * The distinction matters. A 403 confirms the consignment exists, which is
     * an oracle — somebody could enumerate ids and learn who is trading with
     * whom, which is commercially sensitive even without the amounts. A 404 is
     * the same answer an id that never existed would give.
     */
    expect(() => sideOf(between, C)).toThrow(NotFoundException);
    expect(() => sideOf(between, C)).not.toThrow(ForbiddenException);
  });

  it('gives a manual consignment exactly one visible side', () => {
    // No destination company means no second tenant to show it to.
    const manual = { sourceCompanyId: A, destinationCompanyId: null };
    expect(sideOf(manual, A)).toBe('source');
    expect(() => sideOf(manual, B)).toThrow(NotFoundException);
  });

  it('compares buffers by VALUE, not by identity', () => {
    /**
     * The bug this catches is invisible and total: `===` on two Buffers holding
     * the same bytes is false, so every company would fail its own check and
     * the whole feature would 404 for everybody.
     */
    const sameBytes = Buffer.from('a'.repeat(32), 'hex');
    expect(sameBytes).not.toBe(A);
    expect(sideOf(between, sameBytes)).toBe('source');
  });
});

describe('acts that belong to one side only', () => {
  const between = { sourceCompanyId: A, destinationCompanyId: B };

  it('lets the source do source things', () => {
    expect(() => assertSource(between, A)).not.toThrow();
  });

  it('refuses the destination doing them, and says which side may', () => {
    // A 403 is right here: they can already see the consignment, so nothing is
    // disclosed by telling them the act is not theirs.
    expect(() => assertSource(between, B)).toThrow(ForbiddenException);
    expect(() => assertSource(between, B)).toThrow(/sending store/);
  });

  it('lets the destination do destination things', () => {
    expect(() => assertDestination(between, B)).not.toThrow();
  });

  it('refuses the source doing them', () => {
    expect(() => assertDestination(between, A)).toThrow(/receiving store/);
  });

  it('still 404s a stranger rather than telling them the act is not theirs', () => {
    expect(() => assertSource(between, C)).toThrow(NotFoundException);
    expect(() => assertDestination(between, C)).toThrow(NotFoundException);
  });
});
