import { ConflictException, BadRequestException } from '@nestjs/common';
import { RegistrationFlowService } from '../registration-flow.service';
import { hashIntentToken } from '../../auth/otp/otp-code.util';

/** A public registration for a number that already has an Owner (D227): nothing created, nothing said before the code. */
const PHONE = '+22240000001';
const dto = { idempotencyKey: 'k-1', ownerName: 'A', businessName: 'B', branchName: 'C', phone: PHONE, password: 'password1', language: 'fr', whatsappConsentVersion: '1' };

jest.mock('../../messaging/whatsapp-consent', () => ({
  ...jest.requireActual('../../messaging/whatsapp-consent'),
  acceptedConsentVersion: () => '1',
}));

function world(confirm: 'ok' | 'wrong' = 'ok') {
  const holds: Record<string, any>[] = [];
  const registration = { register: jest.fn() };
  const prisma = {
    ownerIdentity: { findUnique: async () => ({ companyId: Buffer.alloc(16), userId: Buffer.alloc(16) }) },
    registrationAttempt: { findUnique: async () => null },
    registrationHold: {
      create: async ({ data }: any) => (holds.push(data), data),
      findUnique: async ({ where }: any) => holds.find((h) => h.tokenHash === where.tokenHash) ?? null,
      update: async ({ where, data }: any) => Object.assign(holds.find((h) => h.id === where.id)!, data),
      updateMany: async ({ where, data }: any) => (Object.assign(holds.find((h) => h.id === where.id)!, data), { count: 1 }),
    },
  };
  const verification = {
    start: jest.fn(async () => ({ delivery: 'sent' })),
    latestChallengeFor: async () => Buffer.alloc(16, 1),
    confirmChallenge: async () => confirm,
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
  );
  return { flow, registration, holds, verification };
}

describe('a number that already has an Owner', () => {
  it('answers like any registration, names no business, and creates nothing', async () => {
    const { flow, registration, holds } = world();
    const answer = await flow.register(dto as never, { source: 'mobile_registration' });
    expect(registration.register).not.toHaveBeenCalled();
    expect(answer).toMatchObject({ status: 'pending_activation', created: true, next: 'verify_contact', verification: { channel: 'phone' } });
    expect(JSON.stringify(answer)).not.toContain(PHONE);
    // Only the digest of the ticket is stored.
    expect(holds[0].tokenHash).toBe(hashIntentToken(answer.continuation!.token));
  });

  it('sends the same code, and only the right code reveals the account', async () => {
    const { flow, verification } = world();
    const { continuation } = await flow.register(dto as never, { source: 'mobile_registration' });
    await flow.startVerification({ continuation: continuation!.token, language: 'fr' });
    expect(verification.start).toHaveBeenCalledWith(PHONE, 'fr');
    await expect(flow.confirmVerification({ continuation: continuation!.token, code: '123456' }, {})).rejects.toBeInstanceOf(ConflictException);
  });

  it('a wrong code gets the ordinary refusal', async () => {
    const { flow } = world('wrong');
    const { continuation } = await flow.register(dto as never, { source: 'mobile_registration' });
    await flow.startVerification({ continuation: continuation!.token, language: 'fr' });
    await expect(flow.confirmVerification({ continuation: continuation!.token, code: '000000' }, {})).rejects.toThrow(BadRequestException);
  });
});
