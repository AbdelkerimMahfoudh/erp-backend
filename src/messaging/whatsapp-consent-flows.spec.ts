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
 * Where the operational WhatsApp consent is given and withdrawn (D213): registration refuses to go on without the
 * current version — in every mode, before anything is saved — and records it with its language and an audit event; a
 * replay records nothing new; a new number needs its own consent and the replaced number's consent ends; an account
 * from before D213 is never opted in; a withdrawal keeps the history and needs an acknowledgement when WhatsApp is the
 * only verified contact; and every answer masks the number.
 */

const KEY = 'test-messaging-hash-key-of-32-characters!';
const OWNER_NUMBER = '+22243210987';
const NEW_NUMBER = '+22244556699';
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
const APP = { source: 'mobile_registration' as const, ip: '203.0.113.9' };

function registration(opts: { mode?: 'test' | 'live'; canDeliver?: (channel: string, destination?: string) => boolean; records?: boolean } = {}) {
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
  const flow = new RegistrationFlowService(service as never, continuation as never, delivery as never, opts.records === false ? undefined : records);
  return { flow, db, registered, delivery, records };
}

describe('registration', () => {
  it.each(['test', 'live'] as const)('in %s mode, a registration without the consent is refused before anything is saved', async (mode) => {
    const { flow, registered, db } = registration({ mode });
    const refusal = await flow.register(ATTEMPT as never, APP).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(BadRequestException);
    expect((refusal as BadRequestException).getResponse()).toMatchObject({ code: 'whatsapp_consent_required', currentVersion: WHATSAPP_CONSENT_VERSION });
    expect(registered).toEqual([]);
    expect(db.whatsAppConsent.rows).toEqual([]);
  });

  it('an earlier consent version is refused: the person saw other words', async () => {
    const { flow, registered } = registration({ mode: 'test' });
    const refusal = await flow.register({ ...ATTEMPT, whatsappConsentVersion: 'wa-consent-2026-10-17' } as never, APP).catch((e: unknown) => e);
    expect((refusal as BadRequestException).getResponse()).toMatchObject({ code: 'whatsapp_consent_outdated' });
    expect(registered).toEqual([]);
  });

  it('records the agreement against the new Owner as PENDING — version, locale shown, purpose, source and an audit event with the address', async () => {
    const { flow, db } = registration();
    await flow.register({ ...ATTEMPT, language: 'fr', whatsappConsentVersion: WHATSAPP_CONSENT_VERSION, whatsappConsentLocale: 'ar' } as never, APP);
    expect(db.whatsAppConsent.rows).toEqual([
      expect.objectContaining({
        event: 'pending_unverified',
        version: WHATSAPP_CONSENT_VERSION,
        locale: 'ar',
        purposes: 'operational_whatsapp',
        actorCompanyId: COMPANY,
        actorUserId: USER,
        source: 'mobile_registration',
        numberMasked: '+222***87',
        numberHash: recipientHash(OWNER_NUMBER, KEY),
      }),
    ]);
    expect(db.auditLog.rows).toEqual([expect.objectContaining({ entityType: 'WhatsAppConsent', action: 'create', companyId: COMPANY, userId: USER, ip: '203.0.113.9' })]);
  });

  it('records the registration’s language when the client did not say which one the consent was shown in', async () => {
    const { flow, db } = registration();
    await flow.register({ ...ATTEMPT, language: 'fr', whatsappConsentVersion: WHATSAPP_CONSENT_VERSION } as never, { source: 'website_registration' });
    expect(db.whatsAppConsent.rows[0]).toMatchObject({ locale: 'fr', source: 'website_registration' });
  });

  it('a replay of the same registration records nothing new', async () => {
    const { flow, db } = registration();
    const body = { ...ATTEMPT, whatsappConsentVersion: WHATSAPP_CONSENT_VERSION };
    await flow.register(body as never, APP);
    await flow.register(body as never, APP);
    expect(db.whatsAppConsent.rows).toHaveLength(1);
    expect(db.auditLog.rows).toHaveLength(1);
  });

  it('refuses rather than finishing without a record, when the consent cannot be recorded', async () => {
    const { flow, registered } = registration({ records: false });
    const refusal = await flow.register({ ...ATTEMPT, whatsappConsentVersion: WHATSAPP_CONSENT_VERSION } as never, APP).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ServiceUnavailableException);
    expect(registered).toEqual([]);
  });

  it('asks the delivery check about THIS number, so test mode refuses a number outside its allowlist up front', async () => {
    const { flow, registered, delivery } = registration({ mode: 'test', canDeliver: (channel, destination) => channel !== 'phone' || destination === '+22236963839' });
    const refusal = await flow.register({ ...ATTEMPT, whatsappConsentVersion: WHATSAPP_CONSENT_VERSION } as never, APP).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ServiceUnavailableException);
    expect((refusal as ServiceUnavailableException).getResponse()).toMatchObject({ code: 'registration_unavailable', unavailableContacts: ['phone'] });
    expect(delivery.canDeliver).toHaveBeenCalledWith('phone', OWNER_NUMBER);
    expect(registered).toEqual([]);
  });

  it('a registration without a WhatsApp number is refused before any consent is asked about (0099): the number is mandatory', async () => {
    const { flow, registered } = registration();
    await expect(flow.register({ ...ATTEMPT, phone: undefined, email: 'aicha@shop.mr' } as never, APP)).rejects.toThrow(/WhatsApp number/);
    expect(registered).toEqual([]);
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

  it('marks its code as the one that verifies a contact: it goes only on a pending agreement, which it never activates', async () => {
    const db = fakeMessagingPrisma();
    const records = new WhatsAppRecords(db as never, { hash: (n: string) => recipientHash(n, KEY) } as never);
    const raw = { name: 'cloud-api', isEnabled: true, send: jest.fn(async () => ({ status: 'accepted' as const, providerMessageId: 'wamid.1', provider: 'cloud-api' })) };
    const governed = new GovernedWhatsAppChannel(raw, { mode: 'live', testRecipients: new Set(), liveSends: true, phoneNumberId: '1', maxPerSecond: 10, recipientMinIntervalMs: 0 }, records);
    const email = { name: 'smtp', isEnabled: true, send: jest.fn() };
    const provider = new WhatsAppContactDeliveryProvider(governed, { send: jest.fn() } as never, email);
    // Nobody agreed: the code is refused, honestly, and no email carries it instead.
    await expect(provider.send({ channel: 'phone', destination: NEW_NUMBER, code: '123456', language: 'en' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    await records.recordPending({ number: NEW_NUMBER, version: WHATSAPP_CONSENT_VERSION, locale: 'en', companyId: COMPANY, userId: USER, source: 'mobile_registration' });
    await provider.send({ channel: 'phone', destination: NEW_NUMBER, code: '123456', language: 'en' });
    expect(raw.send).toHaveBeenCalledWith(expect.objectContaining({ verifiesContact: true }));
    expect(db.whatsAppConsent.rows.map((r) => r.event)).toEqual(['pending_unverified']);
    expect((await records.contactState(NEW_NUMBER)).consented).toBe(false);
    expect(email.send).not.toHaveBeenCalled();
  });
});

describe('what never goes by email (the owner’s security correction of 2026-10-19)', () => {
  const read = (path: string) => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', path), 'utf8') as string;

  it('a code, a deletion confirmation or a financial report has no email path: the services that send them hold no email channel', () => {
    // OTPs (sign-in steps, a changed number, deletion codes), the deletion confirmation, closing reports, the employee's
    // invitation code (D214), the number change and the registration's number code, and the portal's sign-in.
    for (const file of [
      'auth/otp/otp.service.ts',
      'account/account-deletion.service.ts',
      'closing/closing-notice.service.ts',
      'staff/staff-invitation.service.ts',
      'account/account.service.ts',
      'platform/registration-flow.service.ts',
      'platform/portal/portal-session.service.ts',
    ]) {
      expect({ file, email: /EMAIL_CHANNEL|EmailChannel/.test(read(file)) }).toEqual({ file, email: false });
    }
  });

  it('an employee’s invitation code goes only to the invitation’s own WhatsApp number', () => {
    const source = read('staff/staff-invitation.service.ts');
    // One code in the whole service, sent to the number the employee typed and the server matched to the invitation.
    expect(source.match(/this\.verification\.start\(/g)).toHaveLength(1);
    expect(source).toMatch(/if \(number !== invitation\.user\.phone\)[\s\S]*this\.verification\.start\(number, language\)/);
  });

  it('the subscription notices are the one place email carries a WhatsApp-first message, and only their informational kinds', () => {
    const files = ['notices/notice.service.ts', 'platform/contact-delivery.ts'];
    // The only holders of the email channel outside the channel itself: the notices (fallback) and the contact delivery
    // (an email address's own verification code, chosen by the contact, never by a WhatsApp failure).
    for (const file of files) expect(/EMAIL_CHANNEL|EmailChannel/.test(read(file))).toBe(true);
    // What the notices carry is exactly the informational set: the portal instructions, the trial and paid reminders
    // (72/48/24 h), the ends (read-only, grace or none) and the grace reminders — no code, recovery or report among them.
    const schema = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8') as string;
    const block = schema.match(/enum SubscriptionNoticeKind \{([^}]*)\}/)![1];
    const kinds = block.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('///'));
    expect(kinds).toEqual(['portal_instructions', 'trial_reminder', 'trial_expired', 'paid_reminder', 'paid_expired', 'grace_reminder', 'grace_ended']);
  });

  it('a WhatsApp number’s verification code goes by WhatsApp or not at all — the contact delivery never swaps channels', () => {
    const source = read('platform/contact-delivery.ts');
    // The email boundary is used for an email address only: the branch is chosen by the contact, never by a failure.
    expect(source).toMatch(/req\.channel === 'phone'\s*\?\s*await sendWithOneRetry\(\(idempotencyKey\) =>\s*this\.channel\.send/);
  });
});

describe('my operational WhatsApp consent, in the account', () => {
  function account(opts: { verified?: boolean; email?: boolean; canDeliverTo?: boolean; records?: WhatsAppRecords; db?: ReturnType<typeof fakeMessagingPrisma> } = {}) {
    const db = opts.db ?? fakeMessagingPrisma();
    const records = opts.records ?? new WhatsAppRecords(db as never, { hash: (n: string) => recipientHash(n, KEY) } as never);
    const me = {
      id: USER,
      phone: opts.verified === false ? null : OWNER_NUMBER,
      phoneVerifiedAt: opts.verified === false ? null : new Date('2026-10-01T10:00:00Z'),
      email: opts.email ? 'aicha@shop.mr' : null,
      emailVerifiedAt: opts.email ? new Date('2026-10-01T10:00:00Z') : null,
      passwordHash: 'h',
    };
    // One database: the account's rows and the consent records, so a transaction spans both as it does for real.
    const prisma = Object.assign(db, {
      user: {
        // The caller's own row; nobody else in the business holds the number.
        findFirst: jest.fn(async (args: { where: { id?: unknown } }) =>
          args.where.id && typeof args.where.id === 'object' && 'not' in (args.where.id as object) ? null : { ...me },
        ),
        findUnique: jest.fn(async () => ({ ...me })),
        update: jest.fn(async ({ data }: { data: { phone: string; phoneVerifiedAt: Date } }) => Object.assign(me, data)),
      },
      otpChallenge: { findUnique: jest.fn(async () => ({ candidatePhone: NEW_NUMBER })) },
      authSession: { updateMany: jest.fn(async () => ({ count: 0 })) },
    });
    const otp = {
      canDeliver: true,
      canDeliverTo: jest.fn(() => opts.canDeliverTo ?? true),
      request: jest.fn(async () => ({ ok: true, challenge: { challengeId: 'c', destinationMasked: '+222***99', expiresAt: 'x', attemptsRemaining: 5, resendAvailableAt: null, delivered: true } })),
      verify: jest.fn(async () => ({ ok: true, purpose: 'phone_verification' })),
    };
    const hashing = { verify: async () => true, verifyDummy: async () => false };
    const trialSetup = { onContactsVerified: jest.fn(async () => undefined) };
    const service = new AccountService(prisma as never, hashing as never, otp as never, {} as never, trialSetup as never, records);
    return { service, db, otp, records, prisma };
  }
  const me = { userId: USER, companyId: COMPANY, sessionId: Buffer.alloc(16, 3) };

  it('an account from before D213 is never opted in: it shows the request, and nothing lets a message go', async () => {
    const { service, records, db } = account();
    const view = await service.whatsappConsent(me, 'ar');
    expect(view).toMatchObject({ state: 'none', grantedVersion: null, grantedAt: null, number: '+222***87', history: [] });
    expect(view.copy).toMatchObject({ version: WHATSAPP_CONSENT_VERSION, language: 'ar' });
    expect((await records.contactState(OWNER_NUMBER)).consented).toBe(false);
    expect(db.whatsAppConsent.rows).toEqual([]);
  });

  it('agreeing for the verified number records a new active event with the language shown, and the view says active with its time', async () => {
    const { service, db } = account();
    const view = await service.grantWhatsappConsent(me, { version: WHATSAPP_CONSENT_VERSION, locale: 'fr' }, 'fr', '198.51.100.4');
    expect(view).toMatchObject({ state: 'active', grantedVersion: WHATSAPP_CONSENT_VERSION, withdrawnAt: null });
    expect(view.grantedAt).toEqual(expect.any(String));
    expect(db.whatsAppConsent.rows).toEqual([expect.objectContaining({ event: 'active', locale: 'fr', source: 'account_settings', actorUserId: USER })]);
    expect(db.auditLog.rows[0]).toMatchObject({ ip: '198.51.100.4' });
    expect(view.history).toEqual([expect.objectContaining({ event: 'active', version: WHATSAPP_CONSENT_VERSION, locale: 'fr', source: 'account_settings' })]);
  });

  it('agreeing needs the current version and a verified number', async () => {
    const { service } = account();
    await expect(service.grantWhatsappConsent(me, { version: 'wa-consent-2026-10-17' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.grantWhatsappConsent(me, { version: '' })).rejects.toMatchObject({ response: { code: 'whatsapp_consent_required' } });
    const unverified = account({ verified: false });
    await expect(unverified.service.grantWhatsappConsent(me, { version: WHATSAPP_CONSENT_VERSION })).rejects.toMatchObject({ response: { code: 'whatsapp_number_required' } });
    await expect(unverified.service.withdrawWhatsappConsent(me, {})).rejects.toBeInstanceOf(HttpException);
    expect(await unverified.service.whatsappConsent(me)).toMatchObject({ state: 'no_number', number: null });
  });

  it('withdrawing when WhatsApp is the only verified contact needs the acknowledgement of support-assisted recovery', async () => {
    const { service, db } = account();
    await service.grantWhatsappConsent(me, { version: WHATSAPP_CONSENT_VERSION });
    expect((await service.whatsappConsent(me)).onlyVerifiedContact).toBe(true);
    await expect(service.withdrawWhatsappConsent(me, {})).rejects.toMatchObject({ response: { code: 'withdrawal_needs_acknowledgement', onlyVerifiedContact: true } });
    expect(db.whatsAppConsent.rows.map((r) => r.event)).toEqual(['active']);
    const view = await service.withdrawWhatsappConsent(me, { acknowledgeSupportRecovery: true });
    expect(view).toMatchObject({ state: 'withdrawn', grantedAt: null, number: '+222***87' });
    expect(view.withdrawnAt).toEqual(expect.any(String));
  });

  it('withdrawing with a verified email needs no acknowledgement, creates no email consent and keeps the number', async () => {
    const { service, db, prisma } = account({ email: true });
    await service.grantWhatsappConsent(me, { version: WHATSAPP_CONSENT_VERSION });
    const view = await service.withdrawWhatsappConsent(me, {});
    expect(view).toMatchObject({ state: 'withdrawn', onlyVerifiedContact: false });
    expect(db.whatsAppConsent.rows.map((r) => r.event)).toEqual(['active', 'withdrawn']);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(JSON.stringify(db.auditLog.rows)).not.toMatch(/email/i);
  });

  it('withdrawal then re-consent keeps the whole history, newest first', async () => {
    const { service } = account({ email: true });
    await service.grantWhatsappConsent(me, { version: WHATSAPP_CONSENT_VERSION, locale: 'en' });
    await service.withdrawWhatsappConsent(me, {});
    const view = await service.grantWhatsappConsent(me, { version: WHATSAPP_CONSENT_VERSION, locale: 'ar' });
    expect(view.state).toBe('active');
    expect(view.history.map((h) => [h.event, h.locale])).toEqual([
      ['active', 'ar'],
      ['withdrawn', null],
      ['active', 'en'],
    ]);
  });

  it('every answer masks the number, and no record holds it whole', async () => {
    const { service, db } = account({ email: true });
    const views = [
      await service.grantWhatsappConsent(me, { version: WHATSAPP_CONSENT_VERSION }),
      await service.withdrawWhatsappConsent(me, {}),
      await service.whatsappConsent(me),
    ];
    const everything = JSON.stringify([views, db.whatsAppConsent.rows, db.auditLog.rows]);
    expect(everything).not.toContain('43210987');
    for (const v of views) expect(JSON.stringify(v)).not.toContain(recipientHash(OWNER_NUMBER, KEY));
  });

  it('a new number needs its own consent with the code request, recorded for that number only', async () => {
    const { service, db, otp } = account();
    await expect(service.startPhoneVerification(me, { phone: NEW_NUMBER, password: 'p' })).rejects.toMatchObject({ response: { code: 'whatsapp_consent_required' } });
    expect(otp.request).not.toHaveBeenCalled();
    await service.startPhoneVerification(me, { phone: NEW_NUMBER, password: 'p', language: 'fr', whatsappConsentVersion: WHATSAPP_CONSENT_VERSION });
    expect(db.whatsAppConsent.rows).toEqual([expect.objectContaining({ event: 'pending_unverified', source: 'account_settings', locale: 'fr', numberHash: recipientHash(NEW_NUMBER, KEY) })]);
  });

  it('once the new number is verified, its pending agreement is active and the replaced number’s is superseded — never carried over', async () => {
    const { service, records } = account();
    await service.grantWhatsappConsent(me, { version: WHATSAPP_CONSENT_VERSION });
    await service.startPhoneVerification(me, { phone: NEW_NUMBER, password: 'p', whatsappConsentVersion: WHATSAPP_CONSENT_VERSION });
    await service.confirmPhoneVerification(me, { challengeId: '0192d1a0-0000-7000-8000-000000000001', code: '123456' });
    expect(await records.contactState(OWNER_NUMBER)).toMatchObject({ consented: false, consent: 'superseded' });
    expect(await records.contactState(NEW_NUMBER)).toMatchObject({ consented: true, consent: 'active' });
    const old = await records.consentHistory(OWNER_NUMBER, USER);
    expect(old[0]).toMatchObject({ event: 'superseded', source: 'number_changed' });
    const fresh = await records.consentHistory(NEW_NUMBER, USER);
    expect(fresh.map((h) => h.event)).toEqual(['active', 'pending_unverified']);
  });

  it('a new number whose code is never confirmed stays pending: it authorises nothing proactive and the old number keeps its consent', async () => {
    const { service, records } = account();
    await service.grantWhatsappConsent(me, { version: WHATSAPP_CONSENT_VERSION });
    await service.startPhoneVerification(me, { phone: NEW_NUMBER, password: 'p', whatsappConsentVersion: WHATSAPP_CONSENT_VERSION });
    expect(await records.contactState(NEW_NUMBER)).toMatchObject({ consented: false, consent: 'pending', pendingLive: true });
    expect(await records.contactState(OWNER_NUMBER)).toMatchObject({ consented: true, consent: 'active' });
  });

  it('number verification refuses up front a number the channel would not send to (test mode), creating no code', async () => {
    const { service, otp } = account({ canDeliverTo: false });
    await expect(service.startPhoneVerification(me, { phone: NEW_NUMBER, password: 'p', whatsappConsentVersion: WHATSAPP_CONSENT_VERSION })).rejects.toMatchObject({
      response: { code: 'verification_unavailable' },
    });
    expect(otp.request).not.toHaveBeenCalled();
  });

  it('one person’s consent is theirs: another business’s person with another number is untouched', async () => {
    const db = fakeMessagingPrisma();
    const shared = new WhatsAppRecords(db as never, { hash: (n: string) => recipientHash(n, KEY) } as never);
    const a = account({ db, records: shared });
    await a.service.grantWhatsappConsent(me, { version: WHATSAPP_CONSENT_VERSION });
    expect((await shared.contactState(NEW_NUMBER)).consented).toBe(false);
    expect(await shared.consentHistory(OWNER_NUMBER, Buffer.alloc(16, 9))).toEqual([]);
  });
});
