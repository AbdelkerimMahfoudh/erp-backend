import {
  END_NOTICE_WINDOW_MS,
  MAX_EMAIL_ATTEMPTS,
  MAX_WHATSAPP_ATTEMPTS,
  afterEmail,
  afterWhatsApp,
  currentSlot,
  isCurrent,
  nextSlot,
  noticeBackoffMs,
  slotsOf,
  whatsappPlan,
  type NoticeSubject,
  type WhatsAppFacts,
} from './notice-rules';
import { daysLeftText, formatNoticeInstant, graceHoursLeftText } from './notice-copy';

/**
 * The subscription messages' pure rules (0099; docs/101 §6): which one message applies at each instant — to the
 * millisecond — and which channel carries it, or why none does.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const E = new Date('2026-11-20T10:00:00.000Z');
const T = new Date('2026-10-20T10:00:00.000Z');
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);

const paid = (over: Partial<NoticeSubject> = {}): NoticeSubject => ({
  status: 'activated',
  currentPeriodEnd: E,
  isComplimentary: false,
  complimentaryUntil: null,
  open: true,
  trial: null,
  grace: null,
  ...over,
});
const trial = (over: Partial<NoticeSubject> = {}): NoticeSubject => ({
  status: 'pending_activation',
  currentPeriodEnd: null,
  isComplimentary: false,
  complimentaryUntil: null,
  open: true,
  trial: { claimId: 'c-1', endsAt: T },
  grace: null,
  ...over,
});
const slotAt = (s: NoticeSubject, now: Date) => {
  const slot = currentSlot(s, now);
  return slot ? `${slot.kind}:${slot.threshold}${slot.variant ? `:${slot.variant}` : ''}` : null;
};

describe('a free trial’s messages', () => {
  it('72, 48 and 24 hours before its end, then its end — each until the next, to the millisecond', () => {
    const s = trial();
    expect(slotAt(s, at(T, -72 * HOUR - 1))).toBeNull();
    expect(slotAt(s, at(T, -72 * HOUR))).toBe('trial_reminder:h72');
    expect(slotAt(s, at(T, -48 * HOUR - 1))).toBe('trial_reminder:h72');
    expect(slotAt(s, at(T, -48 * HOUR))).toBe('trial_reminder:h48');
    expect(slotAt(s, at(T, -24 * HOUR))).toBe('trial_reminder:h24');
    expect(slotAt(s, at(T, -1))).toBe('trial_reminder:h24');
    expect(slotAt(s, T)).toBe('trial_expired:end');
    expect(slotAt(s, at(T, END_NOTICE_WINDOW_MS - 1))).toBe('trial_expired:end');
    // An end older than the window is never announced: no backlog burst after a pause.
    expect(slotAt(s, at(T, END_NOTICE_WINDOW_MS))).toBeNull();
  });

  it('all keyed by the claim, and never a grace message: a trial has none', () => {
    const slots = slotsOf(trial());
    expect(new Set(slots.map((x) => x.periodKey))).toEqual(new Set(['trial:c-1']));
    expect(slots.map((x) => x.kind)).not.toContain('grace_reminder');
    expect(slots.map((x) => x.kind)).not.toContain('paid_expired');
  });

  it('nothing about its end when paid access or a grant takes over there — the paid period’s own messages follow', () => {
    const followed = trial({ status: 'activated', currentPeriodEnd: at(T, 30 * DAY) });
    expect(slotsOf(followed).map((x) => x.kind)).toEqual(['paid_reminder', 'paid_reminder', 'paid_reminder', 'paid_expired']);
    expect(slotAt(followed, at(T, -24 * HOUR))).toBeNull();
    expect(slotAt(trial({ isComplimentary: true, complimentaryUntil: at(T, DAY) }), at(T, -24 * HOUR))).toBeNull();
  });
});

describe('a paid period’s messages', () => {
  it('72, 48 and 24 hours before its end, keyed by the end itself', () => {
    const s = paid();
    expect(slotAt(s, at(E, -72 * HOUR))).toBe('paid_reminder:h72');
    expect(slotAt(s, at(E, -48 * HOUR))).toBe('paid_reminder:h48');
    expect(slotAt(s, at(E, -24 * HOUR))).toBe('paid_reminder:h24');
    expect(currentSlot(s, at(E, -HOUR))!.periodKey).toBe(`paid:${E.getTime()}`);
  });

  it('the end waits for its recorded decision, so what it says is what was recorded', () => {
    expect(slotAt(paid(), E)).toBeNull();
    expect(slotAt(paid({ grace: { decision: 'granted' } }), E)).toBe('paid_expired:end:grace_started');
    expect(slotAt(paid({ grace: { decision: 'refused' } }), E)).toBe('paid_expired:end:no_grace');
  });

  it('with grace: the start, then 48 and 24 hours left, then its end — keyed by the grace', () => {
    const s = paid({ grace: { decision: 'granted' } });
    expect(slotAt(s, at(E, 24 * HOUR - 1))).toBe('paid_expired:end:grace_started');
    expect(slotAt(s, at(E, 24 * HOUR))).toBe('grace_reminder:h48');
    expect(slotAt(s, at(E, 48 * HOUR))).toBe('grace_reminder:h24');
    expect(slotAt(s, at(E, 72 * HOUR - 1))).toBe('grace_reminder:h24');
    expect(slotAt(s, at(E, 72 * HOUR))).toBe('grace_ended:end');
    expect(slotAt(s, at(E, 72 * HOUR + END_NOTICE_WINDOW_MS))).toBeNull();
    expect(currentSlot(s, at(E, 30 * HOUR))!.periodKey).toBe(`grace:${E.getTime()}`);
    expect(currentSlot(s, at(E, 30 * HOUR))!.about).toEqual(at(E, 72 * HOUR));
  });

  it('without grace: the end is announced for the window, and nothing about grace follows', () => {
    const s = paid({ grace: { decision: 'refused' } });
    expect(slotAt(s, at(E, 3 * DAY))).toBe('paid_expired:end:no_grace');
    expect(slotAt(s, at(E, END_NOTICE_WINDOW_MS))).toBeNull();
    expect(slotsOf(s).map((x) => x.kind)).not.toContain('grace_reminder');
  });

  it('nothing while suspended, cancelled, refused, closed — or for an end a platform grant covers', () => {
    const now = at(E, -24 * HOUR);
    for (const status of ['suspended', 'cancelled', 'rejected']) expect(slotAt(paid({ status }), now)).toBeNull();
    expect(slotAt(paid({ open: false }), now)).toBeNull();
    expect(slotAt(paid({ isComplimentary: true, complimentaryUntil: at(E, DAY) }), now)).toBeNull();
    // A grant that ends before the paid period does not cover its end.
    expect(slotAt(paid({ isComplimentary: true, complimentaryUntil: at(E, -30 * DAY) }), now)).toBe('paid_reminder:h24');
  });

  it('a renewal is another period: the old end’s messages stop applying, the new end’s apply in their turn', () => {
    const renewed = paid({ currentPeriodEnd: at(E, 30 * DAY) });
    const stored = { kind: 'paid_reminder', periodKey: `paid:${E.getTime()}`, threshold: 'h24' };
    expect(isCurrent(stored, currentSlot(paid(), at(E, -HOUR)))).toBe(true);
    expect(isCurrent(stored, currentSlot(renewed, at(E, -HOUR)))).toBe(false);
    expect(nextSlot(renewed, at(E, -HOUR))).toMatchObject({ kind: 'paid_reminder', threshold: 'h72', dueAt: at(E, 27 * DAY) });
  });
});

describe('which channel carries it', () => {
  const ready: WhatsAppFacts = {
    channelOpen: true,
    templateApproved: true,
    numberVerified: true,
    undeliverable: false,
    optOut: 'none',
    consentRequired: false,
    consented: false,
  };

  it('WhatsApp when it can; email for the recorded reasons; the Owner’s own choice stops it', () => {
    expect(whatsappPlan(ready)).toEqual({ action: 'send' });
    expect(whatsappPlan({ ...ready, numberVerified: false })).toEqual({ action: 'fallback', reason: 'number_unverified' });
    expect(whatsappPlan({ ...ready, channelOpen: false })).toEqual({ action: 'fallback', reason: 'whatsapp_disabled' });
    expect(whatsappPlan({ ...ready, templateApproved: false })).toEqual({ action: 'fallback', reason: 'template_unavailable' });
    expect(whatsappPlan({ ...ready, undeliverable: true })).toEqual({ action: 'fallback', reason: 'number_undeliverable' });
    expect(whatsappPlan({ ...ready, optOut: 'optional' })).toEqual({ action: 'stop', reason: 'opted_out' });
    expect(whatsappPlan({ ...ready, optOut: 'all' })).toEqual({ action: 'stop', reason: 'opted_out' });
    expect(whatsappPlan({ ...ready, consentRequired: true })).toEqual({ action: 'stop', reason: 'no_consent' });
    expect(whatsappPlan({ ...ready, consentRequired: true, consented: true })).toEqual({ action: 'send' });
  });

  it('after WhatsApp answers: accepted; temporary retried, then exhausted; refused or closed falls back; an opt-out stops', () => {
    const failed = (reason: 'temporary' | 'rejected' | 'channel_unavailable' | 'not_authorized', providerCode?: number) =>
      ({ status: 'failed' as const, reason, detail: 'd', provider: 'p', ...(providerCode ? { providerCode } : {}) });
    expect(afterWhatsApp({ status: 'accepted', providerMessageId: 'w1', provider: 'p' }, 1, false)).toEqual({ next: 'accepted', providerMessageId: 'w1' });
    expect(afterWhatsApp(failed('temporary'), MAX_WHATSAPP_ATTEMPTS - 1, false)).toEqual({ next: 'retry' });
    expect(afterWhatsApp(failed('temporary'), MAX_WHATSAPP_ATTEMPTS, false)).toEqual({ next: 'fallback', reason: 'retries_exhausted' });
    expect(afterWhatsApp(failed('channel_unavailable'), 1, false)).toEqual({ next: 'fallback', reason: 'whatsapp_disabled' });
    expect(afterWhatsApp(failed('rejected'), 1, false)).toEqual({ next: 'fallback', reason: 'provider_refused' });
    expect(afterWhatsApp(failed('not_authorized'), 1, false)).toEqual({ next: 'fallback', reason: 'provider_refused' });
    expect(afterWhatsApp(failed('rejected', 131026), 1, false)).toEqual({ next: 'fallback', reason: 'number_undeliverable' });
    expect(afterWhatsApp(failed('rejected'), 1, true)).toEqual({ next: 'stop', reason: 'opted_out' });
  });

  it('after email answers: accepted; temporary retried, then failed; anything else failed', () => {
    const failed = (reason: 'temporary' | 'rejected' | 'channel_unavailable') => ({ status: 'failed' as const, reason, detail: 'd', provider: 'p' });
    expect(afterEmail({ status: 'accepted', providerMessageId: null, provider: 'p' }, 1)).toEqual({ next: 'accepted' });
    expect(afterEmail(failed('temporary'), MAX_EMAIL_ATTEMPTS - 1)).toEqual({ next: 'retry' });
    expect(afterEmail(failed('temporary'), MAX_EMAIL_ATTEMPTS)).toEqual({ next: 'stop', reason: 'email_failed' });
    expect(afterEmail(failed('rejected'), 1)).toEqual({ next: 'stop', reason: 'email_failed' });
    expect(afterEmail(failed('channel_unavailable'), 1)).toEqual({ next: 'stop', reason: 'email_unavailable' });
  });

  it('waits 30 s after a first failure, doubling, at most 15 minutes', () => {
    expect([1, 2, 3, 4, 5, 10].map(noticeBackoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 900_000]);
  });
});

describe('what a message says, in the business’s zone and the message’s language', () => {
  const instant = new Date('2026-10-21T14:05:00.000Z');

  it('the exact instant with the zone’s full name — Latin digits in Arabic, 24-hour time', () => {
    expect(formatNoticeInstant(instant, 'UTC', 'en')).toBe('21 October 2026, 14:05 (Coordinated Universal Time)');
    expect(formatNoticeInstant(instant, 'Africa/Nouakchott', 'fr')).toBe('21 octobre 2026, 14:05 (heure moyenne de Greenwich)');
    expect(formatNoticeInstant(instant, 'Asia/Dubai', 'en')).toBe('21 October 2026, 18:05 (Gulf Standard Time)');
    const ar = formatNoticeInstant(instant, 'Africa/Nouakchott', 'ar');
    expect(ar).toMatch(/^21 أكتوبر 2026، 14:05 \(.+\)$/);
    expect(ar).not.toMatch(/[٠-٩]/);
  });

  it('the time left in words: days before an end, hours of grace', () => {
    expect(['h72', 'h48', 'h24'].map((t) => daysLeftText(t as 'h72', 'en'))).toEqual(['3 days', '2 days', '1 day']);
    expect(['h72', 'h48', 'h24'].map((t) => daysLeftText(t as 'h72', 'ar'))).toEqual(['3 أيام', 'يومين', 'يوم واحد']);
    expect([graceHoursLeftText('h48', 'fr'), graceHoursLeftText('h24', 'fr')]).toEqual(['48 heures', '24 heures']);
  });
});
