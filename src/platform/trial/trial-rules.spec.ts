import { createHash } from 'node:crypto';
import {
  RESEND_DAY_MAX,
  RESEND_DAY_MS,
  RESEND_MIN_INTERVAL_MS,
  RESEND_WINDOW_MAX,
  RESEND_WINDOW_MS,
  TRIAL_DURATION_DAYS,
  TRIAL_DURATION_HOURS,
  TRIAL_DURATION_MS,
  TRIAL_SETUP_LINK_TTL_HOURS,
  TRIAL_TERMS_VERSION,
  claimRequestHash,
  displayTimeZone,
  maskForOwner,
  missingContacts,
  requiredContacts,
  runningTrialEnd,
  setupTokenHash,
  trialEndFor,
  trialFactsOf,
  trialOfferOf,
  trialViewOf,
  accessAfterTrialOf,
  type OfferFacts,
  type TrialAccessFacts,
} from './trial-rules';

/**
 * The free trial's pure rules (0095): the constants every client is sent rather than computes, the facts the
 * entitlement reads, the view it renders, and the helpers the claim and the setup instructions share — each boundary
 * at the millisecond, with no clock but the one passed in.
 */

const HOUR = 60 * 60 * 1000;
const START = new Date('2026-10-13T10:00:00.123Z');
const END = new Date('2026-10-20T10:00:00.123Z');
const claim = { claimedAt: START, startedAt: START, endsAt: END };
/** The subscription row as the trial view reads what follows it: nothing given yet, a month paid from the end, a grant. */
const pending: TrialAccessFacts = { status: 'pending_activation', currentPeriodEnd: null, isComplimentary: false, complimentaryUntil: null };
const paidAccess: TrialAccessFacts = { status: 'activated', currentPeriodEnd: new Date('2026-11-20T10:00:00.123Z'), isComplimentary: false, complimentaryUntil: null };
const grantedAccess: TrialAccessFacts = {
  status: 'activated',
  currentPeriodEnd: null,
  isComplimentary: true,
  complimentaryUntil: new Date(END.getTime() + 30 * 24 * HOUR),
};

describe('the constants are the offer, and clients never compute them', () => {
  it('is exactly seven consecutive 24-hour periods', () => {
    expect(TRIAL_DURATION_HOURS).toBe(168);
    expect(TRIAL_DURATION_MS).toBe(168 * HOUR);
    expect(TRIAL_DURATION_DAYS).toBe(7);
    expect(TRIAL_DURATION_DAYS * 24).toBe(TRIAL_DURATION_HOURS);
  });

  it('pins the terms version, the link lifetime and the website resend throttle', () => {
    expect(TRIAL_TERMS_VERSION).toBe('2026-10-13');
    expect(TRIAL_SETUP_LINK_TTL_HOURS).toBe(24);
    expect([RESEND_MIN_INTERVAL_MS, RESEND_WINDOW_MS, RESEND_WINDOW_MAX, RESEND_DAY_MS, RESEND_DAY_MAX]).toEqual([
      60_000,
      15 * 60_000,
      3,
      24 * HOUR,
      10,
    ]);
  });
});

describe('the end is the start plus 168 hours, from the same instant', () => {
  it('adds milliseconds, never calendar days: a daylight-saving change cannot stretch it', () => {
    expect(trialEndFor(START)).toEqual(END);
    // Across the end of European summer time (2026-10-25): still 168 hours to the millisecond.
    const late = new Date('2026-10-22T12:34:56.789Z');
    expect(trialEndFor(late).getTime() - late.getTime()).toBe(168 * HOUR);
    expect(trialEndFor(late).toISOString()).toBe('2026-10-29T12:34:56.789Z');
  });

  it('a trial runs until one millisecond before its end, and not at the end itself', () => {
    expect(runningTrialEnd(claim, new Date(END.getTime() - 1))).toEqual(END);
    expect(runningTrialEnd(claim, END)).toBeNull();
    expect(runningTrialEnd(claim, new Date(END.getTime() + 1))).toBeNull();
    expect(runningTrialEnd(null, START)).toBeNull();
    expect(runningTrialEnd(undefined, START)).toBeNull();
  });
});

describe('the facts, from the rows as stored', () => {
  it('an open eligibility is eligible; a closed one is not, whatever closed it', () => {
    expect(trialFactsOf({ closedAt: null }, null)).toEqual({ eligible: true, claim: null, closure: null });
    expect(trialFactsOf({ closedAt: START }, null)).toEqual({ eligible: false, claim: null, closure: null });
    expect(trialFactsOf(null, null)).toEqual({ eligible: false, claim: null, closure: null });
    expect(trialFactsOf(undefined, undefined)).toEqual({ eligible: false, claim: null, closure: null });
  });

  it('keeps only the claim’s three instants, whatever else the row carries', () => {
    const row = { ...claim, id: Buffer.alloc(16, 1), expiryRecordedAt: null, idempotencyKey: 'k' };
    expect(trialFactsOf({ closedAt: START }, row)).toEqual({ eligible: false, claim, closure: null });
  });

  it('the closure, when its reason was read: when the eligibility closed and by which decision (C6)', () => {
    expect(trialFactsOf({ closedAt: START, closedReason: 'approved' }, claim).closure).toEqual({ at: START, reason: 'approved' });
    expect(trialFactsOf({ closedAt: null, closedReason: null }, claim).closure).toBeNull();
  });
});

describe('the view every client renders', () => {
  const zone = 'Africa/Nouakchott';

  it('a claim is active until its end, with its instants in UTC and the business’s zone beside them', () => {
    expect(trialViewOf({ eligible: false, claim }, 'trial_active', new Date(END.getTime() - 1), zone, pending)).toEqual({
      status: 'active',
      durationHours: 168,
      durationDays: 7,
      claimedAt: '2026-10-13T10:00:00.123Z',
      startedAt: '2026-10-13T10:00:00.123Z',
      endsAt: '2026-10-20T10:00:00.123Z',
      timeZone: zone,
      accessAfterTrial: null,
    });
  });

  it('and expired from the end itself', () => {
    expect(trialViewOf({ eligible: false, claim }, 'trial_expired', END, 'UTC', pending)).toMatchObject({ status: 'expired', endsAt: END.toISOString() });
  });

  it('a claim is told whatever the state above it says: the trial clock of a suspended or approved business still runs', () => {
    expect(trialViewOf({ eligible: false, claim }, 'suspended', START, zone, pending)?.status).toBe('active');
    expect(trialViewOf({ eligible: false, claim }, 'active', new Date(END.getTime() + HOUR), zone, paidAccess)?.status).toBe('expired');
  });

  it('an unclaimed trial is available, with no instants, only while the state says so', () => {
    expect(trialViewOf({ eligible: true, claim: null }, 'trial_available', START, zone, pending)).toEqual({
      status: 'available',
      durationHours: 168,
      durationDays: 7,
      claimedAt: null,
      startedAt: null,
      endsAt: null,
      timeZone: zone,
      accessAfterTrial: null,
    });
    // Eligible on paper, but the business is suspended: nothing to offer, so nothing to show.
    expect(trialViewOf({ eligible: true, claim: null }, 'suspended', START, zone, pending)).toBeNull();
    expect(trialViewOf({ eligible: false, claim: null }, 'pending', START, zone, pending)).toBeNull();
    expect(trialViewOf(null, 'active', START, zone, paidAccess)).toBeNull();
    expect(trialViewOf(undefined, 'expired', START, zone, null)).toBeNull();
  });
});

describe('what follows the trial at its end (C6): the paid period or the grant approved while it ran', () => {
  const zone = 'Africa/Casablanca';
  const running = new Date(END.getTime() - HOUR);
  const after = new Date(END.getTime() + HOUR);
  const viewAt = (now: Date, access: TrialAccessFacts | null, closure: { at: Date; reason: 'approved' | 'granted' | 'paid_period' | 'refused' | 'cancelled' } | null = null) =>
    trialViewOf({ eligible: false, claim, closure }, 'trial_active', now, zone, access)?.accessAfterTrial;

  it('paid: a paid period approved during the trial runs past its end — it starts at the end, in UTC', () => {
    expect(viewAt(running, paidAccess)).toEqual({ kind: 'paid', startsAt: '2026-10-20T10:00:00.123Z' });
    // An exact end date one millisecond past the trial's end is a period that follows it.
    expect(viewAt(running, { ...paidAccess, currentPeriodEnd: new Date(END.getTime() + 1) })).toEqual({ kind: 'paid', startsAt: END.toISOString() });
  });

  it('granted: the platform’s grant, dated from the trial’s end — and it outranks a paid period beside it, as the state does', () => {
    expect(viewAt(running, grantedAccess)).toEqual({ kind: 'granted', startsAt: END.toISOString() });
    expect(viewAt(running, { ...grantedAccess, currentPeriodEnd: new Date(END.getTime() + 60 * 24 * HOUR) })).toEqual({ kind: 'granted', startsAt: END.toISOString() });
  });

  it('none: nothing approved — or a business never given anything after a reinstatement — turns read-only at the end', () => {
    expect(viewAt(running, pending)).toBeNull();
    expect(viewAt(running, { status: 'activated', currentPeriodEnd: null, isComplimentary: false, complimentaryUntil: null })).toBeNull();
    // A grant flag with no end is no grant (the state does not count it either).
    expect(viewAt(running, { ...pending, status: 'activated', isComplimentary: true })).toBeNull();
    expect(viewAt(running, null)).toBeNull();
  });

  it('available: no claim, nothing to follow', () => {
    expect(trialViewOf({ eligible: true, claim: null }, 'trial_available', START, zone, paidAccess)?.accessAfterTrial).toBeNull();
    expect(accessAfterTrialOf({ eligible: true, claim: null }, paidAccess, START)).toBeNull();
  });

  it('a suspension blocks what was arranged without ending it; a cancellation or a refusal ends it', () => {
    expect(viewAt(running, { ...paidAccess, status: 'suspended' })).toEqual({ kind: 'paid', startsAt: END.toISOString() });
    expect(viewAt(running, { ...paidAccess, status: 'cancelled' })).toBeNull();
    expect(viewAt(running, { ...paidAccess, status: 'rejected' })).toBeNull();
    expect(viewAt(running, { ...paidAccess, status: 'pending_activation' })).toBeNull();
  });

  it('once the trial has ended, only an access decision fenced while it ran proves the access followed it', () => {
    const during = new Date(END.getTime() - 2 * HOUR);
    expect(viewAt(after, paidAccess, { at: during, reason: 'approved' })).toEqual({ kind: 'paid', startsAt: END.toISOString() });
    expect(viewAt(after, grantedAccess, { at: during, reason: 'granted' })).toEqual({ kind: 'granted', startsAt: END.toISOString() });
    expect(viewAt(after, paidAccess, { at: during, reason: 'paid_period' })).toEqual({ kind: 'paid', startsAt: END.toISOString() });
    // Approved after the end: paid access started then, not at the end — the business was read-only between.
    expect(viewAt(after, paidAccess, { at: new Date(END.getTime() + 30 * 60_000), reason: 'approved' })).toBeNull();
    expect(viewAt(after, paidAccess, { at: END, reason: 'approved' })).toBeNull();
    // Refused during the trial, approved after it: the closure proves nothing.
    expect(viewAt(after, paidAccess, { at: during, reason: 'refused' })).toBeNull();
    // No closure read: nothing is claimed.
    expect(viewAt(after, paidAccess, null)).toBeNull();
  });
});

describe('dates are shown in the business’s own configured zone', () => {
  it('a valid IANA zone is used as stored', () => {
    for (const zone of ['Africa/Nouakchott', 'Europe/Paris', 'America/New_York', 'UTC']) {
      expect(displayTimeZone(zone)).toBe(zone);
    }
    expect(displayTimeZone('  Europe/Paris ')).toBe('Europe/Paris');
  });

  it('an unknown or empty zone reads as UTC and is reported — never a zone guessed for the country', () => {
    for (const stored of ['Mars/Olympus_Mons', 'GMT+99', '', '   ', null, undefined]) {
      const reported: string[] = [];
      const zone = displayTimeZone(stored, (z) => reported.push(z));
      expect([stored, zone]).toEqual([stored, 'UTC']);
      expect(zone).not.toBe('Africa/Nouakchott');
      expect(reported).toEqual([(stored ?? '').trim()]);
    }
  });

  it('a valid zone reports nothing', () => {
    const reported: string[] = [];
    displayTimeZone('Africa/Nouakchott', (z) => reported.push(z));
    expect(reported).toEqual([]);
  });
});

describe('the contacts the claim requires', () => {
  const none = { email: null, emailVerifiedAt: null, phone: null, phoneVerifiedAt: null };
  const both = { email: 'a@example.com', emailVerifiedAt: START, phone: '+22212341234', phoneVerifiedAt: START };

  it('are the ones given at registration — both, if both', () => {
    expect(requiredContacts('email')).toEqual(['email']);
    expect(requiredContacts('phone')).toEqual(['phone']);
    expect(requiredContacts('both')).toEqual(['email', 'phone']);
  });

  it('a contact counts only while it is set and verified', () => {
    expect(missingContacts('both', both)).toEqual([]);
    expect(missingContacts('both', none)).toEqual(['email', 'phone']);
    expect(missingContacts('both', { ...both, phoneVerifiedAt: null })).toEqual(['phone']);
    expect(missingContacts('both', { ...both, emailVerifiedAt: null })).toEqual(['email']);
    // A verification left behind by a contact since removed proves nothing.
    expect(missingContacts('email', { ...both, email: null })).toEqual(['email']);
    expect(missingContacts('phone', { ...both, phone: null })).toEqual(['phone']);
    // A contact the registration did not give is never asked for.
    expect(missingContacts('email', { ...none, email: 'a@example.com', emailVerifiedAt: START })).toEqual([]);
  });
});

describe('a verified contact as its Owner sees it', () => {
  it('is recognisable and never the value', () => {
    expect(maskForOwner('email', 'amina@example.com')).toBe('a•••@example.com');
    expect(maskForOwner('phone', '+22212341234')).toBe('+222••••1234');
    expect(maskForOwner('phone', '+33612345678')).toBe('+336••••5678');
  });

  it('hides everything it cannot mask safely', () => {
    expect(maskForOwner('email', 'not-an-address')).toBe('•••');
    expect(maskForOwner('email', '@example.com')).toBe('•••');
    expect(maskForOwner('phone', '+2221234')).toBe('••••34');
    expect(maskForOwner('phone', '12')).toBe('••••');
    for (const raw of ['amina@example.com', '+22212341234', '+2221234']) {
      expect(maskForOwner(raw.includes('@') ? 'email' : 'phone', raw)).not.toContain(raw);
    }
  });
});

describe('the claim’s canonical request', () => {
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');

  it('stores a token only as its SHA-256', () => {
    expect(setupTokenHash('abc')).toBe(sha('abc'));
    expect(setupTokenHash('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is the terms version and the link’s hash, in that order — never the token', () => {
    expect(claimRequestHash('2026-10-13')).toBe(sha(JSON.stringify({ termsVersion: '2026-10-13', linkTokenHash: null })));
    expect(claimRequestHash('2026-10-13', 'tok')).toBe(sha(JSON.stringify({ termsVersion: '2026-10-13', linkTokenHash: sha('tok') })));
    expect(claimRequestHash('2026-10-13', null)).toBe(claimRequestHash('2026-10-13'));
    expect(claimRequestHash('2026-10-13', '')).toBe(claimRequestHash('2026-10-13'));
  });

  it('a different request under the same key hashes differently; the same one, the same', () => {
    expect(claimRequestHash('2026-10-13', 'tok')).toBe(claimRequestHash('2026-10-13', 'tok'));
    expect(claimRequestHash('2026-10-13', 'tok')).not.toBe(claimRequestHash('2026-10-13', 'other'));
    expect(claimRequestHash('2026-10-13')).not.toBe(claimRequestHash('2026-10-14'));
  });
});

/**
 * The website's offer (GET platform/my-subscription/trial): what a claim made now would record, and whether the Owner
 * can make it now. Kept but unavailable while something can still be fixed; absent when nothing could ever be
 * claimed; never asked about delivery or links.
 */
describe('the offer the Owner is shown before confirming', () => {
  const NOW = new Date('2026-10-13T10:00:00.000Z');
  const verified = { email: 'o@shop.test', emailVerifiedAt: NOW, phone: '+22236001234', phoneVerifiedAt: NOW };
  const facts = (over: Partial<OfferFacts> = {}): OfferFacts => ({
    eligibility: { registrationMethod: 'email', closedAt: null },
    claimed: false,
    closed: false,
    state: 'trial_available',
    owner: verified,
    ...over,
  });

  it('available: the terms in force, 168 hours from the instant asked, in the business’s zone', () => {
    expect(trialOfferOf(facts(), NOW, 'Asia/Dubai')).toEqual({
      available: true,
      reason: null,
      termsVersion: TRIAL_TERMS_VERSION,
      durationHours: 168,
      wouldStartAt: NOW.toISOString(),
      wouldEndAt: new Date(NOW.getTime() + 168 * HOUR).toISOString(),
      timeZone: 'Asia/Dubai',
      requiredContacts: ['email'],
      missingContacts: [],
    });
  });

  it('asks for the contacts given at registration, and names the ones still to verify', () => {
    const both = facts({ eligibility: { registrationMethod: 'both', closedAt: null }, owner: { ...verified, phoneVerifiedAt: null } });
    expect(trialOfferOf(both, NOW, 'UTC')).toMatchObject({
      available: false,
      reason: 'contact_unverified',
      requiredContacts: ['email', 'phone'],
      missingContacts: ['phone'],
    });
  });

  it('a suspension keeps the offer and blocks it — before any contact is asked about', () => {
    const suspended = facts({ state: 'suspended', owner: { ...verified, emailVerifiedAt: null } });
    expect(trialOfferOf(suspended, NOW, 'UTC')).toMatchObject({ available: false, reason: 'business_suspended', missingContacts: ['email'] });
  });

  it('none once claimed, closed, never eligible, eligibility closed, or any other state', () => {
    expect(trialOfferOf(facts({ claimed: true, state: 'trial_active' }), NOW, 'UTC')).toBeNull();
    expect(trialOfferOf(facts({ claimed: true, state: 'trial_expired' }), NOW, 'UTC')).toBeNull();
    expect(trialOfferOf(facts({ closed: true }), NOW, 'UTC')).toBeNull();
    expect(trialOfferOf(facts({ eligibility: null, state: 'pending' }), NOW, 'UTC')).toBeNull();
    expect(trialOfferOf(facts({ eligibility: { registrationMethod: 'email', closedAt: NOW }, state: 'active' }), NOW, 'UTC')).toBeNull();
    for (const state of ['pending', 'active', 'grace', 'expired', 'complimentary', 'cancelled', 'rejected'] as const) {
      expect([state, trialOfferOf(facts({ state }), NOW, 'UTC')]).toEqual([state, null]);
    }
  });
});
