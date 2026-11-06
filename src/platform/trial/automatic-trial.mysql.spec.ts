import { PrismaClient } from '@prisma/client';
import { BranchEntitlementService } from '../../entitlement/branch-entitlement.service';
import { randomUUID } from 'node:crypto';
import { BillingService } from '../../billing/billing.service';
import { HashingService } from '../../common/security/hashing.service';
import { uuidToBin } from '../../common/utils/uuid.util';
import type { DeliveryResult, WhatsAppMessage } from '../../messaging/whatsapp-channel';
import { NoticeService } from '../../notices/notice.service';
import { BranchRequestsService } from '../branch-requests.service';
import { PlatformAuditService } from '../platform-audit.service';
import { RegistrationService } from '../registration.service';
import { RegistrationContinuationService } from '../registration-continuation.service';
import { newUuidV7Bin } from '../../common/utils/uuid.util';
import { SeatAllocationService } from '../seat-allocation.service';
import { activatePendingBranchesTx } from '../branch-activation';
import { TRIAL_STARTED_PERIOD, startAutomaticTrialTx } from './automatic-trial';
import { TRIAL_DURATION_MS, TRIAL_TERMS_VERSION } from './trial-rules';
import { TrialService } from './trial.service';

/**
 * The automatic free trial (0131; the owner's brief of 2026-11-06), on real MySQL: started once, when a self-registration
 * completes, with its record, audit and WhatsApp notice in the same transaction; never for a console-created, paid,
 * granted or already-started business, nor for a contact that already had one; an old link's claim is told it is already
 * active; a message that fails changes nothing about the trial; an additional branch never receives it.
 */
const url = process.env.PROVISIONING_ROOT_URL;
const suite = url ? describe : describe.skip;

suite('the automatic free trial', () => {
  const root = url ? new PrismaClient({ datasources: { db: { url } } }) : (null as unknown as PrismaClient);
  const db = root as never;
  const audit = url ? new PlatformAuditService(db) : (null as never);
  const registration = url ? new RegistrationService(db, new HashingService(), { now: () => new Date() } as never) : (null as never);
  const entitlement = { trialZone: () => 'Africa/Nouakchott' };
  const trials = url ? new TrialService(db, entitlement as never, audit, null as never, { now: () => new Date() } as never) : (null as never);

  afterAll(() => root.$disconnect());

  let n = 0;
  /** A self-registered (or console-created) business, its Owner's number verified as the registration's code proves it. */
  async function business(opts: { trialEligible?: boolean; verified?: boolean; phone?: string } = {}) {
    const key = randomUUID().replace(/-/g, '').slice(0, 10);
    const phone = opts.phone ?? `+2224${(Date.now() + n++).toString().slice(-7)}`;
    const made = await registration.register({
      idempotencyKey: `spec:${key}`, ownerName: 'Owner', businessName: `Shop ${key}`, branchName: 'Main', phone,
      password: 'unusable-password-for-the-spec', language: 'fr', actor: 'spec', trialEligible: opts.trialEligible ?? true,
    } as never);
    const id = uuidToBin(made.companyId);
    const owner = uuidToBin(made.ownerUserId);
    if (opts.verified ?? true) await root.user.update({ where: { id: owner }, data: { phoneVerifiedAt: new Date() } });
    return { id, owner, phone, key };
  }
  const start = (id: Buffer, owner: Buffer, source: 'registration' | 'sign_in' = 'registration', at = new Date()) =>
    root.$transaction((tx) => startAutomaticTrialTx(tx as never, { companyId: id, ownerUserId: owner, now: () => at, source, audit }));
  const facts = async (id: Buffer) => ({
    claims: await root.trialClaim.findMany({ where: { companyId: id } }),
    notices: await root.subscriptionNotice.findMany({ where: { companyId: id, kind: 'trial_started' } }),
    audits: await root.platformAuditEvent.count({ where: { targetId: id, action: 'trial.start_automatic' } }),
    events: await root.subscriptionEvent.count({ where: { companyId: id, kind: 'trial_claimed' } }),
  });

  it('a completed self-registration: one trial of exactly 168 hours, its event, audit and one notice — together', async () => {
    const { id, owner } = await business();
    const at = new Date();
    const r = await start(id, owner, 'registration', at);
    expect(r).toMatchObject({ started: true });
    const f = await facts(id);
    expect(f.claims).toHaveLength(1);
    expect(f.claims[0].startedAt.getTime()).toBe(at.getTime());
    expect(f.claims[0].endsAt.getTime() - f.claims[0].startedAt.getTime()).toBe(TRIAL_DURATION_MS);
    expect(f.claims[0].idempotencyKey).toBe(`auto:${id.toString('hex')}`);
    expect(f.claims[0].termsVersion).toBe(TRIAL_TERMS_VERSION);
    expect(f.notices).toMatchObject([{ periodKey: TRIAL_STARTED_PERIOD, threshold: 'start', state: 'pending', language: 'fr' }]);
    expect(f.audits).toBe(1);
    expect(f.events).toBe(1);
    // No charge, no renewal: the subscription records no payment and no paid period.
    const sub = await root.subscription.findFirstOrThrow({ where: { companyId: id } });
    expect(sub.currentPeriodEnd).toBeNull();
    expect(await root.subscriptionPayment.count({ where: { companyId: id } })).toBe(0);
  });

  it('a transaction that fails afterwards leaves no trial, no audit and no notice', async () => {
    const { id, owner } = await business();
    await expect(
      root.$transaction(async (tx) => {
        await startAutomaticTrialTx(tx as never, { companyId: id, ownerUserId: owner, now: () => new Date(), source: 'registration', audit });
        throw new Error('the session could not be created');
      }),
    ).rejects.toThrow('the session could not be created');
    expect(await facts(id)).toEqual({ claims: [], notices: [], audits: 0, events: 0 });
  });

  it('a retry, a timeout replayed or a later sign-in: the same trial and dates — never a second one', async () => {
    const { id, owner } = await business();
    await start(id, owner);
    const first = (await facts(id)).claims[0];
    expect(await start(id, owner, 'registration', new Date(Date.now() + 60_000))).toEqual({ started: false, reason: 'already_started' });
    expect(await start(id, owner, 'sign_in', new Date(Date.now() + 3 * 86_400_000))).toEqual({ started: false, reason: 'already_started' });
    const after = await facts(id);
    expect(after.claims).toHaveLength(1);
    expect(after.claims[0].endsAt.getTime()).toBe(first.endsAt.getTime());
    expect(after.notices).toHaveLength(1);
  });

  it('a registration whose code was not proved yet starts nothing', async () => {
    const { id, owner } = await business({ verified: false });
    expect(await start(id, owner)).toEqual({ started: false, reason: 'contact_unverified' });
    expect(await facts(id)).toEqual({ claims: [], notices: [], audits: 0, events: 0 });
  });

  it('a console-created business never receives it', async () => {
    const { id, owner } = await business({ trialEligible: false });
    expect(await start(id, owner)).toEqual({ started: false, reason: 'not_eligible' });
    expect((await facts(id)).claims).toHaveLength(0);
  });

  it('a paid, granted, refused or closed business never receives it', async () => {
    for (const data of [
      { status: 'activated' as const, currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) },
      { status: 'activated' as const, isComplimentary: true, complimentaryReason: 'spec', complimentaryUntil: new Date(Date.now() + 30 * 86_400_000) },
      { status: 'rejected' as const },
      { status: 'cancelled' as const },
    ]) {
      const { id, owner } = await business();
      await root.subscription.update({ where: { companyId: id }, data });
      expect(await start(id, owner)).toMatchObject({ started: false });
      expect((await facts(id)).claims).toHaveLength(0);
    }
  });

  it('a staff member is not the Owner: nothing starts', async () => {
    const { id } = await business();
    const other = await business();
    expect(await start(id, other.owner)).toEqual({ started: false, reason: 'not_owner' });
  });

  it('a verified number that already had a trial in another business never brings a second one', async () => {
    const first = await business();
    await start(first.id, first.owner);
    // The same number, registered again as a new business (its Owner identity released, as a deleted business's is).
    await root.ownerIdentity.deleteMany({ where: { companyId: first.id } });
    const again = await business({ phone: first.phone });
    expect(await start(again.id, again.owner)).toEqual({ started: false, reason: 'contact_used_trial' });
    expect((await facts(again.id)).claims).toHaveLength(0);
  });

  it('an eligible business that never claimed: started at the Owner’s next sign-in, from that instant — not its creation', async () => {
    const { id, owner } = await business();
    await root.company.update({ where: { id }, data: { createdAt: new Date(Date.now() - 20 * 86_400_000) } });
    const signIn = new Date();
    expect(await start(id, owner, 'sign_in', signIn)).toMatchObject({ started: true });
    const [claim] = (await facts(id)).claims;
    expect(claim.startedAt.getTime()).toBe(signIn.getTime());
  });

  it('its failed account-ready message is superseded, never sent again', async () => {
    const { id, owner } = await business();
    const sub = await root.subscription.findFirstOrThrow({ where: { companyId: id } });
    const legacy = await root.subscriptionNotice.create({
      data: { id: Buffer.from(randomUUID().replace(/-/g, ''), 'hex'), companyId: id, subscriptionId: sub.id, kind: 'portal_instructions', periodKey: 'eligibility:x', threshold: 'auto', dueAt: new Date(), state: 'failed', failureReason: 'no_recipient', language: 'fr', nextAttemptAt: new Date() },
    });
    await start(id, owner, 'sign_in');
    expect(await root.subscriptionNotice.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject({ state: 'superseded', cancelReason: 'automatic_trial' });
    // Idempotent: a second start changes nothing.
    await start(id, owner, 'sign_in');
    expect(await root.subscriptionNotice.count({ where: { companyId: id, kind: 'portal_instructions', state: 'superseded' } })).toBe(1);
  });

  it('an old link’s claim: told the trial is already active — same dates, no second trial (Build 5’s shape kept)', async () => {
    const { id, owner } = await business();
    await start(id, owner);
    const before = (await facts(id)).claims[0];
    const answer = await trials.claim({ companyId: id, userId: owner }, { idempotencyKey: randomUUID(), termsVersion: TRIAL_TERMS_VERSION } as never);
    expect(answer).toMatchObject({ claimed: true, replayed: true, alreadyActive: true, state: 'trial_active' });
    expect(answer.trial).toMatchObject({ status: 'active' });
    expect(Object.keys(answer).sort()).toEqual(['alreadyActive', 'claimed', 'replayed', 'state', 'subscriptionVersion', 'trial']);
    const after = await facts(id);
    expect(after.claims).toHaveLength(1);
    expect(after.claims[0].endsAt.getTime()).toBe(before.endsAt.getTime());
  });

  it('an old link before any automatic start still starts it once, as a claim did', async () => {
    const { id, owner } = await business();
    const answer = await trials.claim({ companyId: id, userId: owner }, { idempotencyKey: randomUUID(), termsVersion: TRIAL_TERMS_VERSION } as never);
    expect(answer).toMatchObject({ claimed: true, replayed: false });
    // Afterwards no automatic start adds another.
    expect(await start(id, owner, 'sign_in')).toEqual({ started: false, reason: 'already_started' });
  });

  describe('through the registration itself: the code proved, the session made — the trial with them', () => {
    /** The continuation with real MySQL and fakes only for what proves the code and signs the tokens. */
    function continuation(failSession = false) {
      const intents = {
        resolve: async (_t: string, _p: unknown) => current!,
        consume: async (_id: Buffer, fn: (tx: unknown) => Promise<Buffer>) => ({ ok: true as const, result: await root.$transaction((tx) => fn(tx)) }),
      };
      const verification = { confirmChallenge: async () => 'ok' };
      const sessions = { create: async () => { if (failSession) throw new Error('session insert failed'); return newUuidV7Bin(); } };
      const tokens = { generateRefreshSecret: () => 's', signAccessToken: () => ({ token: 'a', expiresIn: 900 }), buildRefreshToken: () => 'r' };
      const notices = { refresh: async () => undefined, deliverNow: async () => undefined };
      return new RegistrationContinuationService(db, intents as never, verification as never, sessions as never, tokens as never, null as never, undefined, audit, notices as never, { automaticTrial: true } as never);
    }
    let current: { ok: true; challengeId: Buffer; userId: Buffer; companyId: Buffer; intentId: Buffer } | null = null;
    async function pending() {
      const b = await business({ verified: false });
      const challengeId = newUuidV7Bin();
      await root.contactVerification.create({ data: { id: challengeId, channel: 'phone', destination: b.phone, codeHash: 'x', expiresAt: new Date(Date.now() + 600_000) } as never });
      current = { ok: true, challengeId, userId: b.owner, companyId: b.id, intentId: newUuidV7Bin() };
      return b;
    }

    it('registering (and asking for the code) starts nothing; proving it completes the registration with one 168-hour trial', async () => {
      const b = await pending();
      expect(await facts(b.id)).toEqual({ claims: [], notices: [], audits: 0, events: 0 });
      const done = await continuation().complete('token', '123456');
      expect(done).toMatchObject({ ok: true });
      const f = await facts(b.id);
      expect(f.claims).toHaveLength(1);
      expect(f.claims[0].endsAt.getTime() - f.claims[0].startedAt.getTime()).toBe(TRIAL_DURATION_MS);
      expect(f.notices).toHaveLength(1);
      expect(f.audits).toBe(1);
    });

    it('a completion that fails (the session not made) leaves no trial and the number unproved', async () => {
      const b = await pending();
      await expect(continuation(true).complete('token', '123456')).rejects.toThrow('session insert failed');
      expect(await facts(b.id)).toEqual({ claims: [], notices: [], audits: 0, events: 0 });
      expect((await root.user.findUniqueOrThrow({ where: { id: b.owner } })).phoneVerifiedAt).toBeNull();
    });
  });

  describe('the trial-started message', () => {
    let template = '';
    const sent: WhatsAppMessage[] = [];
    let script: DeliveryResult[] = [];
    const whatsapp = {
      name: 'cloud-api',
      isEnabled: true,
      send: async (m: WhatsAppMessage): Promise<DeliveryResult> => {
        sent.push(m);
        return script.shift() ?? ({ status: 'accepted', providerMessageId: `wamid.${sent.length}`, provider: 'cloud-api' } as DeliveryResult);
      },
    };
    const config = {
      portalLive: true,
      automaticTrial: true,
      portalSubscriptionUrl: 'https://dukan.tsxmr.com/subscription',
      whatsappTemplateName: (k: string) => (k === 'WHATSAPP_TEMPLATE_TRIAL_STARTED' ? template : ''),
    };
    const email = { name: 'disabled', isEnabled: false, send: async () => ({ status: 'failed', reason: 'unavailable', detail: 'off', provider: 'disabled' }) };
    const records = { contactState: async () => ({ consented: true, consent: 'active', optOutScope: 'none', undeliverableAt: null, pendingLive: false }) };
    const notices = url
      ? new NoticeService(db, config as never, entitlement as never, records as never, { hash: () => 'h'.repeat(64) } as never, whatsapp as never, email as never, { now: () => new Date() } as never)
      : (null as never);
    beforeEach(() => {
      sent.length = 0;
      script = [];
      template = '';
    });

    it('0132: each store has its own 3/2/1-day timeline, keyed by the store; a renewal supersedes what waited', async () => {
      const { id, owner } = await business();
      await start(id, owner);
      const second = newUuidV7Bin();
      await root.branch.create({ data: { id: second, companyId: id, name: 'Ksar', type: 'store' } });
      const ends = new Date(Date.now() + 47 * 3_600_000);
      await root.branchEntitlement.create({ data: { id: newUuidV7Bin(), companyId: id, branchId: second, paidUntil: ends } });
      await notices.refresh(id);
      const rows = await root.subscriptionNotice.findMany({ where: { companyId: id, kind: { in: ['paid_reminder', 'trial_reminder'] } } });
      // The first store's trial is 168 hours away: nothing yet. The second store's paid end is 47 hours away: its 48-hour reminder.
      expect(rows.map((r) => [r.kind, r.threshold, r.periodKey])).toEqual([['paid_reminder', 'h48', `s:${second.toString('hex')}:paid:${ends.getTime()}`]]);
      // Renewed: its end moves, and the reminder that waited is superseded, never sent.
      await root.branchEntitlement.update({ where: { branchId: second }, data: { paidUntil: new Date(ends.getTime() + 90 * 86_400_000) } });
      await notices.refresh(id);
      expect((await root.subscriptionNotice.findUniqueOrThrow({ where: { id: rows[0].id } })).state).toBe('superseded');
    });

    it('held without its template — no attempt spent — and the trial runs regardless', async () => {
      const { id, owner } = await business();
      await start(id, owner);
      const [notice] = (await facts(id)).notices;
      await notices.deliverOne(notice.id);
      expect(await root.subscriptionNotice.findUniqueOrThrow({ where: { id: notice.id } })).toMatchObject({ state: 'pending', whatsappOutcome: 'held_template', attempts: 0 });
      expect(sent).toHaveLength(0);
      expect((await facts(id)).claims).toHaveLength(1);
    });

    it('with its template: sent once, the business and the end in Nouakchott time, in the Owner’s language', async () => {
      const { id, owner } = await business();
      await start(id, owner);
      await root.company.update({ where: { id }, data: { name: 'Les   Oasis Shop' } });
      template = 'dukan_trial_started';
      const [notice] = (await facts(id)).notices;
      await notices.deliverOne(notice.id);
      expect(await notices.deliverOne(notice.id)).toBe(false);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ template: 'trial.started', language: 'fr' });
      expect(sent[0].variables.business).toBe('Les Oasis Shop');
      const ends = (await facts(id)).claims[0].endsAt;
      const day = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Nouakchott', day: 'numeric', month: 'long', year: 'numeric' }).format(ends);
      expect(sent[0].variables.ends).toContain(day);
    });

    it('a held notice released after its 24 hours is superseded, never sent late', async () => {
      const { id, owner } = await business();
      await start(id, owner);
      const [notice] = (await facts(id)).notices;
      await notices.deliverOne(notice.id); // held: template not set
      const claim = (await facts(id)).claims[0];
      await root.trialClaim.update({ where: { id: claim.id }, data: { claimedAt: new Date(claim.claimedAt.getTime() - 25 * 3_600_000), startedAt: new Date(claim.startedAt.getTime() - 25 * 3_600_000), endsAt: new Date(claim.endsAt.getTime() - 25 * 3_600_000) } });
      await root.subscriptionNotice.update({ where: { id: notice.id }, data: { nextAttemptAt: new Date(0) } });
      template = 'dukan_trial_started';
      await notices.deliverOne(notice.id);
      expect(await root.subscriptionNotice.findUniqueOrThrow({ where: { id: notice.id } })).toMatchObject({ state: 'superseded', cancelReason: 'trial_notice_late' });
      expect(sent).toHaveLength(0);
    });

    it('a notice whose trial has ended is superseded, never sent', async () => {
      const { id, owner } = await business();
      await start(id, owner);
      const claim = (await facts(id)).claims[0];
      await root.trialClaim.update({ where: { id: claim.id }, data: { claimedAt: new Date(claim.claimedAt.getTime() - 169 * 3_600_000), startedAt: new Date(claim.startedAt.getTime() - 169 * 3_600_000), endsAt: new Date(claim.endsAt.getTime() - 169 * 3_600_000) } });
      template = 'dukan_trial_started';
      const [notice] = (await facts(id)).notices;
      await notices.deliverOne(notice.id);
      expect(await root.subscriptionNotice.findUniqueOrThrow({ where: { id: notice.id } })).toMatchObject({ state: 'superseded', cancelReason: 'trial_not_running' });
      expect(sent).toHaveLength(0);
    });

    it('a failure changes nothing about the trial: retried, then failed with its reason — access and dates unchanged', async () => {
      const { id, owner } = await business();
      await start(id, owner);
      template = 'dukan_trial_started';
      const before = (await facts(id)).claims[0];
      script = [{ status: 'failed', reason: 'rejected', detail: 'refused', provider: 'cloud-api' } as DeliveryResult];
      const [notice] = (await facts(id)).notices;
      await notices.deliverOne(notice.id);
      expect((await root.subscriptionNotice.findUniqueOrThrow({ where: { id: notice.id } })).state).not.toBe('accepted');
      const after = (await facts(id)).claims[0];
      expect(after.endsAt.getTime()).toBe(before.endsAt.getTime());
    });
  });

  it('an additional branch never receives the trial: paid during it, it opens at once with its own period; the trial is unchanged', async () => {
    const { id, owner } = await business();
    await start(id, owner);
    const before = (await facts(id)).claims[0];
    const billing = new BillingService(db, { now: () => new Date() } as never);
    const allocations = new SeatAllocationService(db, audit, billing, { now: () => new Date() } as never, { record: async () => undefined } as never);
    const requests = new BranchRequestsService(db, allocations, { enqueueBranchActivation: async () => ({ created: true }) } as never);
    await requests.create(id, owner, { name: 'Ksar', requestKey: randomUUID() }, 'spec');
    const sub = await root.subscription.findFirstOrThrow({ where: { companyId: id } });
    const done = await root.$transaction((tx) =>
      activatePendingBranchesTx(tx as never, { companyId: id, subscriptionId: sub.id, paymentId: null, proofId: null, months: 3, actor: 'spec', reference: 'proof:spec', now: new Date(), branches: new BranchEntitlementService(db as never, { now: () => new Date() }) }),
    );
    expect(done).toMatchObject([{ outcome: 'opened', branchId: expect.any(String) }]);
    const own = await root.branchEntitlement.findUniqueOrThrow({ where: { branchId: uuidToBin(done[0].branchId) } });
    expect(own.trialEndsAt).toBeNull();
    expect(own.paidUntil).not.toBeNull();
    // The trial is the first store's alone.
    const first = await root.branchEntitlement.findMany({ where: { companyId: id, trialEndsAt: { not: null } } });
    expect(first).toHaveLength(1);
    expect(first[0].trialEndsAt!.getTime()).toBe(before.endsAt.getTime());
    const after = (await facts(id)).claims;
    expect(after).toHaveLength(1);
    expect(after[0].startedAt.getTime()).toBe(before.startedAt.getTime());
    expect(after[0].endsAt.getTime()).toBe(before.endsAt.getTime());
    expect(await root.branch.count({ where: { companyId: id } })).toBe(2);
  });
});
