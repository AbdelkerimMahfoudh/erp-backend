import { BadRequestException } from '@nestjs/common';
import {
  acceptedConsentVersion,
  CONSENT_PURPOSES,
  consentCopy,
  consentLocaleOf,
  foldKeyword,
  isCurrentConsentVersion,
  optOutSignalOf,
  WHATSAPP_CONSENT_VERSION,
} from './whatsapp-consent';
import { ALL_TEMPLATES } from './templates';
import { nextStatus, PENDING_CONSENT_TTL_MS, serviceWindowOpen, WhatsAppRecords } from './whatsapp-records';
import { recipientHash } from './recipient-hash';
import { fakeMessagingPrisma } from './__testing__/fake-messaging-prisma';

/**
 * The operational WhatsApp consent (D213; D181 §3): a versioned copy for operational messages only — never marketing —
 * required in every mode, opt-out keywords decided in memory, an append-only history with its audit event, and
 * forward-only statuses.
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
  it('states exactly the operational purposes, the frequency and that it is not marketing — EN, FR, AR, one version', () => {
    const en = consentCopy('en');
    expect(en.version).toBe(WHATSAPP_CONSENT_VERSION);
    expect(en.agreement).toBe(
      'I agree to receive operational Dukan ERP messages on WhatsApp, including verification and security codes, ' +
        'account setup information, trial and subscription status, expiry reminders and important service notices. ' +
        'Message frequency depends on account activity. This is not consent to marketing messages.',
    );
    expect(en.body).toMatch(/required contact for a Dukan ERP account/);
    expect(consentCopy('fr').agreement).toMatch(/messages opérationnels de Dukan ERP.*pas d’un consentement aux messages marketing/s);
    expect(consentCopy('ar').agreement).toMatch(/رسائل Dukan ERP التشغيلية.*ليست موافقة على تلقي رسائل تسويقية/s);
    expect(new Set(['en', 'fr', 'ar'].map((l) => consentCopy(l as 'en').version)).size).toBe(1);
    for (const l of ['en', 'fr', 'ar'] as const) expect(Object.keys(consentCopy(l)).sort()).toEqual(['agreement', 'body', 'language', 'purposes', 'title', 'version']);
    expect(consentCopy('de' as 'en').language).toBe('en');
  });

  it('names one purpose, operational — no marketing purpose, and no marketing template exists to send under it', () => {
    expect([...CONSENT_PURPOSES]).toEqual(['operational_whatsapp']);
    expect(JSON.stringify(CONSENT_PURPOSES)).not.toMatch(/market|promo/i);
    expect(ALL_TEMPLATES.map((t) => t.category).filter((c) => /market|promo/i.test(c))).toEqual([]);
    expect(ALL_TEMPLATES.map((t) => t.key).filter((k) => /market|promo|offer/i.test(k))).toEqual([]);
  });

  it('is required: a missing version is refused, and so is any version but the one in force', () => {
    expect(acceptedConsentVersion(WHATSAPP_CONSENT_VERSION)).toBe(WHATSAPP_CONSENT_VERSION);
    for (const missing of [undefined, null, '', '   ']) {
      try {
        acceptedConsentVersion(missing);
        throw new Error('not refused');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).getResponse()).toMatchObject({ code: 'whatsapp_consent_required', currentVersion: WHATSAPP_CONSENT_VERSION });
      }
    }
    try {
      acceptedConsentVersion('wa-consent-2026-10-17');
      throw new Error('not refused');
    } catch (e) {
      expect((e as BadRequestException).getResponse()).toMatchObject({ code: 'whatsapp_consent_outdated' });
    }
    expect(isCurrentConsentVersion('wa-consent-2026-10-17')).toBe(false);
  });

  it('records the language it was shown in: one of the three, else the request’s', () => {
    expect(consentLocaleOf('ar', 'en')).toBe('ar');
    expect(consentLocaleOf(undefined, 'fr')).toBe('fr');
    expect(consentLocaleOf('de', 'xx')).toBe('en');
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

describe('the consent history and its lifecycle', () => {
  const OTHER_USER = Buffer.alloc(16, 9);
  const OTHER_COMPANY = Buffer.alloc(16, 8);
  const agree = (r: WhatsAppRecords, over: Partial<Parameters<WhatsAppRecords['recordPending']>[0]> = {}) =>
    r.recordPending({ number: NUMBER, version: WHATSAPP_CONSENT_VERSION, locale: 'fr', companyId: COMPANY, userId: USER, source: 'mobile_registration', ip: '203.0.113.9', ...over });
  const verify = (r: WhatsAppRecords, userId = USER, companyId = COMPANY) => r.activatePending({ number: NUMBER, userId, companyId });
  const grant = (r: WhatsAppRecords, over: Partial<Parameters<WhatsAppRecords['recordConsent']>[0]> = {}) =>
    r.recordConsent({ number: NUMBER, version: WHATSAPP_CONSENT_VERSION, locale: 'fr', companyId: COMPANY, userId: USER, source: 'account_settings', ip: '203.0.113.9', ...over });

  it('a ticked box is PENDING: recorded with version, locale, purpose, source, masked number, keyed hash and an audit event — not a consent', async () => {
    const { db, records: r } = records();
    expect(await agree(r)).toBe('recorded');
    expect(db.whatsAppConsent.rows).toEqual([
      expect.objectContaining({
        event: 'pending_unverified',
        version: WHATSAPP_CONSENT_VERSION,
        locale: 'fr',
        purposes: 'operational_whatsapp',
        numberMasked: '+222***39',
        numberHash: recipientHash(NUMBER, KEY),
        actorCompanyId: COMPANY,
        actorUserId: USER,
        source: 'mobile_registration',
      }),
    ]);
    expect(db.auditLog.rows).toEqual([expect.objectContaining({ ip: '203.0.113.9', entityType: 'WhatsAppConsent', reason: expect.stringMatching(/waiting for the number to be verified/) })]);
    expect(JSON.stringify([db.auditLog.rows, db.whatsAppConsent.rows])).not.toContain('36963839');
    expect(await r.contactState(NUMBER)).toMatchObject({ consented: false, consent: 'pending', pendingLive: true, consentVersion: WHATSAPP_CONSENT_VERSION, consentedAt: null });
  });

  it('verifying the number activates exactly that pending agreement, naming it; a second verification changes nothing', async () => {
    const { db, records: r } = records();
    await agree(r);
    const pendingId = db.whatsAppConsent.rows[0].id as Buffer;
    expect(await verify(r)).toBe('activated');
    expect(db.whatsAppConsent.rows[1]).toMatchObject({ event: 'active', pendingId, version: WHATSAPP_CONSENT_VERSION, locale: 'fr', source: 'mobile_registration', actorUserId: USER });
    expect(await r.contactState(NUMBER)).toMatchObject({ consented: true, consent: 'active', pendingLive: false });
    expect(await verify(r)).toBe('unchanged');
    expect(db.whatsAppConsent.rows).toHaveLength(2);
  });

  it('a replay of the same agreement writes nothing; another person agreeing for the same number is their own pending row', async () => {
    const { db, records: r } = records();
    await agree(r);
    expect(await agree(r)).toBe('unchanged');
    expect(db.whatsAppConsent.rows).toHaveLength(1);
    expect(await agree(r, { userId: OTHER_USER, companyId: OTHER_COMPANY })).toBe('recorded');
    expect(db.whatsAppConsent.rows).toHaveLength(2);
    // Each person's verification activates their own agreement only.
    expect(await verify(r, OTHER_USER, OTHER_COMPANY)).toBe('activated');
    expect(db.whatsAppConsent.rows[2]).toMatchObject({ event: 'active', actorUserId: OTHER_USER, pendingId: db.whatsAppConsent.rows[1].id });
  });

  it('verifying a number nobody agreed for activates nothing — a verified contact is not a consent', async () => {
    const { db, records: r } = records();
    expect(await verify(r)).toBe('no_pending');
    expect(db.whatsAppConsent.rows).toEqual([]);
    expect(await r.contactState(NUMBER)).toMatchObject({ consented: false, consent: 'none' });
  });

  it('an agreement left 24 hours unverified expires: it never counts, the sweep records it once, and a late verification activates nothing', async () => {
    const { db, records: r } = records();
    await agree(r);
    const pending = db.whatsAppConsent.rows[0];
    pending.createdAt = new Date(Date.now() - PENDING_CONSENT_TTL_MS - 1000);
    expect(await r.contactState(NUMBER)).toMatchObject({ consent: 'none', pendingLive: false, consented: false });
    expect(await verify(r)).toBe('no_pending');
    expect(await r.expireStalePending()).toBe(1);
    expect(await r.expireStalePending()).toBe(0);
    expect(db.whatsAppConsent.rows.map((x) => [x.event, x.source])).toEqual([
      ['pending_unverified', 'mobile_registration'],
      ['expired', 'expiry'],
    ]);
    expect(db.whatsAppConsent.rows[1].pendingId).toEqual(pending.id);
    // The pending row stays in the history, unchanged.
    expect(db.whatsAppConsent.rows[0].event).toBe('pending_unverified');
  });

  it('a fresh agreement is not swept: the sweep takes only what is older than 24 hours, and never an activated one', async () => {
    const { records: r } = records();
    await agree(r);
    expect(await r.expireStalePending()).toBe(0);
    await verify(r);
    expect(await r.expireStalePending(new Date(Date.now() + 2 * PENDING_CONSENT_TTL_MS))).toBe(0);
  });

  it('refuses an unknown or earlier version even if a caller skipped the check', async () => {
    await expect(agree(records().records, { version: 'wa-consent-2026-10-17' })).rejects.toThrow(/Unknown/);
    await expect(grant(records().records, { version: 'wa-consent-2026-10-17' })).rejects.toThrow(/Unknown/);
  });

  it('a withdrawal ends the consent and keeps every earlier event; re-consent on the verified number is a new active row', async () => {
    const { db, records: r } = records();
    await agree(r);
    await verify(r);
    expect(await r.withdrawConsent({ number: NUMBER, companyId: COMPANY, userId: USER, source: 'account_settings', ip: '203.0.113.9' })).toBe('recorded');
    expect(await r.withdrawConsent({ number: NUMBER, companyId: COMPANY, userId: USER, source: 'account_settings' })).toBe('unchanged');
    const after = await r.contactState(NUMBER);
    expect(after).toMatchObject({ consented: false, consent: 'withdrawn', optOutScope: 'all' });
    expect(after.withdrawnAt).toBeInstanceOf(Date);
    expect(await grant(r)).toBe('recorded');
    expect(db.whatsAppConsent.rows.map((x) => x.event)).toEqual(['pending_unverified', 'active', 'withdrawn', 'active']);
    expect(await r.contactState(NUMBER)).toMatchObject({ consented: true, consent: 'active', optOutScope: 'none', withdrawnAt: null });
  });

  it('a replaced number is superseded: its consent stops counting and nothing else is written for a number without one', async () => {
    const { db, records: r } = records();
    await agree(r);
    await verify(r);
    expect(await r.supersede({ number: NUMBER, companyId: COMPANY, userId: USER })).toBe('recorded');
    expect(await r.supersede({ number: NUMBER, companyId: COMPANY, userId: USER })).toBe('unchanged');
    expect(await r.contactState(NUMBER)).toMatchObject({ consented: false, consent: 'superseded' });
    expect(db.whatsAppConsent.rows.at(-1)).toMatchObject({ event: 'superseded', source: 'number_changed', actorUserId: USER });
  });

  it('a consent to an earlier copy is outdated: it never lets a message go, and nothing upgrades it', async () => {
    const { db, records: r } = records();
    db.whatsAppConsent.rows.push({
      id: Buffer.alloc(16, 3),
      numberHash: recipientHash(NUMBER, KEY),
      numberMasked: '+222***39',
      event: 'granted',
      version: 'wa-consent-2026-10-17',
      purposes: 'authentication,operational_notices',
      source: 'owner_registration',
      createdAt: new Date('2026-10-17T10:00:00Z'),
    });
    expect(await r.contactState(NUMBER)).toMatchObject({ consented: false, consent: 'outdated', consentVersion: 'wa-consent-2026-10-17' });
  });

  it('STOP withdraws, recorded by nobody’s account; START grants nothing; a new agreement after it is pending again', async () => {
    const { db, records: r } = records();
    await agree(r);
    await verify(r);
    const hash = recipientHash(NUMBER, KEY);
    await r.applyInbound(hash, '+222***39', new Date('2026-10-17T10:00:00Z'), 'stop');
    expect(await r.contactState(NUMBER)).toMatchObject({ consented: false, consent: 'withdrawn', optOutScope: 'all' });
    expect(db.whatsAppConsent.rows.at(-1)).toMatchObject({ event: 'withdrawn', source: 'inbound_keyword', actorUserId: null, actorCompanyId: null });
    await r.applyInbound(hash, '+222***39', new Date('2026-10-17T10:05:00Z'), 'start');
    expect(await r.contactState(NUMBER)).toMatchObject({ consented: false, consent: 'withdrawn' });
    await agree(r, { source: 'account_settings' });
    expect(await r.contactState(NUMBER)).toMatchObject({ consent: 'pending', pendingLive: true, consented: false });
  });

  it('lists a person’s own events and keyword withdrawals, never another business’s', async () => {
    const { records: r } = records();
    await agree(r, { userId: OTHER_USER, companyId: OTHER_COMPANY });
    await agree(r);
    await verify(r);
    await r.applyInbound(recipientHash(NUMBER, KEY), '+222***39', new Date(), 'stop');
    const mine = await r.consentHistory(NUMBER, USER);
    expect(mine.map((h) => [h.event, h.source])).toEqual([
      ['withdrawn', 'inbound_keyword'],
      ['active', 'mobile_registration'],
      ['pending_unverified', 'mobile_registration'],
    ]);
    expect(await r.consentHistory(NUMBER, Buffer.alloc(16, 7))).toEqual([expect.objectContaining({ source: 'inbound_keyword' })]);
  });

  it('an inbound message only moves the window forward', async () => {
    const { records: r } = records();
    const hash = recipientHash(NUMBER, KEY);
    await r.applyInbound(hash, '+222***39', new Date('2026-10-17T10:00:00Z'), null);
    await r.applyInbound(hash, '+222***39', new Date('2026-10-17T09:00:00Z'), null);
    expect((await r.contactState(NUMBER)).lastInboundAt).toEqual(new Date('2026-10-17T10:00:00Z'));
  });
});
