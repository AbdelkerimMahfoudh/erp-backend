import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Unit } from '@prisma/client';
import { SalesPolicyService } from './sales-policy.service';

describe('SalesPolicyService', () => {
  const policy = new SalesPolicyService();
  const branchA = Buffer.alloc(16, 1);
  const branchB = Buffer.alloc(16, 2);

  const unit = (status: Unit['status'], branchId: Buffer): Unit =>
    ({ status, branchId, imeiPrimary: '123456789012347' } as Unit);

  describe('reconcilePayments', () => {
    it('paid when fully covered', () => {
      expect(policy.reconcilePayments([{ amount: 100 }], 100)).toEqual({
        amountPaid: 100,
        balanceDue: 0,
        payStatus: 'paid',
      });
    });
    it('partial when some paid', () => {
      expect(policy.reconcilePayments([{ amount: 40 }], 100)).toMatchObject({ payStatus: 'partial', balanceDue: 60 });
    });
    it('credit when nothing paid', () => {
      expect(policy.reconcilePayments([{ amount: 0.0 }], 100)).toMatchObject({ payStatus: 'credit' });
    });
    it('rejects overpayment', () => {
      expect(() => policy.reconcilePayments([{ amount: 150 }], 100)).toThrow(BadRequestException);
    });
  });

  describe('assertPriceAllowed — the floor is the configured price', () => {
    const base = { configuredPrice: 17000, cost: 10000, approval: null, reason: undefined };

    it('allows a price at or above the set price', () => {
      expect(() => policy.assertPriceAllowed({ ...base, price: 17000 })).not.toThrow();
      expect(() => policy.assertPriceAllowed({ ...base, price: 20000 })).not.toThrow();
    });

    it('refuses BELOW the set price even when the sale is still profitable', () => {
      /*
       * The correction that defines A2. 15 000 against a 10 000 cost earns
       * money — and it is still below what the shop decided this sells for, so
       * it is the Owner's call, not the seller's.
       */
      expect(() => policy.assertPriceAllowed({ ...base, price: 15000 })).toThrow(ForbiddenException);
    });

    it('refuses below cost, which is the high-risk subset of the same rule', () => {
      expect(() => policy.assertPriceAllowed({ ...base, price: 9000 })).toThrow(ForbiddenException);
    });

    it('has no PRICE floor when the product has no configured price', () => {
      // The ladder reached `unpriced`. There is nothing to be below, and
      // inventing a floor from cost is the substitution this rule removes.
      expect(() =>
        policy.assertPriceAllowed({ ...base, configuredPrice: null, price: 10500 }),
      ).not.toThrow();
    });

    it('but the COST threshold still applies without a configured price', () => {
      /*
       * The two thresholds are independent. An unpriced product has no
       * configured floor to except — and selling it at a loss is still a loss,
       * so it still needs the Owner.
       */
      expect(() =>
        policy.assertPriceAllowed({ ...base, configuredPrice: null, price: 1 }),
      ).toThrow(ForbiddenException);
    });

    it('accepts a matching approval', () => {
      expect(() =>
        policy.assertPriceAllowed({
          ...base,
          price: 15000,
          approval: { approvedPrice: 15000, belowCost: false },
        }),
      ).not.toThrow();
    });

    it('refuses an approval granted for a DIFFERENT price', () => {
      // An approval for 15 000 must not authorise 1 500.
      expect(() =>
        policy.assertPriceAllowed({
          ...base,
          price: 1500,
          approval: { approvedPrice: 15000, belowCost: false },
        }),
      ).toThrow(ConflictException);
    });

    it('still requires a reason below cost, even with an approval', () => {
      expect(() =>
        policy.assertPriceAllowed({
          ...base,
          price: 9000,
          approval: { approvedPrice: 9000, belowCost: true },
        }),
      ).toThrow(BadRequestException);
      expect(() =>
        policy.assertPriceAllowed({
          ...base,
          price: 9000,
          approval: { approvedPrice: 9000, belowCost: true },
          reason: 'water damaged',
        }),
      ).not.toThrow();
    });
  });

  describe('resolvePrice', () => {
    it('prefers explicit price, falls back to default, else throws', () => {
      expect(policy.resolvePrice(950, 1200)).toBe(950);
      expect(policy.resolvePrice(undefined, 1200)).toBe(1200);
      expect(() => policy.resolvePrice(undefined, null)).toThrow(BadRequestException);
    });
  });

  describe('assertSellable', () => {
    it('allows in_stock at the branch', () => {
      expect(() => policy.assertSellable(unit('in_stock', branchA), branchA)).not.toThrow();
    });
    it('blocks non-in_stock', () => {
      expect(() => policy.assertSellable(unit('sold', branchA), branchA)).toThrow(ConflictException);
    });
    it('blocks wrong branch', () => {
      expect(() => policy.assertSellable(unit('in_stock', branchA), branchB)).toThrow(ConflictException);
    });
  });
});
// A balance needing a debtor is now `assertDebtorForBalance`, which also accepts
// a partner store; it is covered in sale-payment-rules.spec.ts.
