import { ConflictException } from '@nestjs/common';
import { WarningGate, ReissuedWarningResponse } from './warning-gate.service';
import { issueAcknowledgement } from './acknowledgement';
import { Warning } from './warning.types';
import { uuidToBin, binToUuid } from '../utils/uuid.util';

const COMPANY = uuidToBin('11111111-1111-7111-8111-111111111111');
const BRANCH = uuidToBin('22222222-2222-7222-8222-222222222222');
const USER = uuidToBin('33333333-3333-7333-8333-333333333333');

const tenant = {
  companyId: () => COMPANY,
  branchId: () => BRANCH,
  userId: () => USER,
} as never;

const subject = {
  actorId: binToUuid(USER),
  companyId: binToUuid(COMPANY),
  branchId: binToUuid(BRANCH),
  operation: 'sale.create',
};

const warning = (factor: number): Warning => ({
  code: 'magnitude.sale_price',
  severity: 'caution',
  messageKey: 'warning.magnitude.salePrice.high',
  params: { factor, direction: 'high' },
  field: 'lines.0.price',
  submitted: 170_000,
  reference: { kind: 'configured_price', amount: 17_000, sample: null },
});

describe('the warning gate', () => {
  const gate = new WarningGate(tenant);
  const payload = { lines: [{ price: 170_000 }] };

  beforeAll(() => {
    process.env.JWT_ACCESS_SECRET = 'test-secret-for-acknowledgements';
  });

  it('lets a request with nothing to say straight through', () => {
    expect(gate.check({ operation: 'sale.create', payload, warnings: [], token: undefined })).toEqual({
      ok: true,
    });
  });

  it('stops a first attempt and hands back a token to come back with', () => {
    const verdict = gate.check({
      operation: 'sale.create',
      payload,
      warnings: [warning(10)],
      token: undefined,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.response?.status).toBe('warnings_pending');
    expect(verdict.response?.warnings).toHaveLength(1);
    expect(verdict.response?.acknowledgementToken).toBeTruthy();
  });

  it('does not claim a confirmation expired when none was ever given', () => {
    const verdict = gate.check({
      operation: 'sale.create',
      payload,
      warnings: [warning(10)],
      token: undefined,
    });
    expect((verdict.response as ReissuedWarningResponse).reissuedBecause).toBeUndefined();
  });

  it('lets the same request through once it carries its own acknowledgement', () => {
    const issued = issueAcknowledgement(subject, payload, [warning(10)]);
    expect(
      gate.check({ operation: 'sale.create', payload, warnings: [warning(10)], token: issued.token }),
    ).toEqual({ ok: true });
  });

  it('re-asks when the server would now say something different', () => {
    /*
     * The offline case. A queued sale is replayed into a world that moved, and
     * the warning it was confirmed against is no longer the warning. The item
     * must pause for a human rather than proceed or vanish.
     */
    const issued = issueAcknowledgement(subject, payload, [warning(10)]);
    const verdict = gate.check({
      operation: 'sale.create',
      payload,
      warnings: [warning(100)],
      token: issued.token,
    });
    expect(verdict.ok).toBe(false);
    expect((verdict.response as ReissuedWarningResponse).reissuedBecause).toBe('warnings_changed');
  });

  it('re-asks when the payload changed under the confirmation', () => {
    const issued = issueAcknowledgement(subject, payload, [warning(10)]);
    const verdict = gate.check({
      operation: 'sale.create',
      payload: { lines: [{ price: 1_700_000 }] },
      warnings: [warning(10)],
      token: issued.token,
    });
    expect((verdict.response as ReissuedWarningResponse).reissuedBecause).toBe('payload_changed');
  });

  it('refuses a forged token instead of quietly re-issuing one', () => {
    expect(() =>
      gate.check({
        operation: 'sale.create',
        payload,
        warnings: [warning(10)],
        token: 'bm90LWEtdG9rZW4.forged',
      }),
    ).toThrow(ConflictException);
  });

  it('refuses another person\'s confirmation', () => {
    const other = issueAcknowledgement(
      { ...subject, actorId: binToUuid(uuidToBin('44444444-4444-7444-8444-444444444444')) },
      payload,
      [warning(10)],
    );
    expect(() =>
      gate.check({ operation: 'sale.create', payload, warnings: [warning(10)], token: other.token }),
    ).toThrow(ConflictException);
  });

  it('refuses a confirmation minted in another shop', () => {
    const elsewhere = issueAcknowledgement(
      { ...subject, companyId: binToUuid(uuidToBin('55555555-5555-7555-8555-555555555555')) },
      payload,
      [warning(10)],
    );
    expect(() =>
      gate.check({ operation: 'sale.create', payload, warnings: [warning(10)], token: elsewhere.token }),
    ).toThrow(ConflictException);
  });

  it('refuses a confirmation for a different operation', () => {
    const intake = issueAcknowledgement({ ...subject, operation: 'unit.intake' }, payload, [warning(10)]);
    expect(() =>
      gate.check({ operation: 'sale.create', payload, warnings: [warning(10)], token: intake.token }),
    ).toThrow(ConflictException);
  });
});
