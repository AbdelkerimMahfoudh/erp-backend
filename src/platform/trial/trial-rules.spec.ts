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
  trialViewOf,
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
    expect(trialFactsOf({ closedAt: null }, null)).toEqual({ eligible: true, claim: null });
    expect(trialFactsOf({ closedAt: START }, null)).toEqual({ eligible: false, claim: null });
    expect(trialFactsOf(null, null)).toEqual({ eligible: false, claim: null });
    expect(trialFactsOf(undefined, undefined)).toEqual({ eligible: false, claim: null });
  });

  it('keeps only the claim’s three instants, whatever else the row carries', () => {
    const row = { ...claim, id: Buffer.alloc(16, 1), expiryRecordedAt: null, idempotencyKey: 'k' };
    expect(trialFactsOf({ closedAt: START }, row)).toEqual({ eligible: false, claim });
  });
});

describe('the view every client renders', () => {
  const zone = 'Africa/Nouakchott';

  it('a claim is active until its end, with its instants in UTC and the business’s zone beside them', () => {
    expect(trialViewOf({ eligible: false, claim }, 'trial_active', new Date(END.getTime() - 1), zone)).toEqual({
      status: 'active',
      durationHours: 168,
      durationDays: 7,
      claimedAt: '2026-10-13T10:00:00.123Z',
      startedAt: '2026-10-13T10:00:00.123Z',
      endsAt: '2026-10-20T10:00:00.123Z',
      timeZone: zone,
    });
  });

  it('and expired from the end itself', () => {
    expect(trialViewOf({ eligible: false, claim }, 'trial_expired', END, 'UTC')).toMatchObject({ status: 'expired', endsAt: END.toISOString() });
  });

  it('a claim is told whatever the state above it says: the trial clock of a suspended or approved business still runs', () => {
    expect(trialViewOf({ eligible: false, claim }, 'suspended', START, zone)?.status).toBe('active');
    expect(trialViewOf({ eligible: false, claim }, 'active', new Date(END.getTime() + HOUR), zone)?.status).toBe('expired');
  });

  it('an unclaimed trial is available, with no instants, only while the state says so', () => {
    expect(trialViewOf({ eligible: true, claim: null }, 'trial_available', START, zone)).toEqual({
      status: 'available',
      durationHours: 168,
      durationDays: 7,
      claimedAt: null,
      startedAt: null,
      endsAt: null,
      timeZone: zone,
    });
    // Eligible on paper, but the business is suspended: nothing to offer, so nothing to show.
    expect(trialViewOf({ eligible: true, claim: null }, 'suspended', START, zone)).toBeNull();
    expect(trialViewOf({ eligible: false, claim: null }, 'pending', START, zone)).toBeNull();
    expect(trialViewOf(null, 'active', START, zone)).toBeNull();
    expect(trialViewOf(undefined, 'expired', START, zone)).toBeNull();
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
