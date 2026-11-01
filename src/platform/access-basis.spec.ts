import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AccessBasisDto, parseBasis } from './access-basis';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const PAYMENT = { kind: 'payment', amount: '1500', paidAt: '2026-11-01T10:00:00.000Z', reference: 'BK-123', months: 1 } as AccessBasisDto;
const GRANT = { kind: 'grant', days: 30, reason: 'pilot shop' } as AccessBasisDto;
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (e) {
    return (e as { getResponse(): { code: string } }).getResponse().code;
  }
  return null;
};
const problems = (body: object) => validateSync(plainToInstance(AccessBasisDto, body)).map((e) => e.property).sort();

describe('why an administrator-created business has access (D227)', () => {
  it('nothing is assumed: no basis, no business', () => {
    expect(refusal(() => parseBasis(undefined, false, NOW))).toBe('access_basis_required');
  });

  it('a payment names its amount, date, reference and period', () => {
    expect(problems({ kind: 'payment' })).toEqual(['amount', 'months', 'paidAt', 'reference']);
    expect(problems(PAYMENT)).toEqual([]);
    expect(parseBasis(PAYMENT, false, NOW)).toMatchObject({ kind: 'payment', amount: '1500', months: 1 });
  });

  it('a grant names its reason and duration, and asks for no payment', () => {
    expect(problems({ kind: 'grant' })).toEqual(['days', 'reason']);
    expect(problems(GRANT)).toEqual([]);
    expect(parseBasis(GRANT, false, NOW)).toEqual({ kind: 'grant', days: 30, reason: 'pilot shop' });
  });

  it('refuses a made-up payment: zero, in the future, or for a test business', () => {
    expect(refusal(() => parseBasis({ ...PAYMENT, amount: '0' }, false, NOW))).toBe('amount_invalid');
    expect(refusal(() => parseBasis({ ...PAYMENT, paidAt: '2026-11-02T10:00:00.000Z' }, false, NOW))).toBe('paid_at_invalid');
    expect(refusal(() => parseBasis(PAYMENT, true, NOW))).toBe('test_business_no_payment');
    expect(parseBasis(GRANT, true, NOW).kind).toBe('grant');
  });

  it('is not a kind it does not know', () => {
    expect(problems({ kind: 'trial' })).toContain('kind');
  });
});
