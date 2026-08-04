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

  describe('assertBelowCostAllowed', () => {
    it('allows non-negative margin', () => {
      expect(() => policy.assertBelowCostAllowed(10, false, undefined)).not.toThrow();
    });
    it('blocks below cost without override', () => {
      expect(() => policy.assertBelowCostAllowed(-1, false, 'x')).toThrow(ForbiddenException);
    });
    it('requires a reason with override', () => {
      expect(() => policy.assertBelowCostAllowed(-1, true, undefined)).toThrow(BadRequestException);
      expect(() => policy.assertBelowCostAllowed(-1, true, 'clearance')).not.toThrow();
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

  describe('assertCreditHasCustomer', () => {
    it('requires a customer for credit/partial', () => {
      expect(() => policy.assertCreditHasCustomer('credit', undefined)).toThrow(BadRequestException);
      expect(() => policy.assertCreditHasCustomer('paid', undefined)).not.toThrow();
      expect(() => policy.assertCreditHasCustomer('partial', 'cust-uuid')).not.toThrow();
    });
  });
});
