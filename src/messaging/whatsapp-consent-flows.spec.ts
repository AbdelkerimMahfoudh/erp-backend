import { BadRequestException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { RegistrationFlowService } from '../platform/registration-flow.service';
import { WhatsAppContactDeliveryProvider } from '../platform/contact-delivery';
import { AccountService } from '../account/account.service';
import { WhatsAppRecords } from './whatsapp-records';
import { GovernedWhatsAppChannel } from './whatsapp-policy';
import { recipientHash } from './recipient-hash';
import { WHATSAPP_CONSENT_VERSION } from './whatsapp-consent';
import { fakeMessagingPrisma } from './__testing__/fake-messaging-prisma';

/**
 * Where consent is given and where an opt-out is honoured (D181 §5): Owner registration and number verification
 * take the consent version and record it with an audit event; a stale version is refused always and a missing one
 * while WhatsApp runs live — before anything is saved; test mode never accepts a number outside its allowlist; and
 * the account answers a withdrawal with what becomes unavailable.
 */

const KEY = 'test-messaging-hash-key-of-32-characters!';
const OWNER_NUMBER = '+22243210987';
const COMPANY = Buffer.alloc(16, 1);
const USER = Buffer.alloc(16, 2);

const ATTEMPT = {
  idempotencyKey: 'k-1',
  ownerName: 'Aicha',
  businessName: 'Boutique Aicha',
  branchName: 'Main',
  phone: OWNER_NUMBER,
  password: 'password-1',
  language: 'en' as const,
};

function registration(opts: { mode?: 'test' | 'live'; canDeliver?: (channel: string, destination?: string) => boolean } = {}) {
  const db = fakeMessagingPrisma();
  const records = new WhatsAppRecords(db as never, { hash: (n: string) => recipientHash(n, KEY) } as never);
  const registered: unknown[] = [];
  const service = {
    register: async (input: unknown) => {
      registered.push(input);
      return { companyId: 'c', publicStoreId: 'P', status: 'pending_activation', created: true, trialEligible: true, activity: 'electronics' };
    },
    pendingOwnerFor: async () => ({ companyId: COMPANY, userId: USER, destinationMasked: '+222***87', channel: 'phone' }),
  };
  const continuation = { issue: async () => ({ token: 't'.repeat(43), expiresAt: '2026-10-17T10:15:00.000Z' }) };
  const delivery = { canDeliver: jest.fn(opts.canDeliver ?? (() => true)) };
  const config = { whatsappChannel: 'cloud', whatsappMode: opts.mode ?? 'live' };
  const flow = new RegistrationFlowService(service as never, continuation as never, delivery as never, config as never, records);
  return { flow, db, registered, delivery };
}

describe('Owner registration', () => {
  it('while WhatsApp runs live, a number without the consent is refused before anything is saved', async () => {
    const { flow, registered, db } = registration();
    const refusal = await flow.register(ATTEMPT as never).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(BadRequestException);
    expect((refusal as BadRequestException).getResponse()).toMatchObject({ code: 'whatsapp_consent_required', currentVersion: WHATSAPP_CONSENT_VERSION });
    expect(registered).toEqual([]);
    expect(db.whatsAppConsent.rows).toEqual([]);
  });

  it('a stale consent version is refused in any mode', async () => {
    const { flow, registered } = registration({ mode: 'test' });
    const refusal = await flow.register({ ...ATTEMPT, whatsappConsentVersion: 'wa-consent-2020-01-01' } as never).catch((e: unknown) => e);
    expect((refusal as BadRequestException).getResponse()).toMatchObject({ code: 'whatsapp_consent_outdated' });
    expect(registered).toEqual([]);
  });

  it('records the consent against the new Owner, with its version, purposes and an audit event', async () => {
    const { flow, db } = registration();
    await flow.register({ ...ATTEMPT, whatsappConsentVersion: WHATSAPP_CONSENT_VERSION } as never);
    expect(db.whatsAppConsent.rows).toEqual([
      expect.objectContaining({ event: 'granted', version: WHATSAPP_CONSENT_VERSION, actorCompanyId: COMPANY, actorUserId: USER, source: 'owner_registration', numberMasked: '+222***87', numberHash: recipientHash(OWNER_NUMBER, KEY) }),
    ]);
    expect(db.auditLog.rows).toEqual([expect.objectContaining({ entityType: 'WhatsAppConsent', action: 'create', companyId: COMPANY, userId: USER })]);
  });

  it('asks the delivery check about THIS number, so test mode refuses a number outside its allowlist up front', async () => {
    const { flow, registered, delivery } = registration({ mode: 'test', canDeliver: (channel, destination) => channel !== 'phone' || destination === '+22236963839' });
    const refusal = await flow.register(ATTEMPT as never).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ServiceUnavailableException);
    expect((refusal as ServiceUnavailableException).getResponse()).toMatchObject({ code: 'registration_unavailable', unavailableContacts: ['phone'] });
    expect(delivery.canDeliver).toHaveBeenCalledWith('phone', OWNER_NUMBER);
    expect(registered).toEqual([]);
  });

  it('an email-only registration needs no WhatsApp consent', async () => {
    const { flow, registered } = registration();
    await flow.register({ ...ATTEMPT, phone: undefined, email: 'aicha@shop.mr' } as never);
    expect(registered).toHaveLength(1);
  });
});

describe('the contact delivery check', () => {
  it('a governed channel in test mode reaches only its allowlist; nothing falls back to email', () => {
    const records = new WhatsAppRecords(fakeMessagingPrisma() as never, { hash: (n: string) => recipientHash(n, KEY) } as never);
    const raw = { name: 'cloud-api', isEnabled: true, send: jest.fn() };
    const governed = new GovernedWhatsAppChannel(raw, { mode: 'test', testRecipients: new Set(['+22236963839']), liveSends: false, phoneNumberId: '1', maxPerSecond: 10, recipientMinIntervalMs: 0 }, records);
    const email = { name: 'smtp', isEnabled: true, send: jest.fn() };
    const provider = new WhatsAppContactDeliveryProvider(governed, { send: jest.fn() } as never, email);
    expect(provider.canDeliver('phone', '+22236963839')).toBe(true);
    expect(provider.canDeliver('phone', OWNER_NUMBER)).toBe(false);
    expect(provider.canDeliver('email', 'aicha@shop.mr')).toBe(true);
  });
});

describe('my WhatsApp consent, in the account', () => {
  function account(opts: { verified?: boolean; canDeliverTo?: boolean; mode?: 'test' | 'live' } = {}) {
    const db = fakeMessagingPrisma();
    const records = new WhatsAppRecords(db as never, { hash: (n: string) => recipientHash(n, KEY) } as never);
    const prisma = {
      user: {
        // The caller's own row; nobody else in the business holds the number.
        findFirst: jest.fn(async (args: { where: { id?: unknown } }) => (args.where.id && typeof args.where.id === 'object' && 'not' in (args.where.id as object) ? null : {
          id: USER,
          phone: opts.verified === false ? null : OWNER_NUMBER,
          phoneVerifiedAt: opts.verified === false ? null : new Date(),
          passwordHash: 'h',
        })),
      },
      auditLog: { create: jest.fn() },
    };
    const otp = {
      canDeliver: true,
      canDeliverTo: jest.fn(() => opts.canDeliverTo ?? true),
      request: jest.fn(async () => ({ ok: true, challenge: { challengeId: 'c', destinationMasked: '+222***99', expiresAt: 'x', attemptsRemaining: 5, resendAvailableAt: null, delivered: true } })),
    };
    const hashing = { verify: async () => true, verifyDummy: async () => false };
    const config = { whatsappChannel: 'cloud', whatsappMode: opts.mode ?? 'live' };
    const service = new AccountService(prisma as never, hashing as never, otp as never, {} as never, {} as never, config as never, records);
    return { service, db, otp };
  }
  const me = { userId: USER, companyId: COMPANY, sessionId: Buffer.alloc(16, 3) };

  it('a withdrawal answers with what becomes unavailable — never pretending security continues without the channel', async () => {
    const { service, db } = account();
    const view = await service.optOutWhatsapp(me, 'all', 'fr');
    expect(view).toMatchObject({ optOut: 'all', consented: false, number: expect.stringMatching(/\*\*\*/) });
    expect(view.unavailable).toEqual(['sign_in_verification', 'account_recovery', 'employee_invitation_verification', 'security_verification', 'account_deletion']);
    expect(view.explanation).toMatch(/indisponible/);
    expect(db.whatsAppConsent.rows).toEqual([expect.objectContaining({ event: 'withdrawn', source: 'account', actorUserId: USER })]);
    expect(db.auditLog.rows).toEqual([expect.objectContaining({ entityType: 'WhatsAppConsent', reason: 'WhatsApp withdrawn as the account contact' })]);
  });

  it('stopping optional notices keeps every account function', async () => {
    const view = await account().service.optOutWhatsapp(me, 'optional');
    expect(view).toMatchObject({ optOut: 'optional', unavailable: [], explanation: null });
  });

  it('agreeing again ends the withdrawal; it needs the current version and a verified number', async () => {
    const { service } = account();
    await service.optOutWhatsapp(me, 'all');
    const view = await service.grantWhatsappConsent(me, WHATSAPP_CONSENT_VERSION);
    expect(view).toMatchObject({ optOut: 'none', consented: true, unavailable: [] });
    await expect(service.grantWhatsappConsent(me, 'old')).rejects.toBeInstanceOf(BadRequestException);
    const unverified = account({ verified: false });
    await expect(unverified.service.grantWhatsappConsent(me, WHATSAPP_CONSENT_VERSION)).rejects.toMatchObject({ response: { code: 'whatsapp_number_required' } });
    await expect(unverified.service.optOutWhatsapp(me, 'all')).rejects.toBeInstanceOf(HttpException);
  });

  it('number verification takes the consent with the code request, and records it', async () => {
    const { service, db, otp } = account();
    await expect(service.startPhoneVerification(me, { phone: '+22244556699', password: 'p' })).rejects.toMatchObject({ response: { code: 'whatsapp_consent_required' } });
    expect(otp.request).not.toHaveBeenCalled();
    await service.startPhoneVerification(me, { phone: '+22244556699', password: 'p', whatsappConsentVersion: WHATSAPP_CONSENT_VERSION });
    expect(db.whatsAppConsent.rows).toEqual([expect.objectContaining({ source: 'phone_verification', numberHash: recipientHash('+22244556699', KEY) })]);
  });

  it('number verification refuses up front a number the channel would not send to (test mode), creating no code', async () => {
    const { service, otp } = account({ canDeliverTo: false, mode: 'test' });
    await expect(service.startPhoneVerification(me, { phone: '+22244556699', password: 'p' })).rejects.toMatchObject({ response: { code: 'verification_unavailable' } });
    expect(otp.request).not.toHaveBeenCalled();
  });
});
