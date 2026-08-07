import { uuidToBin } from '../common/utils/uuid.util';
import {
  overrideApplies,
  resolveProductLevel,
  resolveQuantity,
  resolveSerialized,
} from './price-resolution';

/**
 * The precedence ladder.
 *
 * These are the rules a shopkeeper would state out loud: this phone's own price
 * beats the price for that model here, which beats the company price, and a
 * price set in another branch is not a price here at all. Everything else in
 * pricing is plumbing around these.
 */

const BRANCH_A = uuidToBin('018f0000-0000-7000-8000-0000000b0001');
const BRANCH_B = uuidToBin('018f0000-0000-7000-8000-0000000b0002');

const at = (branch: Buffer, price: number, version = 0) => ({ price, version, branchId: branch });

describe('a serialized unit in its own branch', () => {
  const base = { activeBranchId: BRANCH_A, unitBranchId: BRANCH_A };

  it('uses its own price above everything else', () => {
    const r = resolveSerialized({
      ...base,
      override: at(BRANCH_A, 17000, 3),
      branchVariant: { price: 17500, version: 1 },
      productDefault: 18000,
    });
    expect(r).toMatchObject({ price: 17000, source: 'unit_override', version: 3, targetType: 'unit' });
  });

  it('falls to the branch price for the model when it has none of its own', () => {
    const r = resolveSerialized({
      ...base,
      override: null,
      branchVariant: { price: 17500, version: 1 },
      productDefault: 18000,
    });
    expect(r).toMatchObject({ price: 17500, source: 'branch_variant', version: 1 });
  });

  it('falls to the company price when the branch has set none', () => {
    const r = resolveSerialized({ ...base, override: null, branchVariant: null, productDefault: 18000 });
    expect(r).toMatchObject({ price: 18000, source: 'product_default' });
  });

  it('reports unpriced rather than inventing a number', () => {
    const r = resolveSerialized({ ...base, override: null, branchVariant: null, productDefault: null });
    expect(r).toMatchObject({ price: null, source: 'unpriced', version: null, targetType: null });
  });

  it('carries no version for a fallback, because there is no row to edit', () => {
    const r = resolveSerialized({ ...base, override: null, branchVariant: null, productDefault: 18000 });
    expect(r.version).toBeNull();
  });
});

describe('a price set in another branch never follows the phone', () => {
  // The whole reason UnitPriceOverride carries branchId.
  it('is ignored once the phone has moved, and says so', () => {
    const r = resolveSerialized({
      activeBranchId: BRANCH_B,
      unitBranchId: BRANCH_B, // the phone now lives in B
      override: at(BRANCH_A, 17000), // but the price was set in A
      branchVariant: { price: 19000, version: 2 },
      productDefault: 18000,
    });
    expect(r.price).toBe(19000);
    expect(r.source).toBe('branch_variant');
    expect(r.staleOverrideIgnored).toBe(true);
  });

  it('falls all the way to the company price if B has set nothing', () => {
    const r = resolveSerialized({
      activeBranchId: BRANCH_B,
      unitBranchId: BRANCH_B,
      override: at(BRANCH_A, 17000),
      branchVariant: null,
      productDefault: 18000,
    });
    expect(r).toMatchObject({ price: 18000, source: 'product_default', staleOverrideIgnored: true });
  });

  it('is ignored when browsing from a branch the phone is not in', () => {
    // Manager in A looking at a phone sitting in B: A's answer is not B's price.
    const r = resolveSerialized({
      activeBranchId: BRANCH_A,
      unitBranchId: BRANCH_B,
      override: at(BRANCH_B, 17000),
      branchVariant: { price: 19000, version: 1 },
      productDefault: 18000,
    });
    expect(r.source).toBe('branch_variant');
    expect(r.staleOverrideIgnored).toBe(true);
  });

  it('never reports a stale flag when there is no override at all', () => {
    const r = resolveSerialized({
      activeBranchId: BRANCH_A,
      unitBranchId: BRANCH_A,
      override: null,
      branchVariant: null,
      productDefault: 1,
    });
    expect(r.staleOverrideIgnored).toBe(false);
  });

  it('requires all three branches to agree', () => {
    expect(overrideApplies(at(BRANCH_A, 1), BRANCH_A, BRANCH_A)).toBe(true);
    expect(overrideApplies(at(BRANCH_A, 1), BRANCH_B, BRANCH_A)).toBe(false);
    expect(overrideApplies(at(BRANCH_A, 1), BRANCH_A, BRANCH_B)).toBe(false);
    expect(overrideApplies(null, BRANCH_A, BRANCH_A)).toBe(false);
  });
});

describe('a product with no unit chosen', () => {
  it('never borrows one phone’s price and calls it the model’s price', () => {
    // resolveProductLevel has no way to see an override — by construction.
    const r = resolveProductLevel({ price: 17500, version: 4 }, 18000);
    expect(r).toMatchObject({ price: 17500, source: 'branch_variant', version: 4 });
  });

  it('offers the branch-variant row as the thing to edit even when falling back', () => {
    const r = resolveProductLevel(null, 18000);
    expect(r).toMatchObject({ price: 18000, source: 'product_default', targetType: 'branch_variant' });
  });

  it('is unpriced when the company set no default either', () => {
    expect(resolveProductLevel(null, null).source).toBe('unpriced');
  });

  it('treats a zero price as a real price, not as absent', () => {
    // A giveaway is a decision; falling through to 18000 would overcharge.
    expect(resolveProductLevel({ price: 0, version: 1 }, 18000)).toMatchObject({
      price: 0,
      source: 'branch_variant',
    });
    expect(resolveProductLevel(null, 0)).toMatchObject({ price: 0, source: 'product_default' });
  });
});

describe('quantity stock', () => {
  it('uses its own branch stock price', () => {
    expect(resolveQuantity({ price: 30, version: 2 }, 45)).toMatchObject({
      price: 30,
      source: 'stock_item',
      version: 2,
      targetType: 'stock_item',
    });
  });

  it('falls back to the company price when the branch holds no stock yet', () => {
    expect(resolveQuantity(null, 45)).toMatchObject({ price: 45, source: 'product_default' });
  });

  it('is unpriced with neither', () => {
    expect(resolveQuantity(null, null).source).toBe('unpriced');
  });

  it('never reports a branch_variant source — quantity has no second price row', () => {
    for (const r of [resolveQuantity({ price: 1, version: 0 }, 2), resolveQuantity(null, 2)]) {
      expect(r.source).not.toBe('branch_variant');
    }
  });
});
