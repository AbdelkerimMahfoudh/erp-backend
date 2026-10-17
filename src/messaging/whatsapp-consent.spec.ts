import { BadRequestException } from '@nestjs/common';
import {
  acceptedConsentVersion,
  consentCopy,
  consentRequired,
  foldKeyword,
  MANDATORY_PURPOSES,
  optOutSignalOf,
  UNAVAILABLE_WITHOUT_WHATSAPP,
  WHATSAPP_CONSENT_VERSION,
  withdrawnExplanation,
} from './whatsapp-consent';
import { nextStatus, serviceWindowOpen, WhatsAppRecords } from './whatsapp-records';
import { recipientHash } from './recipient-hash';
import { fakeMessagingPrisma } from './__testing__/fake-messaging-prisma';

/**
 * WhatsApp consent and opt-out (D181 §3, §5): a versioned copy that names WhatsApp as the mandatory account contact,
 * opt-out keywords decided in memory, the consent history with its audit event, and forward-only statuses.
 */

const KEY = 'test-messaging-hash-key-of-32-characters!';
const NUMBER = '+22236963839';
const COMPANY = Buffer.alloc(16, 1);
const USER = Buffer.alloc(16, 2);

function records() {
  const db = fakeMessagingPrisma();
  return { db, records: new WhatsAppRecords(db as never, { hash: (n: string) => recipientHash(n, KEY) } as never) };
}

describe('the consent copy', () => {
  it('names WhatsApp as the mandatory verified contact and every purpose, in EN, FR and AR, under one version', () => {
    const en = consentCopy('en');
    expect(en.version).toBe(WHATSAPP_CONSENT_VERSION);
    expect(en.body).toMatch(/verified contact/);
    for (const phrase of ['sign in', 'recover your account', 'employees you invite', 'security alerts', 'account deletion']) expect(en.body).toContain(phrase);
    expect(en.body).toMatch(/never send marketing/);
    expect(consentCopy('fr').body).toMatch(/contact vérifié/);
    expect(consentCopy('ar').body).toMatch(/جهة اتصال موثّقة/);
    expect(new Set(['en', 'fr', 'ar'].map((l) => consentCopy(l as 'en').version)).size).toBe(1);
    expect([...MANDATORY_PURPOSES]).toEqual(['authentication', 'account_recovery', 'employee_invitations', 'security_alerts', 'account_deletion']);
  });

  it('says plainly what a withdrawal makes unavailable', () => {
    expect([...UNAVAILABLE_WITHOUT_WHATSAPP]).toContain('account_deletion');
    expect(withdrawnExplanation('en')).toMatch(/unavailable/);
    expect(withdrawnExplanation('fr')).toMatch(/indisponible/);
    expect(withdrawnExplanation('ar')).toMatch(/لا يتاح/);
  });

  it('is required only when the Cloud API sends live', () => {
    expect(consentRequired('cloud', 'live')).toBe(true);
    expect(consentRequired('cloud-api', 'live')).toBe(true);
    expect(consentRequired('cloud', 'test')).toBe(false);
    expect(consentRequired('disabled', 'live')).toBe(false);
  });

  it('refuses a stale version always, and a missing one when required', () => {
    expect(acceptedConsentVersion(WHATSAPP_CONSENT_VERSION, true)).toBe(WHATSAPP_CONSENT_VERSION);
    expect(acceptedConsentVersion(undefined, false)).toBeNull();
    expect(() => acceptedConsentVersion('wa-consent-2020-01-01', false)).toThrow(BadRequestException);
    try {
      acceptedConsentVersion(undefined, true);
    } catch (e) {
      expect((e as BadRequestException).getResponse()).toMatchObject({ code: 'whatsapp_consent_required', currentVersion: WHATSAPP_CONSENT_VERSION });
    }
    expect(() => acceptedConsentVersion('', true)).toThrow(/agreement/);
  });
});

describe('opt-out keywords, decided in memory', () => {
  it.each([
    ['STOP', 'stop'],
    [' stop! ', 'stop'],
    ['Stop all', 'stop'],
    ['ARRÊT', 'stop'],
    ['désabonner', 'stop'],
    ['توقف', 'stop'],
    ['إيقاف', 'stop'],
    ['إلغاء', 'stop'],
    ['START', 'start'],
    ['Reprendre', 'start'],
    ['ابدأ', 'start'],
  ])('%p → %p', (text, signal) => {
    expect(optOutSignalOf(text)).toBe(signal);
  });

  it.each(['please do not stop', 'STOPPED', 'my code is 123456', '', 'x'.repeat(41)])('%p is not a keyword', (text) => {
    expect(optOutSignalOf(text)).toBeNull();
  });

  it('folds case, accents, Arabic variants and punctuation, and nothing else', () => {
    expect(foldKeyword('  Arrêt.  ')).toBe('ARRET');
    expect(foldKeyword('إلغاءُ')).toBe('الغاء');
    expect(optOutSignalOf(42)).toBeNull();
  });
});

describe('statuses move forward only', () => {
  it.each([
    ['accepted', 'sent', 'sent'],
    ['accepted', 'delivered', 'delivered'],
    ['sent', 'read', 'read'],
    ['delivered', 'sent', null],
    ['read', 'delivered', null],
    ['accepted', 'failed', 'failed'],
    ['sent', 'failed', 'failed'],
    ['delivered', 'failed', null],
    ['read', 'failed', null],
    ['failed', 'delivered', null],
    ['refused', 'sent', null],
    ['accepted', 'deleted', null],
    ['accepted', 'accepted', null],
  ])('%s + %s → %s', (current, incoming, expected) => {
    expect(nextStatus(current, incoming)).toBe(expected);
  });
});

describe('the 24-hour customer-service window', () => {
  it('is open for 24 hours after the last inbound message, and never before one', () => {
    const now = new Date('2026-10-17T12:00:00Z');
    expect(serviceWindowOpen(null, now)).toBe(false);
    expect(serviceWindowOpen(new Date('2026-10-16T12:00:01Z'), now)).toBe(true);
    expect(serviceWindowOpen(new Date('2026-10-16T12:00:00Z'), now)).toBe(false);
    expect(serviceWindowOpen(new Date('2026-10-17T12:00:01Z'), now)).toBe(false);
  });
});

describe('the consent history', () => {
  it('records a grant with its version, purposes, masked number and keyed hash, audits it, and ends any opt-out', async () => {
    const { db, records: r } = records();
    await r.optOut({ number: NUMBER, scope: 'optional', companyId: COMPANY, userId: USER });
    await r.recordConsent({ number: NUMBER, version: WHATSAPP_CONSENT_VERSION, companyId: COMPANY, userId: USER, source: 'owner_registration' });
    const grant = db.whatsAppConsent.rows.find((x) => x.event === 'granted')!;
    expect(grant).toMatchObject({
      version: WHATSAPP_CONSENT_VERSION,
      purposes: 'authentication,account_recovery,employee_invitations,security_alerts,account_deletion,operational_notices',
      numberMasked: '+222***39',
      numberHash: recipientHash(NUMBER, KEY),
      actorCompanyId: COMPANY,
      actorUserId: USER,
      source: 'owner_registration',
    });
    expect(db.auditLog.rows.map((a) => a.reason)).toEqual(['Optional WhatsApp notifications stopped', 'WhatsApp consent granted']);
    expect(JSON.stringify(db.auditLog.rows)).not.toContain('36963839');
    const state = await r.contactState(NUMBER);
    expect(state).toMatchObject({ optOutScope: 'none', consented: true });
  });

  it('refuses an unknown version even if a caller skipped the check', async () => {
    await expect(records().records.recordConsent({ number: NUMBER, version: 'v0', companyId: null, userId: null, source: 'account' })).rejects.toThrow(/Unknown/);
  });

  it('a withdrawal ends the consent; an optional opt-out never relaxes a withdrawal', async () => {
    const { records: r } = records();
    await r.recordConsent({ number: NUMBER, version: WHATSAPP_CONSENT_VERSION, companyId: COMPANY, userId: USER, source: 'account' });
    expect(await r.optOut({ number: NUMBER, scope: 'all', companyId: COMPANY, userId: USER })).toBe('all');
    expect((await r.contactState(NUMBER)).consented).toBe(false);
    expect(await r.optOut({ number: NUMBER, scope: 'optional', companyId: COMPANY, userId: USER })).toBe('all');
  });

  it('an inbound message only moves the window forward', async () => {
    const { records: r } = records();
    const hash = recipientHash(NUMBER, KEY);
    await r.applyInbound(hash, '+222***39', new Date('2026-10-17T10:00:00Z'), null);
    await r.applyInbound(hash, '+222***39', new Date('2026-10-17T09:00:00Z'), null);
    expect((await r.contactState(NUMBER)).lastInboundAt).toEqual(new Date('2026-10-17T10:00:00Z'));
  });
});
