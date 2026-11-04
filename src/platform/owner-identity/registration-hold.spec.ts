import { ConflictException } from '@nestjs/common';
import { RegistrationFlowService } from '../registration-flow.service';
import { OwnerIdentityTakenError } from './owner-identity';

/**
 * A new account with a contact that already has one (post-Build-4, the owner's instruction of 2026-11-04, superseding
 * the D227 hold): refused at the contact step, before any code is generated or sent, with one generic answer for the
 * number and the email; nothing created; the refusal audited without the contact; a lost race gives the same answer.
 */
const PHONE = '+22240000001';
const dto = { idempotencyKey: 'k-1', ownerName: 'A', businessName: 'B', branchName: 'C', phone: PHONE, password: 'password1', language: 'fr', whatsappConsentVersion: '1' };

jest.mock('../../messaging/whatsapp-consent', () => ({
  ...jest.requireActual('../../messaging/whatsapp-consent'),
  acceptedConsentVersion: () => '1',
}));

function world(taken: { phone?: string[]; email?: string[] } = {}, register: () => Promise<unknown> = async () => ({})) {
  const registration = { register: jest.fn(register) };
  const audit = { record: jest.fn(async () => undefined) };
  const verification = { start: jest.fn(), latestChallengeFor: jest.fn(), confirmChallenge: jest.fn() };
  const holds = { create: jest.fn() };
  const prisma = {
    ownerIdentity: { findUnique: async ({ where }: any) => ((taken[where.kind_value.kind as 'phone' | 'email'] ?? []).includes(where.kind_value.value) ? { companyId: Buffer.alloc(16), userId: Buffer.alloc(16) } : null) },
    registrationAttempt: { findUnique: async () => null },
    registrationHold: holds,
  };
  const flow = new RegistrationFlowService(
    registration as never,
    { issue: jest.fn() } as never,
    { canDeliver: () => true } as never,
    {} as never,
    undefined,
    prisma as never,
    { hash: jest.fn(async () => 'h') } as never,
    verification as never,
    audit as never,
  );
  return { flow, registration, audit, verification, holds };
}

const refusal = { response: { code: 'CONTACT_UNAVAILABLE_FOR_SIGNUP', message: 'This number is already connected to a Dukan account. Sign in or recover access.' } };

describe('a contact that already has an account stops the new account at the contact step', () => {
  it.each([
    ['the number as stored', PHONE],
    ['spaces and the 00 prefix', '00222 40 00 00 01'],
    ['hyphens and parentheses', '+222 (40) 00-00-01'],
  ])('a taken number — %s: refused before any code, nothing created, audited without the number', async (_label, phone) => {
    const w = world({ phone: [PHONE] });
    const e = await w.flow.register({ ...dto, phone } as never, { source: 'mobile_registration', ip: '10.0.0.1' }).catch((x) => x);
    expect(e).toBeInstanceOf(ConflictException);
    expect(e).toMatchObject(refusal);
    expect(w.registration.register).not.toHaveBeenCalled();
    expect(w.verification.start).not.toHaveBeenCalled();
    expect(w.holds.create).not.toHaveBeenCalled();
    expect(w.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'registration.contact_unavailable', after: { channel: 'phone' } }));
    expect(JSON.stringify(w.audit.record.mock.calls)).not.toContain('40000001');
  });

  it('a taken email, in any case: the same refusal, and the answer never says which contact or whose', async () => {
    const w = world({ email: ['owner@shop.mr'] });
    const e = await w.flow.register({ ...dto, phone: '+22240000099', email: ' Owner@Shop.MR ' } as never, { source: 'website_registration' }).catch((x) => x);
    expect(e).toMatchObject(refusal);
    expect(JSON.stringify(e.response)).not.toMatch(/owner@|business|company|status/i);
    expect(w.registration.register).not.toHaveBeenCalled();
  });

  it('a new number and email go on to the ordinary registration', async () => {
    const w = world({ phone: [PHONE] });
    await w.flow.register({ ...dto, phone: '+22240000002', email: 'new@shop.mr' } as never, { source: 'mobile_registration' }).catch(() => undefined);
    expect(w.registration.register).toHaveBeenCalledTimes(1);
  });

  it('two attempts racing for the same new number: the unique index decides, and the loser gets the same refusal', async () => {
    const w = world({}, async () => {
      throw new OwnerIdentityTakenError('phone');
    });
    await expect(w.flow.register({ ...dto, phone: '+22240000003' } as never, { source: 'mobile_registration' })).rejects.toMatchObject(refusal);
    expect(w.verification.start).not.toHaveBeenCalled();
  });
});
