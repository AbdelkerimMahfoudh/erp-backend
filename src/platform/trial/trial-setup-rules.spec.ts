import { resendAvailableAt, resendBlockOf, verifiedDestinations } from './trial-setup-rules';
import type { OwnerContacts } from './trial-rules';

/**
 * The portal instructions' pure rules (0095, 0099; docs/76, docs/101 §5): which of the Owner's contacts they may go to,
 * and when the portal may ask again — to the millisecond. Which channel carries them, and why, is the notice rules'
 * (`notices/notice-rules.spec.ts`).
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

describe('the Owner’s destinations', () => {
  it('are the verified contacts only, WhatsApp first — the order they are tried in', () => {
    expect(verifiedDestinations(owner())).toEqual([
      { channel: 'whatsapp', masked: '+222••••1234' },
      { channel: 'email', masked: 'a•••@example.com' },
    ]);
    expect(verifiedDestinations(owner({ emailVerifiedAt: null }))).toEqual([{ channel: 'whatsapp', masked: '+222••••1234' }]);
    expect(verifiedDestinations(owner({ phone: null, phoneVerifiedAt: null }))).toEqual([{ channel: 'email', masked: 'a•••@example.com' }]);
    expect(verifiedDestinations(owner({ emailVerifiedAt: null, phoneVerifiedAt: null }))).toEqual([]);
  });

  it('never the value', () => {
    const shown = JSON.stringify(verifiedDestinations(owner()));
    expect(shown).not.toContain('aicha');
    expect(shown).not.toContain('36001234');
  });
});

describe('when the portal may ask again: 60 s, 3 per 15 min, 10 per 24 h — every request counts', () => {
  it('nothing asked yet: now', () => {
    expect(resendAvailableAt([], T)).toBeNull();
  });

  it('a minute after the last request, to the millisecond — the automatic one included', () => {
    expect(resendAvailableAt([T], at(30 * SECOND))).toEqual(at(MINUTE));
    expect(resendAvailableAt([T], at(MINUTE - 1))).toEqual(at(MINUTE));
    expect(resendAvailableAt([T], at(MINUTE))).toBeNull();
  });

  it('three in fifteen minutes: the fourth waits for the oldest of them to leave the window', () => {
    const three = [T, at(MINUTE), at(2 * MINUTE)];
    expect(resendAvailableAt(three, at(3 * MINUTE))).toEqual(at(15 * MINUTE));
    expect(resendAvailableAt(three, at(15 * MINUTE - 1))).toEqual(at(15 * MINUTE));
    expect(resendAvailableAt(three, at(15 * MINUTE))).toBeNull();
    // Two are not three.
    expect(resendAvailableAt([T, at(MINUTE)], at(2 * MINUTE))).toBeNull();
  });

  it('ten in a day: the eleventh waits for the oldest of them to be a day old', () => {
    const ten = Array.from({ length: 10 }, (_, k) => at(k * 16 * MINUTE));
    const after = at(9 * 16 * MINUTE + 5 * MINUTE);
    expect(resendAvailableAt(ten, after)).toEqual(at(24 * HOUR));
    expect(resendAvailableAt(ten, at(24 * HOUR - 1))).toEqual(at(24 * HOUR));
    expect(resendAvailableAt(ten, at(24 * HOUR))).toBeNull();
    // Nine are not ten.
    expect(resendAvailableAt(ten.slice(1), after)).toBeNull();
  });

  it('the strictest rule wins, whatever order the requests arrive in', () => {
    const shuffled = [at(2 * MINUTE), T, at(MINUTE)];
    expect(resendAvailableAt(shuffled, at(3 * MINUTE))).toEqual(at(15 * MINUTE));
  });
});

describe('why the portal may not ask again now (C4)', () => {
  it('a required contact unverified comes first, whatever else also stands in the way', () => {
    expect(resendBlockOf(['phone'], true, null)).toBe('contact_unverified');
    expect(resendBlockOf(['phone'], false, at(MINUTE))).toBe('contact_unverified');
  });

  it('then nothing that can carry them now — there is nothing to count down to', () => {
    expect(resendBlockOf([], false, null)).toBe('unavailable');
    expect(resendBlockOf([], false, at(MINUTE))).toBe('unavailable');
  });

  it('the throttle only when it is the only thing; null exactly when the portal may ask now', () => {
    expect(resendBlockOf([], true, at(MINUTE))).toBe('throttle');
    expect(resendBlockOf([], true, null)).toBeNull();
  });
});
