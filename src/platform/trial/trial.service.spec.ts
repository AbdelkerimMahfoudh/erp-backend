import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictException, Logger } from '@nestjs/common';
import { binToUuid } from '../../common/utils/uuid.util';
import { BillingService } from '../../billing/billing.service';
import { PlatformAuditService } from '../platform-audit.service';
import { SubscriptionLifecycleService } from '../subscription-lifecycle.service';
import { NOW, REGISTERED_AT, makeTrialWorld, type Business, type TrialWorld } from '../__testing__/trial-world';
import { TRIAL_TERMS_VERSION, claimRequestHash } from './trial-rules';
import { TrialRefusal } from './trial-refusal';
import type { ClaimInput } from './trial.service';

/**
 * The free trial on the website: the Owner's card, the setup link, and the claim (0095; docs/76; the owner's
 * decisions, correction and clarification of 2026-10-13).
 *
 * Every case runs the real service over a world that locks, rolls back and refuses duplicates the way the database
 * does (`__testing__/trial-world.ts`). The rules it proves: only the Owner, only with the contacts they proved, only
 * a business that may — once, ever — exactly 168 hours from the server's instant taken under the lock; the setup
 * link is a convenience and never a key; and a claim is a fact, never a payment.
 */

const HOUR = 3600_000;
const TRIAL_MS = 168 * HOUR;

function claimOf(key: string, extra: Partial<ClaimInput> = {}): ClaimInput {
  return { idempotencyKey: key, termsVersion: TRIAL_TERMS_VERSION, ...extra };
}

/** The refusal a call ends in: its code, its status, and the body a client receives. */
async function refusal(promise: Promise<unknown>): Promise<{ code: string; status: number; body: Record<string, unknown> }> {
  const e = await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (err: unknown) => err,
  );
  if (!(e instanceof TrialRefusal)) throw e;
  return { code: e.code, status: e.getStatus(), body: e.getResponse() as Record<string, unknown> };
}

function actorOf(who: { userId: Buffer }): string {
  return `user:${binToUuid(who.userId)}`;
}

describe('the Owner starts the free trial on the website', () => {
  let w: TrialWorld;
  let shop: Business;
  beforeEach(() => {
    w = makeTrialWorld();
    shop = w.business();
  });

  it('a signed-in eligible Owner claims WITHOUT any token: 168 hours from the server instant, nothing charged', async () => {
    const versionBefore = w.subscription(shop).version;
    const answer = await w.service.claim(shop.owner, claimOf('k-1'));

    expect(answer).toEqual({
      claimed: true,
      replayed: false,
      state: 'trial_active',
      trial: {
        status: 'active',
        durationHours: 168,
        durationDays: 7,
        claimedAt: NOW.toISOString(),
        startedAt: NOW.toISOString(),
        endsAt: new Date(NOW.getTime() + TRIAL_MS).toISOString(),
        timeZone: 'Africa/Nouakchott',
      },
      subscriptionVersion: versionBefore + 1,
    });

    const [claim] = w.claims(shop);
    expect(w.claims(shop)).toHaveLength(1);
    expect(claim).toMatchObject({
      claimedAt: NOW,
      startedAt: NOW,
      endsAt: new Date(NOW.getTime() + TRIAL_MS),
      termsVersion: TRIAL_TERMS_VERSION,
      idempotencyKey: 'k-1',
      requestHash: claimRequestHash(TRIAL_TERMS_VERSION, null),
      subscriptionVersionAfter: versionBefore + 1,
      setupLinkId: null,
      createdAt: NOW,
    });
    expect(claim.claimantUserId.equals(shop.ownerId)).toBe(true);
    expect(claim.eligibilityId.equals(w.eligibility(shop)!.id)).toBe(true);
    // The lock is the first thing the claim does, on this business's subscription.
    expect(w.locks).toEqual([binToUuid(shop.companyId)]);
  });

  it('the instant is the server’s, read after the lock — not the account’s creation, not before the wait', async () => {
    // The claim waits 2.5 s for the subscription lock (another writer held it).
    w.hooks.onLock = () => w.clock.advance(2_500);
    const asked = w.clock.now();
    const answer = await w.service.claim(shop.owner, claimOf('k-1'));

    const started = Date.parse(answer.trial.startedAt!);
    expect(started).toBe(asked.getTime() + 2_500);
    expect(started).toBeGreaterThan(REGISTERED_AT.getTime());
    expect(w.eligibility(shop)!.createdAt).toEqual(REGISTERED_AT);
    expect(Date.parse(answer.trial.endsAt!) - started).toBe(TRIAL_MS);
  });

  it('runs to the millisecond before its end and is over at the end', async () => {
    const answer = await w.service.claim(shop.owner, claimOf('k-1'));
    const endsAt = Date.parse(answer.trial.endsAt!);

    w.clock.set(new Date(endsAt - 1));
    expect((await w.service.status(shop.owner)).state).toBe('trial_active');
    w.clock.set(new Date(endsAt));
    const after = await w.service.status(shop.owner);
    expect(after.state).toBe('trial_expired');
    expect(after.trial).toMatchObject({ status: 'expired', endsAt: answer.trial.endsAt });
  });

  it('is a fact, never a payment: no payment, billing period, seat, status, period or grant changes', async () => {
    const before = { ...w.subscription(shop) };
    await w.service.claim(shop.owner, claimOf('k-1'));

    expect(w.t.payments).toHaveLength(0);
    expect(w.t.periods).toHaveLength(0);
    expect(w.t.seats).toHaveLength(0);
    const after = w.subscription(shop);
    expect(after).toEqual({ ...before, version: before.version + 1 });
    // The eligibility stays as it was: only a Super Admin decision closes it.
    expect(w.eligibility(shop)).toMatchObject({ closedAt: null, closedReason: null });
    expect(w.events(shop).map((e) => e.kind)).toEqual(['trial_claimed']);
  });

  it('writes the timeline and the audit — the audit last, both at the claim instant, neither with a contact', async () => {
    await w.service.claim(shop.owner, claimOf('k-1'));
    const end = new Date(NOW.getTime() + TRIAL_MS).toISOString();

    expect(w.events(shop)).toEqual([
      expect.objectContaining({
        kind: 'trial_claimed',
        note: `Free trial claimed on the website by the Owner: 7 days from ${NOW.toISOString()} to ${end}. Nothing was charged.`,
        actor: actorOf(shop.owner),
        createdAt: NOW,
      }),
    ]);
    const audits = w.audits(shop);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'trial.claim',
      actor: actorOf(shop.owner),
      adminId: null,
      targetType: 'Company',
      targetLabel: 'Shop 1',
      createdAt: NOW,
      afterJson: {
        claimedAt: NOW.toISOString(),
        startedAt: NOW.toISOString(),
        endsAt: end,
        termsVersion: TRIAL_TERMS_VERSION,
        subscriptionVersion: 5,
        viaLink: false,
      },
    });
    expect(w.t.audits.indexOf(audits[0])).toBe(w.t.audits.length - 1);
    expect(JSON.stringify(audits)).not.toMatch(/@shop\.test|\+2223|argon2/);
  });

  it('retires a setup link it did not use: no link may still read as valid once the trial started', async () => {
    const unused = w.issueLink(shop);
    await w.service.claim(shop.owner, claimOf('k-1'));

    expect(w.link(unused)).toMatchObject({ consumedAt: null, revokedAt: NOW, revokedReason: 'claimed' });
    expect((await w.service.checkLink(shop.owner, unused)).link).toBe('revoked');
  });

  it('a stale version prepared before the claim is refused to the Super Admin (409)', async () => {
    const prepared = w.subscription(shop).version;
    await w.service.claim(shop.owner, claimOf('k-1'));

    const lifecycle = new SubscriptionLifecycleService(
      w.db as never,
      new PlatformAuditService(w.db as never),
      new BillingService(w.db as never, w.clock),
      w.clock,
    );
    const admin = { admin: { id: Buffer.alloc(16, 1), email: 'ops@example.test', name: 'Ops' }, ip: null };
    const stale = await lifecycle.suspend(binToUuid(shop.companyId), { reason: 'review', expectedVersion: prepared }, admin).catch((e) => e);
    expect(stale).toBeInstanceOf(ConflictException);
    expect((stale as ConflictException).getResponse()).toMatchObject({ code: 'subscription_changed' });
    expect(w.subscription(shop).status).toBe('pending_activation');
  });
});

describe('only the Owner — checked first, whatever the trial’s state', () => {
  it('a Manager, an Employee and a legacy administrator are refused owner_only on every trial route', async () => {
    const w = makeTrialWorld();
    const shop = w.business();
    for (const role of ['store_manager', 'store_employee', 'administrator'] as const) {
      const who = w.staff(shop, role);
      expect(await refusal(w.service.claim(who, claimOf(`k-${role}`)))).toMatchObject({ code: 'owner_only', status: 403 });
      expect(await refusal(w.service.status(who))).toMatchObject({ code: 'owner_only', status: 403 });
      expect(await refusal(w.service.checkLink(who, 'x'.repeat(43)))).toMatchObject({ code: 'owner_only', status: 403 });
    }
    expect(w.claims(shop)).toHaveLength(0);
    expect(w.subscription(shop).version).toBe(4);
  });

  it('tells a Manager nothing about the trial: owner_only even when it is claimed, suspended or closed', async () => {
    const w = makeTrialWorld();
    const claimed = w.business();
    await w.service.claim(claimed.owner, claimOf('k-1'));
    const suspended = w.business({ status: 'suspended' });
    const closed = w.business({ closed: true });
    for (const b of [claimed, suspended, closed]) {
      const manager = w.staff(b, 'store_manager');
      expect(await refusal(w.service.claim(manager, claimOf('k-2')))).toMatchObject({ code: 'owner_only' });
    }
  });

  it('an Owner whose account was deactivated or deleted is refused like anybody else', async () => {
    const w = makeTrialWorld();
    const shop = w.business();
    w.owner(shop).isActive = false;
    expect(await refusal(w.service.claim(shop.owner, claimOf('k-1')))).toMatchObject({ code: 'owner_only' });
    w.owner(shop).isActive = true;
    w.owner(shop).deletedAt = NOW;
    expect(await refusal(w.service.claim(shop.owner, claimOf('k-1')))).toMatchObject({ code: 'owner_only' });
  });

  it('the refusal is audited — the code and the caller, outside the transaction that refused it', async () => {
    const w = makeTrialWorld();
    const shop = w.business();
    const manager = w.staff(shop, 'store_manager');
    await w.service.claim(manager, claimOf('k-1')).catch(() => undefined);
    expect(w.audits(shop)).toEqual([
      expect.objectContaining({ action: 'trial.claim_refused', actor: actorOf(manager), afterJson: { reason: 'owner_only' } }),
    ]);
  });
});

describe('the contacts given at registration must be verified — each named when it is not', () => {
  const cases: [string, Parameters<TrialWorld['business']>[0], string[]][] = [
    ['email given, not verified', { contacts: 'email', verified: [] }, ['email']],
    ['number given, not verified', { contacts: 'phone', verified: [] }, ['phone']],
    ['both given, neither verified', { contacts: 'both', verified: [] }, ['email', 'phone']],
    ['both given, only the email verified', { contacts: 'both', verified: ['email'] }, ['phone']],
    ['both given, only the number verified', { contacts: 'both', verified: ['phone'] }, ['email']],
  ];
  it.each(cases)('%s → contact_unverified %j', async (_name, opts, missing) => {
    const w = makeTrialWorld();
    const shop = w.business(opts);
    const r = await refusal(w.service.claim(shop.owner, claimOf('k-1')));
    expect(r).toMatchObject({ code: 'contact_unverified', status: 409, body: { missingContacts: missing } });
    expect(w.claims(shop)).toHaveLength(0);
    // Audited with the kinds that are missing — never a value.
    expect(w.audits(shop)).toEqual([
      expect.objectContaining({ action: 'trial.claim_refused', afterJson: { reason: 'contact_unverified', missingContacts: missing } }),
    ]);
    expect(JSON.stringify(w.audits(shop))).not.toMatch(/@shop\.test|\+2223/);
  });

  it('a verified number that was since removed counts as missing', async () => {
    const w = makeTrialWorld();
    const shop = w.business({ contacts: 'both' });
    w.owner(shop).phone = null;
    expect(await refusal(w.service.claim(shop.owner, claimOf('k-1')))).toMatchObject({ body: { missingContacts: ['phone'] } });
  });
});

describe('one trial per business, ever', () => {
  let w: TrialWorld;
  let shop: Business;
  beforeEach(() => {
    w = makeTrialWorld();
    shop = w.business();
  });

  it('the same key and request replay the claim: the instants and version it recorded, nothing written again', async () => {
    const first = await w.service.claim(shop.owner, claimOf('k-1'));
    w.clock.advance(30_000);
    const again = await w.service.claim(shop.owner, claimOf('k-1'));

    expect(again).toEqual({ ...first, replayed: true });
    expect(w.claims(shop)).toHaveLength(1);
    expect(w.subscription(shop).version).toBe(first.subscriptionVersion);
    expect(w.events(shop)).toHaveLength(1);
    expect(w.audits(shop).filter((a) => a.action === 'trial.claim')).toHaveLength(1);
  });

  it('the same key with another request is a conflict', async () => {
    await w.service.claim(shop.owner, claimOf('k-1'));
    expect(await refusal(w.service.claim(shop.owner, claimOf('k-1', { termsVersion: 'other' })))).toMatchObject({
      code: 'idempotency_conflict',
      status: 409,
    });
    expect(await refusal(w.service.claim(shop.owner, claimOf('k-1', { token: 'y'.repeat(43) })))).toMatchObject({
      code: 'idempotency_conflict',
    });
  });

  it('another key is told the trial was used, with the trial it started — and so is any claim after it ended', async () => {
    const first = await w.service.claim(shop.owner, claimOf('k-1'));
    const second = await refusal(w.service.claim(shop.owner, claimOf('k-2')));
    expect(second).toMatchObject({ code: 'trial_already_claimed', status: 409, body: { trial: first.trial } });

    w.clock.set(new Date(Date.parse(first.trial.endsAt!) + HOUR));
    const late = await refusal(w.service.claim(shop.owner, claimOf('k-3')));
    expect(late).toMatchObject({ code: 'trial_already_claimed', body: { trial: { status: 'expired', endsAt: first.trial.endsAt } } });
    expect(w.claims(shop)).toHaveLength(1);
  });

  it('six claims at once, with six keys: one trial, five told it was used', async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => w.service.claim(shop.owner, claimOf(`k-${i}`))));
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost.map((r) => (r.reason as TrialRefusal).code)).toEqual(Array(5).fill('trial_already_claimed'));
    expect(w.claims(shop)).toHaveLength(1);
    expect(w.subscription(shop).version).toBe(5);
    // Each claim took the lock before it read anything.
    expect(w.locks).toHaveLength(6);
  });

  it('four retries of one attempt at once: one trial, three replays of it', async () => {
    const answers = await Promise.all(Array.from({ length: 4 }, () => w.service.claim(shop.owner, claimOf('k-1'))));
    expect(answers.filter((a) => !a.replayed)).toHaveLength(1);
    expect(new Set(answers.map((a) => a.trial.endsAt)).size).toBe(1);
    expect(w.claims(shop)).toHaveLength(1);
  });

  it('the unique index is the backstop: a claim that read none and lost the insert answers like the winner’s', async () => {
    await w.service.claim(shop.owner, claimOf('k-1'));

    // A claim whose reading missed the winner's row (a race the lock normally prevents) collides on insert.
    w.hooks.hideClaims = 1;
    const other = await refusal(w.service.claim(shop.owner, claimOf('k-2')));
    expect(other).toMatchObject({ code: 'trial_already_claimed' });

    w.hooks.hideClaims = 1;
    const retry = await w.service.claim(shop.owner, claimOf('k-1'));
    expect(retry.replayed).toBe(true);

    expect(w.claims(shop)).toHaveLength(1);
    // The losers' writes rolled back: one version bump, one event, and the refusal audited.
    expect(w.subscription(shop).version).toBe(5);
    expect(w.events(shop)).toHaveLength(1);
    expect(w.audits(shop).map((a) => a.action)).toEqual(['trial.claim', 'trial.claim_refused']);
  });
});

describe('what stops a claim, each with its own code — in the claim’s own order', () => {
  it.each([
    ['paid access approved (eligibility closed)', { status: 'activated' as const, currentPeriodEnd: new Date(NOW.getTime() + 30 * 24 * HOUR), eligibilityClosed: 'approved' as const }, 'trial_not_available'],
    ['access granted (eligibility closed)', { status: 'activated' as const, complimentaryUntil: new Date(NOW.getTime() + 30 * 24 * HOUR), eligibilityClosed: 'granted' as const }, 'trial_not_available'],
    ['a business the console created (never eligible)', { eligible: false }, 'trial_not_available'],
    ['closed by an approval that won the lock first', { eligibilityClosed: 'approved' as const }, 'trial_not_available'],
    ['refused', { status: 'rejected' as const, eligibilityClosed: 'refused' as const }, 'business_refused'],
    ['suspended', { status: 'suspended' as const }, 'business_suspended'],
    ['cancelled', { status: 'cancelled' as const, eligibilityClosed: 'cancelled' as const }, 'business_closed'],
    ['closed by its Owner', { closed: true }, 'business_closed'],
    ['no subscription at all', { noSubscription: true }, 'trial_not_available'],
  ])('%s → %s', async (_name, opts, code) => {
    const w = makeTrialWorld();
    const shop = w.business(opts);
    // A closed business's Owner is inactive; the refusal under test is the business's, so the Owner is kept active.
    w.owner(shop).isActive = true;
    expect(await refusal(w.service.claim(shop.owner, claimOf('k-1')))).toMatchObject({ code, status: 409 });
    expect(w.claims(shop)).toHaveLength(0);
    expect(w.audits(shop)).toEqual([expect.objectContaining({ action: 'trial.claim_refused', afterJson: { reason: code } })]);
  });

  it('suspension blocks and never closes: reinstated, the same business claims its trial', async () => {
    const w = makeTrialWorld();
    const shop = w.business({ status: 'suspended' });
    expect(await refusal(w.service.claim(shop.owner, claimOf('k-1')))).toMatchObject({ code: 'business_suspended' });
    // Reinstated: `activated`, with nothing paid and the eligibility still open.
    w.subscription(shop).status = 'activated';
    expect(await w.service.claim(shop.owner, claimOf('k-1'))).toMatchObject({ state: 'trial_active' });
  });

  it('terms the website did not show are refused, with the terms in force', async () => {
    const w = makeTrialWorld();
    const shop = w.business();
    expect(await refusal(w.service.claim(shop.owner, claimOf('k-1', { termsVersion: '2026-01-01' })))).toMatchObject({
      code: 'terms_changed',
      status: 409,
      body: { termsVersion: TRIAL_TERMS_VERSION },
    });
  });

  it('a business decision outranks the contacts: a suspended business is told it is suspended', async () => {
    const w = makeTrialWorld();
    const shop = w.business({ status: 'suspended', verified: [] });
    expect(await refusal(w.service.claim(shop.owner, claimOf('k-1')))).toMatchObject({ code: 'business_suspended' });
  });
});

describe('the setup link: a convenience, never a key (the owner’s clarification)', () => {
  let w: TrialWorld;
  let shop: Business;
  beforeEach(() => {
    w = makeTrialWorld();
    shop = w.business();
  });

  it('valid: checking it consumes nothing; the explicit claim consumes it, once', async () => {
    const token = w.issueLink(shop);
    expect(await w.service.checkLink(shop.owner, token)).toMatchObject({ link: 'valid', state: 'trial_available', offer: { available: true } });
    expect(await w.service.checkLink(shop.owner, token)).toMatchObject({ link: 'valid' });
    expect(w.link(token).consumedAt).toBeNull();

    const answer = await w.service.claim(shop.owner, claimOf('k-1', { token }));
    expect(answer.replayed).toBe(false);
    expect(w.link(token)).toMatchObject({ consumedAt: NOW, revokedAt: null });
    expect(w.claims(shop)[0].setupLinkId.equals(w.link(token).id)).toBe(true);
    expect(w.audits(shop).find((a) => a.action === 'trial.claim')!.afterJson).toMatchObject({ viaLink: true });
    expect((await w.service.checkLink(shop.owner, token)).link).toBe('used');
  });

  it('the claim consumes its own link and retires every other one', async () => {
    const older = w.issueLink(shop);
    const token = w.issueLink(shop);
    await w.service.claim(shop.owner, claimOf('k-1', { token }));
    expect(w.link(token)).toMatchObject({ consumedAt: NOW, revokedReason: null });
    expect(w.link(older)).toMatchObject({ consumedAt: null, revokedAt: NOW, revokedReason: 'claimed' });
  });

  it('forged: invalid — refused with link_invalid; nothing changes, and the claim without it then succeeds', async () => {
    expect((await w.service.checkLink(shop.owner, 'x'.repeat(43))).link).toBe('invalid');
    expect(await refusal(w.service.claim(shop.owner, claimOf('k-1', { token: 'x'.repeat(43) })))).toMatchObject({
      code: 'link_invalid',
      status: 400,
    });
    expect(w.claims(shop)).toHaveLength(0);
    expect(w.eligibility(shop)!.closedAt).toBeNull();
    expect((await w.service.status(shop.owner)).offer).toMatchObject({ available: true });
    await expect(w.service.claim(shop.owner, claimOf('k-2'))).resolves.toMatchObject({ state: 'trial_active' });
  });

  it('expired after 24 hours: link_expired (410), the eligibility untouched, and a fresh claim without it succeeds', async () => {
    const token = w.issueLink(shop);
    w.clock.advance(24 * HOUR);
    expect((await w.service.checkLink(shop.owner, token)).link).toBe('expired');
    expect(await refusal(w.service.claim(shop.owner, claimOf('k-1', { token })))).toMatchObject({ code: 'link_expired', status: 410 });
    expect(w.link(token).consumedAt).toBeNull();
    const answer = await w.service.claim(shop.owner, claimOf('k-2'));
    expect(Date.parse(answer.trial.startedAt!)).toBe(NOW.getTime() + 24 * HOUR);
    // A minute before its end it still worked.
    const fresh = makeTrialWorld();
    const other = fresh.business();
    const live = fresh.issueLink(other);
    fresh.clock.advance(24 * HOUR - 1);
    expect((await fresh.service.checkLink(other.owner, live)).link).toBe('valid');
  });

  it('used or revoked: link_used / link_revoked (409)', async () => {
    const used = w.issueLink(shop);
    w.link(used).consumedAt = NOW;
    const revoked = w.issueLink(shop);
    Object.assign(w.link(revoked), { revokedAt: NOW, revokedReason: 'reissued' });

    expect((await w.service.checkLink(shop.owner, used)).link).toBe('used');
    expect((await w.service.checkLink(shop.owner, revoked)).link).toBe('revoked');
    expect(await refusal(w.service.claim(shop.owner, claimOf('k-1', { token: used })))).toMatchObject({ code: 'link_used', status: 409 });
    expect(await refusal(w.service.claim(shop.owner, claimOf('k-2', { token: revoked })))).toMatchObject({ code: 'link_revoked', status: 409 });
    expect(w.claims(shop)).toHaveLength(0);
  });

  it.each([
    ['the password changed', (o: Record<string, any>) => (o.passwordHash = '$argon2id$another')],
    ['the email changed', (o: Record<string, any>) => (o.email = 'new@shop.test')],
    ['the number was verified since', (o: Record<string, any>) => (o.phoneVerifiedAt = NOW)],
    ['the email’s verification changed', (o: Record<string, any>) => (o.emailVerifiedAt = new Date(REGISTERED_AT.getTime() + 1))],
  ])('stale binding — %s: revoked, and a claim with it is refused', async (_name, change) => {
    const token = w.issueLink(shop);
    change(w.owner(shop));
    expect((await w.service.checkLink(shop.owner, token)).link).toBe('revoked');
    expect(await refusal(w.service.claim(shop.owner, claimOf('k-1', { token })))).toMatchObject({ code: 'link_revoked' });
  });

  it('another business’s link: other_account — and a claim with it is refused, both businesses untouched', async () => {
    const other = w.business();
    const theirs = w.issueLink(other);
    expect((await w.service.checkLink(shop.owner, theirs)).link).toBe('other_account');
    expect(await refusal(w.service.claim(shop.owner, claimOf('k-1', { token: theirs })))).toMatchObject({
      code: 'link_other_account',
      status: 403,
    });
    expect(w.claims(shop)).toHaveLength(0);
    expect(w.claims(other)).toHaveLength(0);
    expect(w.link(theirs)).toMatchObject({ consumedAt: null, revokedAt: null });
    // The other Owner's own link still works for them.
    expect((await w.service.checkLink(other.owner, theirs)).link).toBe('valid');
  });

  it('a claim refused for another reason consumes nothing, even with a valid link', async () => {
    const token = w.issueLink(shop);
    await w.service.claim(shop.owner, claimOf('k-1', { token, termsVersion: 'old' })).catch(() => undefined);
    expect(w.link(token)).toMatchObject({ consumedAt: null, revokedAt: null });
  });

  it('only a refused outcome is audited — the outcome, never the token', async () => {
    const token = w.issueLink(shop);
    await w.service.checkLink(shop.owner, token);
    expect(w.audits(shop)).toHaveLength(0);
    await w.service.checkLink(shop.owner, 'z'.repeat(43));
    expect(w.audits(shop)).toEqual([
      expect.objectContaining({ action: 'trial.link_refused', actor: actorOf(shop.owner), afterJson: { outcome: 'invalid' } }),
    ]);
    expect(JSON.stringify(w.t.audits)).not.toContain(token);
    expect(JSON.stringify(w.t.audits)).not.toContain('z'.repeat(43));
  });

  it('with no key to bind with (production without a pepper), no link is ever valid', async () => {
    const token = w.issueLink(shop);
    w.config.otpPepper = null;
    const env = { ...process.env };
    process.env.NODE_ENV = 'production';
    try {
      expect((await w.service.checkLink(shop.owner, token)).link).toBe('revoked');
    } finally {
      process.env.NODE_ENV = env.NODE_ENV;
    }
  });
});

describe('the offer the website shows', () => {
  it('available: the terms, 168 hours from now, the business’s own zone, and the contacts', async () => {
    const w = makeTrialWorld();
    const shop = w.business({ contacts: 'both', timezone: 'Asia/Dubai' });
    expect(await w.service.status(shop.owner)).toEqual({
      state: 'trial_available',
      trial: {
        status: 'available',
        durationHours: 168,
        durationDays: 7,
        claimedAt: null,
        startedAt: null,
        endsAt: null,
        timeZone: 'Asia/Dubai',
      },
      offer: {
        available: true,
        reason: null,
        termsVersion: TRIAL_TERMS_VERSION,
        durationHours: 168,
        wouldStartAt: NOW.toISOString(),
        wouldEndAt: new Date(NOW.getTime() + TRIAL_MS).toISOString(),
        timeZone: 'Asia/Dubai',
        requiredContacts: ['email', 'phone'],
        missingContacts: [],
      },
      // Where the setup instructions stand — shown beside the offer, never a condition of it.
      setup: {
        delivery: 'not_sent',
        sentTo: [],
        destinations: [
          { channel: 'email', masked: 'o•••@shop.test' },
          { channel: 'whatsapp', masked: '+222••••0001' },
        ],
        lastAttemptAt: null,
        canResendNow: true,
        resendBlockedBy: null,
        resendAvailableAt: null,
        history: [],
      },
      calculatedAt: NOW.toISOString(),
    });
  });

  it('an unknown stored zone is shown as UTC — never a zone guessed for the country — and reported once', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const w = makeTrialWorld();
      const shop = w.business({ timezone: 'Mars/Olympus' });
      const card = await w.service.status(shop.owner);
      expect(card.offer!.timeZone).toBe('UTC');
      expect(card.trial!.timeZone).toBe('UTC');
      await w.service.status(shop.owner);
      expect(warn.mock.calls.filter(([m]) => /unknown time zone "Mars\/Olympus"/.test(String(m)))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('kept but not available while something can still be fixed: a contact, or a suspension', async () => {
    const w = makeTrialWorld();
    const unverified = w.business({ contacts: 'both', verified: ['email'] });
    expect((await w.service.status(unverified.owner)).offer).toMatchObject({
      available: false,
      reason: 'contact_unverified',
      missingContacts: ['phone'],
    });
    const suspended = w.business({ status: 'suspended' });
    expect((await w.service.status(suspended.owner)).offer).toMatchObject({ available: false, reason: 'business_suspended' });
  });

  it('none at all once claimed, or for a business that can never claim', async () => {
    const w = makeTrialWorld();
    const claimed = w.business();
    await w.service.claim(claimed.owner, claimOf('k-1'));
    const card = await w.service.status(claimed.owner);
    expect(card).toMatchObject({ state: 'trial_active', offer: null, trial: { status: 'active' } });

    for (const opts of [
      { eligibilityClosed: 'approved' as const, status: 'activated' as const, currentPeriodEnd: new Date(NOW.getTime() + HOUR) },
      { status: 'rejected' as const, eligibilityClosed: 'refused' as const },
      { closed: true },
      { eligible: false },
    ]) {
      const b = w.business(opts);
      w.owner(b).isActive = true;
      expect((await w.service.status(b.owner)).offer).toBeNull();
    }
  });

  it('never depends on delivery or on any link: lost, expired, used, revoked or none — the same offer', async () => {
    const w = makeTrialWorld();
    const none = w.business();
    const withLinks = w.business();
    const expired = w.issueLink(withLinks, { issuedAt: new Date(NOW.getTime() - 25 * HOUR) });
    const revoked = w.issueLink(withLinks);
    Object.assign(w.link(revoked), { revokedAt: NOW, revokedReason: 'reissued' });
    void expired;
    const a = (await w.service.status(none.owner)).offer;
    const b = (await w.service.status(withLinks.owner)).offer;
    expect(b).toEqual(a);
    expect(a).toMatchObject({ available: true });
  });

  it('a setup status that cannot be read leaves the card standing: the offer, the trial and the state, setup null (C3)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const w = makeTrialWorld();
      const shop = w.business();
      const before = await w.service.status(shop.owner);
      w.setup.websiteSetup = async () => {
        throw new Error('trial_setup_messages could not be read');
      };
      const card = await w.service.status(shop.owner);
      expect(card).toEqual({ ...before, setup: null });
      expect(card.offer).toMatchObject({ available: true, reason: null });
      expect(warn.mock.calls.map(([m]) => String(m))).toEqual([
        `Free trial setup status not read for company ${binToUuid(shop.companyId)}: trial_setup_messages could not be read`,
      ]);
      // And the Owner claims from it.
      await expect(w.service.claim(shop.owner, claimOf('k-1'))).resolves.toMatchObject({ state: 'trial_active' });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('tenant isolation and the trial’s source', () => {
  it('a business reads and claims only itself: another business’s claim changes nothing here', async () => {
    const w = makeTrialWorld();
    const a = w.business();
    const b = w.business();
    await w.service.claim(a.owner, claimOf('same-key'));
    // The same key at another business is another attempt there: its own trial, its own row.
    await expect(w.service.claim(b.owner, claimOf('same-key'))).resolves.toMatchObject({ replayed: false });
    expect(w.claims(a)).toHaveLength(1);
    expect(w.claims(b)).toHaveLength(1);
    expect(w.subscription(a).version).toBe(5);
    expect(w.subscription(b).version).toBe(5);
  });

  it('reads no clock but the injected one, and nothing the request says about where it came from', () => {
    const source = readFileSync('src/platform/trial/trial.service.ts', 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/new Date\(\)|Date\.now\(/);
    expect(code).not.toMatch(/origin|referer|referrer|headers|req\./i);
  });

  it('only a claim writes a trial claim, and only registration writes an eligibility — no other path grants one', () => {
    // Staff, invitations, store openings, replacements, the console: none of them may make a business eligible.
    const sources = (readdirSync('src', { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.includes('__testing__'))
      .map((f) => join('src', f));
    const writers = (pattern: string) => sources.filter((f) => readFileSync(f, 'utf8').includes(pattern)).sort();
    expect(writers('trialClaim.create(')).toEqual(['src/platform/trial/trial.service.ts']);
    expect(writers('trialEligibility.create(')).toEqual(['src/platform/registration.service.ts']);
  });
});
