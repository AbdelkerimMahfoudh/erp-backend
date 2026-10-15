import {
  SETUP_DELIVERY_WAIT_MS,
  SETUP_SENDING_WINDOW_MS,
  attemptOutcome,
  deliveryOf,
  historyEntry,
  operationalChannels,
  plannedOutcomes,
  printsDevelopmentLinks,
  resendAvailableAt,
  sentTo,
  setupLinkUrl,
  verifiedDestinations,
  type DeliveryContext,
  type SetupAttempt,
} from './trial-setup-rules';
import type { OwnerContacts } from './trial-rules';

/**
 * The setup instructions' pure rules (0095; docs/76; the owner's correction of 2026-10-13): what the Owner is told
 * about them, which channels can carry them, and when the website may ask again — to the millisecond.
 */

const T = new Date('2026-10-13T10:00:00.000Z');
const at = (ms: number) => new Date(T.getTime() + ms);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const VERIFIED = new Date('2026-10-12T08:00:00.000Z');
const owner = (over: Partial<OwnerContacts> = {}): OwnerContacts => ({
  email: 'aicha@example.com',
  emailVerifiedAt: VERIFIED,
  phone: '+22236001234',
  phoneVerifiedAt: VERIFIED,
  ...over,
});

describe('where the instructions stand', () => {
  it('an attempt is sent if any channel accepted it, failed if none did and one failed, else unavailable', () => {
    expect(attemptOutcome({ email: 'accepted', whatsapp: 'failed' })).toBe('sent');
    expect(attemptOutcome({ email: 'not_applicable', whatsapp: 'accepted' })).toBe('sent');
    expect(attemptOutcome({ email: 'failed', whatsapp: 'unavailable' })).toBe('failed');
    expect(attemptOutcome({ email: 'unavailable', whatsapp: 'not_applicable' })).toBe('unavailable');
  });

  const attemptAt = (ms: number, email: SetupAttempt['email'], whatsapp: SetupAttempt['whatsapp'] = 'not_applicable') => ({
    at: at(ms),
    email,
    whatsapp,
  });

  it('a missing contact outranks everything: nothing is sent by design until it is verified', () => {
    expect(deliveryOf({ missing: ['phone'], last: attemptAt(0, 'accepted'), newestLink: { issuedAt: T, recorded: true } }, T)).toBe(
      'waiting_for_contact',
    );
    expect(deliveryOf({ missing: ['email', 'phone'], last: null, newestLink: null }, T)).toBe('waiting_for_contact');
  });

  it('contacts complete: no attempt recorded is not_sent; otherwise the last attempt says', () => {
    expect(deliveryOf({ missing: [], last: null, newestLink: null }, T)).toBe('not_sent');
    const recorded = { issuedAt: T, recorded: true };
    expect(deliveryOf({ missing: [], last: attemptAt(0, 'accepted', 'failed'), newestLink: recorded }, at(HOUR))).toBe('sent');
    expect(deliveryOf({ missing: [], last: attemptAt(0, 'failed'), newestLink: recorded }, at(HOUR))).toBe('failed');
    expect(deliveryOf({ missing: [], last: attemptAt(0, 'unavailable', 'unavailable'), newestLink: null }, at(HOUR))).toBe('unavailable');
  });

  it('a link newer than every attempt, without one of its own, is sending for a minute — then not_sent (C1)', () => {
    const inFlight = { issuedAt: at(10 * SECOND), recorded: false };
    // The first send: no attempt at all yet.
    expect(deliveryOf({ missing: [], last: null, newestLink: inFlight }, at(10 * SECOND))).toBe('sending');
    expect(deliveryOf({ missing: [], last: null, newestLink: inFlight }, at(10 * SECOND + SETUP_SENDING_WINDOW_MS - 1))).toBe('sending');
    expect(deliveryOf({ missing: [], last: null, newestLink: inFlight }, at(10 * SECOND + SETUP_SENDING_WINDOW_MS))).toBe('not_sent');
    // A resend after an earlier attempt: the earlier outcome is not what is happening now.
    expect(deliveryOf({ missing: [], last: attemptAt(0, 'accepted'), newestLink: inFlight }, at(20 * SECOND))).toBe('sending');
    expect(deliveryOf({ missing: [], last: attemptAt(0, 'accepted'), newestLink: inFlight }, at(2 * MINUTE))).toBe('not_sent');
    // An attempt newer than the unrecorded link (nothing could carry the next one) says what happened since.
    expect(deliveryOf({ missing: [], last: attemptAt(2 * MINUTE, 'unavailable'), newestLink: inFlight }, at(3 * MINUTE))).toBe('unavailable');
  });

  it('waits a bounded time for the providers, and shows sending no longer than the throttle’s minute', () => {
    expect(SETUP_DELIVERY_WAIT_MS).toBe(3_000);
    expect(SETUP_SENDING_WINDOW_MS).toBe(60_000);
  });

  it('sentTo names the channels a provider accepted, email first', () => {
    expect(sentTo({ email: 'accepted', whatsapp: 'accepted' })).toEqual(['email', 'whatsapp']);
    expect(sentTo({ email: 'failed', whatsapp: 'accepted' })).toEqual(['whatsapp']);
    expect(sentTo(null)).toEqual([]);
  });

  it('the website lists the send after verification as automatic, a resend as a resend, outcomes as stored', () => {
    expect(historyEntry({ at: T, trigger: 'verified', email: 'accepted', whatsapp: 'not_applicable' })).toEqual({
      at: T.toISOString(),
      trigger: 'automatic',
      email: 'accepted',
      whatsapp: 'not_applicable',
    });
    expect(historyEntry({ at: T, trigger: 'resend', email: 'failed', whatsapp: 'unavailable' }).trigger).toBe('resend');
  });
});

describe('the verified destinations, masked for their own Owner', () => {
  it('an email: its first character, then the domain; a number: its first four characters, then its last four digits', () => {
    expect(verifiedDestinations(owner())).toEqual([
      { channel: 'email', masked: 'a•••@example.com' },
      { channel: 'whatsapp', masked: '+222••••1234' },
    ]);
  });

  it('a contact that is set but not verified, or verified and since removed, is no destination', () => {
    expect(verifiedDestinations(owner({ phoneVerifiedAt: null }))).toEqual([{ channel: 'email', masked: 'a•••@example.com' }]);
    expect(verifiedDestinations(owner({ email: null }))).toEqual([{ channel: 'whatsapp', masked: '+222••••1234' }]);
    expect(verifiedDestinations(owner({ emailVerifiedAt: null, phoneVerifiedAt: null }))).toEqual([]);
  });

  it('never the value', () => {
    const shown = JSON.stringify(verifiedDestinations(owner()));
    expect(shown).not.toContain('aicha');
    expect(shown).not.toContain('36001234');
  });
});

describe('when the website may ask again: 60 s, 3 per 15 min, 10 per 24 h — every attempt counts', () => {
  it('nothing sent yet: now', () => {
    expect(resendAvailableAt([], null, T)).toBeNull();
  });

  it('a minute after the last attempt, to the millisecond', () => {
    expect(resendAvailableAt([T], null, at(30 * SECOND))).toEqual(at(MINUTE));
    expect(resendAvailableAt([T], null, at(MINUTE - 1))).toEqual(at(MINUTE));
    expect(resendAvailableAt([T], null, at(MINUTE))).toBeNull();
  });

  it('a link issued in the last minute is an attempt in flight, though its own record is not written yet', () => {
    expect(resendAvailableAt([], at(10 * SECOND), at(20 * SECOND))).toEqual(at(70 * SECOND));
    // Whichever is newer, the attempt or the link, starts the minute.
    expect(resendAvailableAt([T], at(5 * SECOND), at(30 * SECOND))).toEqual(at(65 * SECOND));
  });

  it('three in fifteen minutes: the fourth waits for the oldest of them to leave the window', () => {
    const three = [T, at(MINUTE), at(2 * MINUTE)];
    expect(resendAvailableAt(three, null, at(3 * MINUTE))).toEqual(at(15 * MINUTE));
    expect(resendAvailableAt(three, null, at(15 * MINUTE - 1))).toEqual(at(15 * MINUTE));
    expect(resendAvailableAt(three, null, at(15 * MINUTE))).toBeNull();
    // Two are not three.
    expect(resendAvailableAt([T, at(MINUTE)], null, at(2 * MINUTE))).toBeNull();
  });

  it('ten in a day: the eleventh waits for the oldest of them to be a day old', () => {
    const ten = Array.from({ length: 10 }, (_, k) => at(k * 16 * MINUTE));
    const after = at(9 * 16 * MINUTE + 5 * MINUTE);
    expect(resendAvailableAt(ten, null, after)).toEqual(at(24 * HOUR));
    expect(resendAvailableAt(ten, null, at(24 * HOUR - 1))).toEqual(at(24 * HOUR));
    expect(resendAvailableAt(ten, null, at(24 * HOUR))).toBeNull();
    // Nine are not ten.
    expect(resendAvailableAt(ten.slice(1), null, after)).toBeNull();
  });

  it('the strictest rule wins, whatever order the attempts arrive in', () => {
    const shuffled = [at(2 * MINUTE), T, at(MINUTE)];
    expect(resendAvailableAt(shuffled, at(2 * MINUTE + 30 * SECOND), at(3 * MINUTE))).toEqual(at(15 * MINUTE));
  });
});

describe('which channels can carry the instructions — decided at the moment of sending', () => {
  const real = { name: 'resend', isEnabled: true };
  const cloud = { name: 'cloud-api', isEnabled: true };
  const devLog = { name: 'development-log', isEnabled: true };
  const off = { name: 'disabled', isEnabled: false };
  const base: DeliveryContext = { email: real, whatsapp: cloud, whatsappTemplate: true, outboxAllowed: false, linkable: true };

  it('real providers carry them: email as it is, WhatsApp only with its approved setup template', () => {
    expect(operationalChannels(base)).toEqual({ email: true, whatsapp: true });
    expect(operationalChannels({ ...base, whatsappTemplate: false })).toEqual({ email: true, whatsapp: false });
  });

  it('a WhatsApp channel closed until its delivery is proven carries nothing yet', () => {
    // `ProvenWhatsAppChannel` says so through `isEnabled`, read now — not at boot.
    expect(operationalChannels({ ...base, whatsapp: { name: 'cloud-api', isEnabled: false } })).toEqual({ email: true, whatsapp: false });
  });

  it('the development logs only where the development outbox is allowed — never in production', () => {
    const dev = { ...base, email: devLog, whatsapp: devLog, whatsappTemplate: false };
    expect(operationalChannels({ ...dev, outboxAllowed: true })).toEqual({ email: true, whatsapp: true });
    expect(operationalChannels({ ...dev, outboxAllowed: false })).toEqual({ email: false, whatsapp: false });
  });

  it('a disabled channel carries nothing', () => {
    expect(operationalChannels({ ...base, email: off, whatsapp: off })).toEqual({ email: false, whatsapp: false });
  });

  it('without a link — no website origin, or no key to bind it — no channel carries anything', () => {
    expect(operationalChannels({ ...base, linkable: false })).toEqual({ email: false, whatsapp: false });
  });

  it('each verified contact is sent to if its channel can carry it; unverified is not applicable; closed is unavailable', () => {
    expect(plannedOutcomes(owner(), { email: true, whatsapp: true })).toEqual({ email: 'send', whatsapp: 'send' });
    expect(plannedOutcomes(owner({ phoneVerifiedAt: null }), { email: true, whatsapp: true })).toEqual({
      email: 'send',
      whatsapp: 'not_applicable',
    });
    expect(plannedOutcomes(owner(), { email: false, whatsapp: true })).toEqual({ email: 'unavailable', whatsapp: 'send' });
    expect(plannedOutcomes(owner({ email: null }), { email: false, whatsapp: false })).toEqual({
      email: 'not_applicable',
      whatsapp: 'unavailable',
    });
  });
});

describe('the link and the development console', () => {
  it('the email link puts the token in the fragment of the website’s trial page — never a query a server logs', () => {
    expect(setupLinkUrl('https://dukan.tsx-mr.com', 'abc_DEF-123')).toBe('https://dukan.tsx-mr.com/account/trial#t=abc_DEF-123');
  });

  it('is printed on a development machine only — never staging, never production, never under test', () => {
    expect(printsDevelopmentLinks({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(true);
    expect(printsDevelopmentLinks({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(false);
    expect(printsDevelopmentLinks({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(false);
    expect(printsDevelopmentLinks({ NODE_ENV: 'development', APP_ENV: 'staging' } as NodeJS.ProcessEnv)).toBe(false);
    expect(printsDevelopmentLinks({ NODE_ENV: 'development', APP_ENV: 'Production' } as NodeJS.ProcessEnv)).toBe(false);
  });
});
