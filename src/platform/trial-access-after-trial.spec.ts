import { Logger } from '@nestjs/common';
import { CTX, HOUR, makeTrialBillingWorld, type Business, type TrialBillingWorld } from './__testing__/trial-billing-world';
import { TrialRefusal } from './trial/trial-refusal';

/**
 * C6 (review finding R4-03): the trial's view says what follows it — `accessAfterTrial`, the paid period or the grant
 * the platform approved while it ran, starting the moment it ends; null when nothing does (the business then turns
 * read-only) and while the trial is only available.
 *
 * The website's trial card said "When it ends, your business becomes read-only" beside a period card saying paid
 * access starts at the trial's end: the view gave it nothing to tell the two apart. Every reader of the view is asked
 * here, through the real services (trial-billing-world): GET entitlement (and so GET my-subscription, which returns
 * it), the website's trial card (GET platform/my-subscription/trial), and the claim's own answers.
 */

const CLAIMED = new Date('2026-10-14T09:30:00.123Z');
const T = new Date(CLAIMED.getTime() + 168 * HOUR);

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

/** The view as each reader returns it: the entitlement's, and the website's trial card's. */
async function views(w: TrialBillingWorld, b: Business) {
  const entitlement = await w.entitlement.forCompany(b.companyId);
  const card = await w.trial.status({ companyId: b.companyId, userId: b.ownerId });
  expect(card.trial).toEqual(entitlement.trial);
  return { entitlement, card, trial: entitlement.trial };
}

/** Claimed at CLAIMED; the clock an hour later. */
async function claimed() {
  const w = makeTrialBillingWorld({ now: CLAIMED });
  const b = w.business({ name: 'Boutique' });
  const answer = await w.claim(b);
  w.clock.set(new Date(CLAIMED.getTime() + HOUR));
  return { w, b, answer };
}

describe('C6: what follows the trial, as every reader says it', () => {
  it('available: nothing claimed, nothing to follow', async () => {
    const w = makeTrialBillingWorld({ now: CLAIMED });
    const b = w.business({ name: 'Boutique' });
    const { entitlement, card } = await views(w, b);
    expect(entitlement.state).toBe('trial_available');
    expect(card.trial).toMatchObject({ status: 'available', endsAt: null, accessAfterTrial: null });
  });

  it('none: claimed and nothing approved — null while it runs, and the business turns read-only at the end', async () => {
    const { w, b, answer } = await claimed();
    // The claim's own answer: nothing can follow a trial claimed this instant.
    expect(answer.trial).toMatchObject({ status: 'active', endsAt: T.toISOString(), accessAfterTrial: null });
    const running = await views(w, b);
    expect(running.entitlement.state).toBe('trial_active');
    expect(running.trial).toMatchObject({ status: 'active', accessAfterTrial: null });

    w.clock.set(T);
    const ended = await views(w, b);
    expect(ended.entitlement.state).toBe('trial_expired');
    expect(ended.trial).toMatchObject({ status: 'expired', accessAfterTrial: null });
  });

  it('paid: approved while it runs — paid access starts at its end, in UTC; and once it has ended, that is what followed it', async () => {
    const { w, b } = await claimed();
    await w.lifecycle.approve(w.uuid(b.companyId), { months: 1, reason: 'Paid by transfer' }, CTX);
    const running = await views(w, b);
    expect(running.entitlement.state).toBe('trial_active');
    expect(running.trial).toMatchObject({ status: 'active', accessAfterTrial: { kind: 'paid', startsAt: T.toISOString() } });
    // The same instant as the trial's end and the first paid period's start: one moment, three readings.
    expect(running.trial!.accessAfterTrial!.startsAt).toBe(running.trial!.endsAt);
    expect(w.periods(b)[0].periodStart).toEqual(T);

    w.clock.set(new Date(T.getTime() + HOUR));
    const ended = await views(w, b);
    expect(ended.entitlement.state).toBe('active');
    expect(ended.trial).toMatchObject({ status: 'expired', accessAfterTrial: { kind: 'paid', startsAt: T.toISOString() } });
  });

  it('granted: the platform’s grant while it runs — it starts at its end, and is said as a grant, never as paid access', async () => {
    const { w, b } = await claimed();
    await w.lifecycle.activateByGrant(w.uuid(b.companyId), { days: 30, reason: 'Pilot shop' }, CTX);
    const running = await views(w, b);
    expect(running.trial).toMatchObject({ status: 'active', accessAfterTrial: { kind: 'granted', startsAt: T.toISOString() } });

    w.clock.set(new Date(T.getTime() + HOUR));
    const ended = await views(w, b);
    expect(ended.entitlement.state).toBe('complimentary');
    expect(ended.trial).toMatchObject({ status: 'expired', accessAfterTrial: { kind: 'granted', startsAt: T.toISOString() } });
  });

  it('approved only after the trial ended: paid access started then, not at the end — nothing followed the trial', async () => {
    const { w, b } = await claimed();
    w.clock.set(new Date(T.getTime() + 2 * HOUR));
    await w.lifecycle.approve(w.uuid(b.companyId), { months: 1, reason: 'Paid late' }, CTX);
    const { entitlement, trial } = await views(w, b);
    expect(entitlement.state).toBe('active');
    expect(trial).toMatchObject({ status: 'expired', accessAfterTrial: null });
    expect(w.periods(b)[0].periodStart).toEqual(new Date(T.getTime() + 2 * HOUR));
  });

  it('a suspension blocks what was arranged without undoing it; a cancellation ends it', async () => {
    const { w, b } = await claimed();
    await w.lifecycle.approve(w.uuid(b.companyId), { months: 1 }, CTX);
    await w.lifecycle.suspend(w.uuid(b.companyId), { reason: 'Checking documents' }, CTX);
    const suspended = await views(w, b);
    expect(suspended.entitlement.state).toBe('suspended');
    expect(suspended.trial).toMatchObject({ status: 'active', accessAfterTrial: { kind: 'paid', startsAt: T.toISOString() } });

    await w.lifecycle.cancel(w.uuid(b.companyId), { reason: 'Closed the shop' }, CTX);
    const cancelled = await views(w, b);
    expect(cancelled.entitlement.state).toBe('cancelled');
    expect(cancelled.trial).toMatchObject({ status: 'active', accessAfterTrial: null });
  });

  it('a second claim is refused with the trial as it stands — what follows it included', async () => {
    const { w, b } = await claimed();
    await w.lifecycle.approve(w.uuid(b.companyId), { months: 1 }, CTX);
    const refused = await w.claim(b, 'another-key').catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(TrialRefusal);
    expect((refused as TrialRefusal).code).toBe('trial_already_claimed');
    expect((refused as TrialRefusal).details.trial).toMatchObject({ status: 'active', accessAfterTrial: { kind: 'paid', startsAt: T.toISOString() } });
  });
});
