import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { newUuidV7Bin } from '../../common/utils/uuid.util';
import { accessOf } from './portal-account.controller';
import { OwnerContactsService } from './owner-contacts.service';

/**
 * The portal's Owner routes (0099; docs/101 §4, §6): access as the server decides it, and the Owner's optional email
 * address verified with a code sent to the address already on the account — never one a request names.
 */

describe('access, as the server decides it', () => {
  it('operational while the app writes; read-only after an end or before a start; stopped when a decision closed it', () => {
    expect(accessOf({ canWrite: true, state: 'active' })).toBe('operational');
    expect(accessOf({ canWrite: true, state: 'grace' })).toBe('operational');
    expect(accessOf({ canWrite: true, state: 'trial_active' })).toBe('operational');
    for (const state of ['expired', 'trial_expired', 'trial_available', 'pending'] as const) expect(accessOf({ canWrite: false, state })).toBe('read_only');
    for (const state of ['suspended', 'cancelled', 'rejected'] as const) expect(accessOf({ canWrite: false, state })).toBe('stopped');
  });
});

describe('the Owner’s email address, verified from the portal', () => {
  const who = { companyId: newUuidV7Bin(), userId: newUuidV7Bin() };
  const NOW = new Date('2026-10-18T10:00:00.000Z');

  function service(owner: { email: string | null; emailVerifiedAt: Date | null } | null, codeIsRight = true) {
    const updates: unknown[] = [];
    const audits: unknown[] = [];
    const prisma = {
      user: {
        findFirst: jest.fn(async () => owner),
        updateMany: jest.fn(async (args: unknown) => (updates.push(args), { count: 1 })),
      },
      auditLog: { create: jest.fn(async (args: unknown) => (audits.push(args), {})) },
    };
    const verification = {
      start: jest.fn(async () => ({ delivery: 'sent' as const })),
      confirm: jest.fn(async () => codeIsRight),
    };
    const trialSetup = { onContactsVerified: jest.fn(async () => undefined) };
    const svc = new OwnerContactsService(prisma as never, verification as never, trialSetup as never, { now: () => NOW });
    return { svc, prisma, verification, trialSetup, updates, audits };
  }

  it('sends the code to the address on the account, masked in the answer', async () => {
    const { svc, verification } = service({ email: 'aicha@shop.mr', emailVerifiedAt: null });
    await expect(svc.startEmailVerification(who, 'fr')).resolves.toEqual({ destination: 'a•••@shop.mr', delivery: 'sent' });
    expect(verification.start).toHaveBeenCalledWith('aicha@shop.mr', 'fr');
  });

  it('refuses anybody but the Owner, an account with no address, and an address already verified — before any code', async () => {
    const notOwner = service(null);
    await expect(notOwner.svc.startEmailVerification(who, 'en')).rejects.toBeInstanceOf(ForbiddenException);
    const noEmail = service({ email: null, emailVerifiedAt: null });
    await expect(noEmail.svc.startEmailVerification(who, 'en')).rejects.toMatchObject({ response: { code: 'email_missing' } });
    const done = service({ email: 'a@b.mr', emailVerifiedAt: NOW });
    await expect(done.svc.confirmEmailVerification(who, '123456')).rejects.toBeInstanceOf(ConflictException);
    for (const s of [notOwner, noEmail, done]) expect(s.verification.start).not.toHaveBeenCalled();
  });

  it('the right code verifies that address — conditionally on it — audits it masked, and lets waiting instructions go', async () => {
    const { svc, updates, audits, trialSetup } = service({ email: 'aicha@shop.mr', emailVerifiedAt: null });
    await expect(svc.confirmEmailVerification(who, '123456')).resolves.toEqual({ emailVerified: true });
    expect(updates).toEqual([
      { where: { id: who.userId, companyId: who.companyId, email: 'aicha@shop.mr', emailVerifiedAt: null }, data: { emailVerifiedAt: NOW } },
    ]);
    expect(JSON.stringify(audits)).toContain('a•••@shop.mr');
    expect(JSON.stringify(audits)).not.toContain('aicha@shop.mr');
    expect(trialSetup.onContactsVerified).toHaveBeenCalledWith(who.companyId, who.userId);
  });

  it('a wrong or expired code verifies nothing', async () => {
    const { svc, updates } = service({ email: 'aicha@shop.mr', emailVerifiedAt: null }, false);
    await expect(svc.confirmEmailVerification(who, '000000')).rejects.toBeInstanceOf(BadRequestException);
    expect(updates).toEqual([]);
  });
});
