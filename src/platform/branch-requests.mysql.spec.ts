import { CLAIM_LINK_TTL_MS, ClaimLinkService } from '../notices/claim-links.service';
import { claimLanding } from './portal/portal-session.service';
import { PrismaClient } from '@prisma/client';
import { BranchEntitlementService } from '../entitlement/branch-entitlement.service';
import { randomUUID } from 'node:crypto';
import { BillingService } from '../billing/billing.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { HashingService } from '../common/security/hashing.service';
import { BranchRequestsService, normalizeBranchName } from './branch-requests.service';
import { PaymentProofsService } from './payment-proofs.service';
import { PlatformAuditService } from './platform-audit.service';
import { RegistrationService } from './registration.service';
import { SeatAllocationService } from './seat-allocation.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';

/**
 * A branch added in the app (0130; the owner's brief of 2026-11-05), through the real registration, lifecycle, billing,
 * store requests and payment proofs on real MySQL: created pending — no branch, no seat, no trial, nothing else changed —
 * by the Owner only, once whatever the retries; activated only by an approved payment, atomically with its period.
 */
const url = process.env.PROVISIONING_ROOT_URL;
const suite = url ? describe : describe.skip;
const clock = { now: () => new Date() };
const PNG = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(randomUUID())]);

describe('a branch name as it is compared', () => {
  it('trimmed, spaces collapsed, case and accents folded', () => {
    expect(normalizeBranchName('  Tevragh   Zeina ')).toBe('tevragh zeina');
    expect(normalizeBranchName('KSAR')).toBe(normalizeBranchName('ksar'));
    expect(normalizeBranchName('Sébkha')).toBe(normalizeBranchName('Sebkha'));
  });
});

suite('a branch added in the app', () => {
  const root = url ? new PrismaClient({ datasources: { db: { url } } }) : (null as unknown as PrismaClient);
  const db = root as never;
  const adminId = newUuidV7Bin();
  const admin = { id: adminId, email: `ops-${binToUuid(adminId).slice(-12)}@example.test`, name: 'Ops' };
  const ctx = { admin, ip: '127.0.0.1' } as never;
  // 0138: the second administrator — a different person — who confirms or refuses what the first opened.
  const admin2Id = newUuidV7Bin();
  const admin2 = { id: admin2Id, email: `ops2-${binToUuid(admin2Id).slice(-12)}@example.test`, name: 'Ops 2' };
  const ctx2 = { admin: admin2, ip: '127.0.0.1' } as never;
  const audit = url ? new PlatformAuditService(db) : (null as never);
  const billing = url ? new BillingService(db, clock as never) : (null as never);
  const lifecycle = url ? new SubscriptionLifecycleService(db, audit, billing, clock as never) : (null as never);
  const registration = url ? new RegistrationService(db, new HashingService(), clock as never) : (null as never);
  const allocations = url ? new SeatAllocationService(db, audit, billing, clock as never, ({ record: async () => undefined } as never)) : (null as never);
  const queued: string[] = [];
  // The outbox's own enqueue (real rows), without its delivery worker.
  const notices = {
    enqueueBranchActivation: async (companyId: Buffer, allocationId: Buffer) => {
      const sub = await root.subscription.findFirstOrThrow({ where: { companyId }, select: { id: true } });
      try {
        await root.subscriptionNotice.create({
          data: { id: newUuidV7Bin(), companyId, subscriptionId: sub.id, kind: 'branch_activation', periodKey: `branch:${allocationId.toString('hex')}`, threshold: 'activation', dueAt: new Date(), language: 'en', nextAttemptAt: new Date() },
        });
        queued.push(allocationId.toString('hex'));
        return { created: true };
      } catch {
        return { created: false };
      }
    },
  };
  const requests = url ? new BranchRequestsService(db, allocations, notices as never) : (null as never);
  const entitlement = { forCompany: async () => ({ seatsByStore: [] }) };
  const proofs = url ? new PaymentProofsService(db, lifecycle, audit, entitlement as never, { proofSubmitted: async () => ({ sent: 0 }) } as never, new BranchEntitlementService(db as never, { now: () => new Date() })) : (null as never);

  beforeAll(async () => {
    await root.$executeRaw`INSERT INTO platform_admins (id, email, name, password_hash, updated_at) VALUES (${admin.id}, ${admin.email}, ${admin.name}, 'x', NOW(6))`;
    await root.$executeRaw`INSERT INTO platform_admins (id, email, name, password_hash, updated_at) VALUES (${admin2.id}, ${admin2.email}, ${admin2.name}, 'x', NOW(6))`;
  });
  afterAll(() => root.$disconnect());

  let seq = 0;
  async function shop(opts: { trial?: boolean } = {}) {
    const key = randomUUID().replace(/-/g, '').slice(0, 10);
    const made = await registration.register({
      idempotencyKey: `spec:${key}`,
      ownerName: 'Owner',
      businessName: `Shop ${key}`,
      branchName: 'Main',
      phone: `+2224${(Date.now() + seq++).toString().slice(-7)}`,
      password: 'unusable-password-for-the-spec',
      language: 'en',
      actor: 'spec',
      ...(opts.trial ? { trialEligible: true } : {}),
    } as never);
    const id = uuidToBin(made.companyId);
    const owner = uuidToBin(made.ownerUserId);
    if (opts.trial) {
      const eligibility = await root.trialEligibility.findUniqueOrThrow({ where: { companyId: id } });
      const at = new Date(Date.now() - 60_000);
      await root.trialClaim.create({
        data: {
          id: newUuidV7Bin(), companyId: id, eligibilityId: eligibility.id, claimantUserId: owner, claimedAt: at, startedAt: at,
          endsAt: new Date(at.getTime() + 168 * 3_600_000), termsVersion: 'spec', idempotencyKey: `spec-${key}`, requestHash: '0'.repeat(64), subscriptionVersionAfter: 0,
        },
      });
    }
    return { uuid: made.companyId as string, id, owner };
  }
  async function manager(companyId: Buffer) {
    const user = newUuidV7Bin();
    const branch = await root.branch.findFirstOrThrow({ where: { companyId } });
    const role = await root.role.findFirstOrThrow({ where: { companyId, key: 'store_manager' } });
    await root.user.create({ data: { id: user, companyId, name: 'Manager', login: `m-${randomUUID().slice(0, 8)}`, personalId: randomUUID().replace(/-/g, '').slice(0, 8), passwordHash: 'x' } as never });
    await root.userBranch.create({ data: { id: newUuidV7Bin(), companyId, userId: user, branchId: branch.id, roleId: role.id } });
    return user;
  }
  const facts = async (id: Buffer) => ({
    branches: await root.branch.count({ where: { companyId: id } }),
    subscribed: (await root.subscription.findFirstOrThrow({ where: { companyId: id } })).subscribedBranchCount,
    seats: await root.seatAllocation.count({ where: { companyId: id, kind: 'seat' } }),
    claim: await root.trialClaim.findUnique({ where: { companyId: id }, select: { endsAt: true } }),
    staffOnNew: await root.userBranch.count({ where: { companyId: id, branch: { name: { not: 'Main' } } } }),
  });
  const key = () => randomUUID();

  it('the Owner adds one pending branch: no branch, no seat, no trial, nothing else changed — and one notice', async () => {
    const { id, owner } = await shop();
    const before = await facts(id);
    const made = await requests.create(id, owner, { name: '  Ksar   Centre ', address: ' Nouakchott ', requestKey: key() }, 'spec');
    expect(made).toMatchObject({ created: true, request: { name: 'Ksar Centre', address: 'Nouakchott', state: 'pending_activation', branchId: null } });
    expect(await facts(id)).toEqual(before);
    expect(await root.seatAllocation.findFirstOrThrow({ where: { companyId: id, kind: 'store' } })).toMatchObject({ status: 'pending_payment', location: 'Nouakchott' });
    expect(await root.subscriptionNotice.count({ where: { companyId: id, kind: 'branch_activation' } })).toBe(1);
    expect(await requests.list(id, owner)).toHaveLength(1);
  });

  it('a Manager is refused, and sees no pending branches', async () => {
    const { id } = await shop();
    const m = await manager(id);
    await expect(requests.create(id, m, { name: 'Other', requestKey: key() }, 'spec')).rejects.toMatchObject({ response: { code: 'owner_only' } });
    expect(await requests.list(id, m)).toEqual([]);
    expect(await root.seatAllocation.count({ where: { companyId: id, kind: 'store' } })).toBe(0);
  });

  it('an empty or overlong name, an overlong location and a missing key are refused', async () => {
    const { id, owner } = await shop();
    await expect(requests.create(id, owner, { name: '   ', requestKey: key() }, 'spec')).rejects.toMatchObject({ response: { code: 'branch_name_required' } });
    await expect(requests.create(id, owner, { name: 'x'.repeat(161), requestKey: key() }, 'spec')).rejects.toMatchObject({ response: { code: 'branch_name_too_long' } });
    await expect(requests.create(id, owner, { name: 'Ok', address: 'y'.repeat(161), requestKey: key() }, 'spec')).rejects.toMatchObject({ response: { code: 'branch_address_too_long' } });
    await expect(requests.create(id, owner, { name: 'Ok' }, 'spec')).rejects.toMatchObject({ response: { code: 'request_key_missing' } });
  });

  it('the same name as a branch or as a waiting request, however spaced or cased, is refused', async () => {
    const { id, owner } = await shop();
    await expect(requests.create(id, owner, { name: '  MAIN ', requestKey: key() }, 'spec')).rejects.toMatchObject({ response: { code: 'branch_name_in_use' } });
    await requests.create(id, owner, { name: 'Tevragh Zeina', requestKey: key() }, 'spec');
    await expect(requests.create(id, owner, { name: 'tevragh   zeina', requestKey: key() }, 'spec')).rejects.toMatchObject({ response: { code: 'branch_name_in_use' } });
    expect(await root.seatAllocation.count({ where: { companyId: id, kind: 'store' } })).toBe(1);
  });

  it('a double tap, a retry and a lost answer with the same key make one request and one notice', async () => {
    const { id, owner } = await shop();
    const k = key();
    const [a, b] = await Promise.all([
      requests.create(id, owner, { name: 'Sebkha', requestKey: k }, 'spec'),
      requests.create(id, owner, { name: 'Sebkha', requestKey: k }, 'spec'),
    ]);
    const again = await requests.create(id, owner, { name: 'Sebkha', requestKey: k }, 'spec');
    expect(new Set([a.request.id, b.request.id, again.request.id]).size).toBe(1);
    expect([a.created, b.created, again.created].filter(Boolean)).toHaveLength(1);
    expect(await root.seatAllocation.count({ where: { companyId: id, kind: 'store' } })).toBe(1);
    expect(await root.subscriptionNotice.count({ where: { companyId: id, kind: 'branch_activation' } })).toBe(1);
  });

  async function proofFor(uuid: string, id: Buffer, owner: Buffer) {
    void uuid;
    return proofs.submit(id, { buffer: PNG() }, { idempotencyKey: key(), months: 1, userId: owner });
  }

  it('0132: stores and prices cannot be manipulated — another business’s store, a duplicate, a withdrawn request are refused; the price is the server’s; a reused key with other contents is refused', async () => {
    const mine = await shop();
    const theirs = await shop();
    await requests.create(mine.id, mine.owner, { name: 'Ksar', requestKey: key() }, 'spec');
    await requests.create(mine.id, mine.owner, { name: 'Port', requestKey: key() }, 'spec');
    await requests.create(theirs.id, theirs.owner, { name: 'Atar', requestKey: key() }, 'spec');
    const [ksar, port] = await root.seatAllocation.findMany({ where: { companyId: mine.id, kind: 'store' }, orderBy: { requestedAt: 'asc' } });
    const foreign = await root.seatAllocation.findFirstOrThrow({ where: { companyId: theirs.id, kind: 'store' } });
    const send = (branches: string[], over: Record<string, unknown> = {}) =>
      proofs.submit(mine.id, { buffer: PNG() }, { idempotencyKey: key(), months: 3, branches, userId: mine.owner, ...over } as never);
    await expect(send([binToUuid(foreign.id)])).rejects.toMatchObject({ response: { code: 'branch_not_quotable' } });
    await expect(send([binToUuid(ksar.id), binToUuid(ksar.id)])).rejects.toMatchObject({ response: { code: 'branches_duplicate' } });
    await root.seatAllocation.update({ where: { id: port.id }, data: { status: 'released' } });
    await expect(send([binToUuid(port.id)])).rejects.toMatchObject({ response: { code: 'branch_not_quotable' } });
    expect(await root.paymentProof.count({ where: { companyId: mine.id } })).toBe(0);
    // The page's figure is never used: the amount is the server's quote for exactly the store chosen.
    const k = key();
    const file = PNG();
    const saved = await proofs.submit(mine.id, { buffer: file }, { idempotencyKey: k, months: 3, branches: [binToUuid(ksar.id)], amount: '1', userId: mine.owner } as never);
    const quoted = await proofs.quoteFor(mine.id, 3, [binToUuid(ksar.id)]);
    expect(Number(saved.amount)).toBe(quoted.total);
    expect(quoted.total).toBeGreaterThan(1);
    expect(saved.lines).toEqual([{ branchId: binToUuid(ksar.id), name: 'Ksar', amount: quoted.total, pending: true }]);
    // The same retry is the same proof; the same key with other contents is refused.
    expect((await proofs.submit(mine.id, { buffer: file }, { idempotencyKey: k, months: 3, branches: [binToUuid(ksar.id)], userId: mine.owner } as never)).id).toBe(saved.id);
    await expect(proofs.submit(mine.id, { buffer: file }, { idempotencyKey: k, months: 12, branches: [binToUuid(ksar.id)], userId: mine.owner } as never)).rejects.toMatchObject({ response: { code: 'proof_key_reused' } });
    await expect(proofs.submit(mine.id, { buffer: PNG() }, { idempotencyKey: k, months: 3, branches: [binToUuid(ksar.id)], userId: mine.owner } as never)).rejects.toMatchObject({ response: { code: 'proof_key_reused' } });
    expect(await root.paymentProof.count({ where: { companyId: mine.id } })).toBe(1);
  });

  it('a payment proof alone activates nothing; a refused proof leaves the branch pending', async () => {
    const { uuid, id, owner } = await shop();
    await requests.create(id, owner, { name: 'Ksar', requestKey: key() }, 'spec');
    const proof = await proofFor(uuid, id, owner);
    const [r] = await requests.list(id, owner);
    expect(r.state).toBe('proof_under_review');
    expect((await facts(id)).branches).toBe(1);
    await proofs.refuse(proof.id, 'blurred', ctx);
    expect((await requests.list(id, owner))[0].state).toBe('pending_activation');
    expect((await facts(id)).branches).toBe(1);
  });

  it('an approved proof opens the branch with its period, atomically, once — staff and seats untouched', async () => {
    const { uuid, id, owner } = await shop();
    await requests.create(id, owner, { name: 'Ksar', address: 'Nouakchott', requestKey: key() }, 'spec');
    const proof = await proofFor(uuid, id, owner);
    const before = await facts(id);
    await proofs.approve(proof.id, { amount: proof.amount, paidAt: new Date().toISOString(), months: 1, reason: 'paid by Bankily' }, ctx);
    const request = await root.seatAllocation.findFirstOrThrow({ where: { companyId: id, kind: 'store' } });
    expect(request.status).toBe('paid');
    expect(request.branchId).not.toBeNull();
    expect(request.paymentId).not.toBeNull();
    const branch = await root.branch.findUniqueOrThrow({ where: { id: request.branchId! } });
    expect(branch).toMatchObject({ name: 'Ksar', address: 'Nouakchott', isActive: true });
    const after = await facts(id);
    expect(after.branches).toBe(before.branches + 1);
    expect(after.subscribed).toBe(before.subscribed + 1);
    expect(after.seats).toBe(before.seats);
    expect(after.claim).toBeNull();
    expect((await root.subscription.findFirstOrThrow({ where: { companyId: id } })).status).toBe('activated');
    expect(await root.platformAuditEvent.count({ where: { targetId: id, action: 'branch.activate' } })).toBe(1);
    expect(await root.notification.count({ where: { companyId: id, type: 'branch.activated' } })).toBeGreaterThanOrEqual(1);
    // Recently activated: listed as active with the branch it became, for the app's setup checklist.
    expect(await requests.list(id, owner)).toMatchObject([{ state: 'active', branchId: expect.any(String) }]);
    // The notice has nothing left to announce once the branch is active: the worker cancels it as not pending.
    // A repeated approval is the decision already made.
    await proofs.approve(proof.id, { amount: proof.amount, paidAt: new Date().toISOString(), months: 1, reason: 'again' }, ctx);
    expect((await facts(id)).branches).toBe(after.branches);
    expect(await root.platformAuditEvent.count({ where: { targetId: id, action: 'branch.activate' } })).toBe(1);
  });

  it('during the free trial: the new branch receives no trial — paid, it opens at once with its own period (0132)', async () => {
    const { uuid, id, owner } = await shop({ trial: true });
    const trial = (await facts(id)).claim;
    await requests.create(id, owner, { name: 'Port', requestKey: key() }, 'spec');
    expect(await facts(id)).toMatchObject({ branches: 1, claim: trial });
    const proof = await proofFor(uuid, id, owner);
    const before = Date.now();
    await proofs.approve(proof.id, { amount: proof.amount, paidAt: new Date().toISOString(), months: 1, reason: 'paid' }, ctx);
    const request = await root.seatAllocation.findFirstOrThrow({ where: { companyId: id, kind: 'store' } });
    expect(request.status).toBe('paid');
    expect(request.branchId).not.toBeNull();
    const own = await root.branchEntitlement.findUniqueOrThrow({ where: { branchId: request.branchId! } });
    expect(own.trialEndsAt).toBeNull();
    // Its own month, from the approval — never from the trial's end.
    expect(own.paidUntil!.getTime()).toBeGreaterThan(before + 27 * 86_400_000);
    expect(own.paidUntil!.getTime()).toBeLessThan(trial!.endsAt.getTime() + 27 * 86_400_000);
    expect(await facts(id)).toMatchObject({ branches: 2, claim: trial });
  });

  it('0137: during an active trial, a store opens at its own approved payment on either path — the app’s proof or the portal’s request — with no trial, and its own month recorded', async () => {
    const { uuid, id, owner } = await shop({ trial: true });
    const trial = (await facts(id)).claim!;
    // The app's path: a branch added in the app, paid by a proof the platform approves.
    await requests.create(id, owner, { name: 'Port', requestKey: key() }, 'spec');
    const proof = await proofFor(uuid, id, owner);
    await proofs.approve(proof.id, { amount: proof.amount, paidAt: new Date().toISOString(), months: 1, reason: 'paid' }, ctx);
    // The portal's path: a store requested on the portal, its payment confirmed by the platform.
    const asked = await allocations.requestStore(id, { name: 'Ksar', activity: 'electronics', requestedBy: 'spec' });
    const before = Date.now();
    const confirmed = await allocations.confirmPayment(Buffer.from(asked.allocation.id.replace(/-/g, ''), 'hex'), { amount: '600', paidAt: new Date(), reference: 'BK-0137' }, ctx);
    expect(confirmed.allocation).toMatchObject({ status: 'paid', activation: null, branchName: 'Ksar' });

    const rows = await root.seatAllocation.findMany({ where: { companyId: id, kind: 'store' }, orderBy: { requestedAt: 'asc' } });
    expect(rows.map((r) => [r.label, r.status, r.branchId !== null])).toEqual([['Port', 'paid', true], ['Ksar', 'paid', true]]);
    for (const r of rows) {
      const own = await root.branchEntitlement.findUniqueOrThrow({ where: { branchId: r.branchId! } });
      expect(own.trialEndsAt).toBeNull();
      // Its own month, from its approval — never from the trial's end — and the same instant the billing reads.
      expect(own.paidUntil!.getTime()).toBeGreaterThan(before - 60_000 + 27 * 86_400_000);
      expect(own.paidUntil!.getTime()).toBeLessThan(trial.endsAt.getTime() + 27 * 86_400_000);
      expect(r.ownPaidUntil?.getTime()).toBe(own.paidUntil!.getTime());
    }
    expect(await root.seatAllocation.count({ where: { companyId: id, status: 'scheduled' } })).toBe(0);
    expect(await facts(id)).toMatchObject({ branches: 3, claim: trial });
  });


  // 0134 (owner, 2026-11-08): what a payment is for, priced from the one price list; only subscriptions and activations
  // extend access. A proof service whose entitlement knows the business's real Main store.
  async function mainStore(companyId: Buffer) {
    const b = await root.branch.findFirstOrThrow({ where: { companyId, type: 'store' } });
    const svc = new PaymentProofsService(db, lifecycle, audit, { forCompany: async () => ({ seatsByStore: [{ branchId: binToUuid(b.id), name: b.name, activity: 'electronics', paidSeats: 0 }] }) } as never, { proofSubmitted: async () => ({ sent: 0 }) } as never, new BranchEntitlementService(db as never, { now: () => new Date() }));
    return { branch: b, svc };
  }

  it('0134: each category is priced by the server — subscription 600/1 500/5 000, activation, 100 a seat a month, other with its note', async () => {
    const { id, owner } = await shop();
    const { branch, svc } = await mainStore(id);
    const main = binToUuid(branch.id);
    await requests.create(id, owner, { name: 'Ksar', requestKey: key() }, 'spec');
    expect((await svc.priceFor(id, { category: 'subscription', months: 1 }))!.total).toBe(600);
    expect((await svc.priceFor(id, { category: 'subscription', months: 3 }))!.total).toBe(1500);
    expect((await svc.priceFor(id, { category: 'subscription', months: 12 }))!.total).toBe(5000);
    expect((await svc.priceFor(id, { category: 'store_activation', months: 1 }))!.stores).toHaveLength(1);
    expect((await svc.priceFor(id, { category: 'extra_seats', months: 3, branches: [main], seats: 2 }))!.total).toBe(600);
    expect(await svc.priceFor(id, { category: 'other' })).toBeNull();
    await expect(svc.priceFor(id, { category: 'extra_seats', months: 1, branches: [main], seats: 0 })).rejects.toMatchObject({ response: { code: 'seats_invalid' } });
    await expect(svc.priceFor(id, { category: 'subscription', months: 2 as never })).rejects.toMatchObject({ response: { code: 'plan_invalid' } });
    // A subscription never names a waiting store, an activation never an open one.
    const ksar = await root.seatAllocation.findFirstOrThrow({ where: { companyId: id, kind: 'store' } });
    await expect(svc.priceFor(id, { category: 'subscription', months: 1, branches: [binToUuid(ksar.id)] })).rejects.toMatchObject({ response: { code: 'branch_not_quotable' } });
    await expect(svc.priceFor(id, { category: 'store_activation', months: 1, branches: [main] })).rejects.toMatchObject({ response: { code: 'branch_not_quotable' } });
    // Submitted: the server's amount and the category are stored, whatever the page sent.
    const seatsProof = await svc.submit(id, { buffer: PNG() }, { idempotencyKey: key(), category: 'extra_seats', months: 3, branches: [main], seats: 2, amount: '1', userId: owner } as never);
    expect(seatsProof).toMatchObject({ category: 'extra_seats', seats: 2, amount: '600' });
    await expect(svc.submit(id, { buffer: PNG() }, { idempotencyKey: key(), category: 'other', amount: '250', paidAt: new Date().toISOString(), userId: owner } as never)).rejects.toMatchObject({ response: { code: 'note_required' } });
  });

  it('0134: approving extra seats or an adjustment records the payment with its category — and extends no store', async () => {
    const { id, owner } = await shop();
    const { branch, svc } = await mainStore(id);
    const proof = await svc.submit(id, { buffer: PNG() }, { idempotencyKey: key(), category: 'extra_seats', months: 1, branches: [binToUuid(branch.id)], seats: 1, userId: owner } as never);
    const before = await root.branchEntitlement.findUnique({ where: { branchId: branch.id } });
    await svc.approve(proof.id, { amount: proof.amount, paidAt: new Date().toISOString(), months: 1, reason: 'seat paid' }, ctx);
    const payment = await root.subscriptionPayment.findFirstOrThrow({ where: { companyId: id, reference: 'proof:' + proof.id } });
    expect(payment.category).toBe('extra_seats');
    expect(payment.details).toMatchObject({ seats: 1, months: 1 });
    expect(await root.branchEntitlement.findUnique({ where: { branchId: branch.id } })).toEqual(before);
    expect(await root.branchPeriod.count({ where: { branchId: branch.id, paymentProofId: uuidToBin(proof.id) } })).toBe(0);
  });

  it('0134: an older proof without a category still extends access as before (subscription by its plan)', async () => {
    const { uuid, id, owner } = await shop();
    await requests.create(id, owner, { name: 'Ksar', requestKey: key() }, 'spec');
    const proof = await proofFor(uuid, id, owner);
    expect(proof.category).toBe('store_activation');
    await proofs.approve(proof.id, { amount: proof.amount, paidAt: new Date().toISOString(), months: 1, reason: 'paid' }, ctx);
    expect((await root.seatAllocation.findFirstOrThrow({ where: { companyId: id, kind: 'store' } })).status).toBe('paid');
  });

  // 0135 (owner, 2026-11-11): a waiting store paid from the portal with the number paid from and the screenshot; the Owner
  // corrects either until the decision; each correction raises the revision and a decision on an older one is refused.
  it('0135: the activation proof carries the payer number; the Owner corrects it; the latest revision is the one decided', async () => {
    const { id, owner } = await shop();
    await requests.create(id, owner, { name: 'Ksar', requestKey: key() }, 'spec');
    const ksar = await root.seatAllocation.findFirstOrThrow({ where: { companyId: id, kind: 'store' } });
    const first = await proofs.submit(id, { buffer: PNG() }, { idempotencyKey: key(), category: 'store_activation', months: 1, branches: [binToUuid(ksar.id)], payerPhone: ' +222 36 00 00 01 ', userId: owner } as never);
    expect(first).toMatchObject({ status: 'submitted', category: 'store_activation', amount: '600', payerPhone: '+22236000001', revision: 1, revisedAt: null });
    await expect(proofs.submit(id, { buffer: PNG() }, { idempotencyKey: key(), category: 'store_activation', months: 1, payerPhone: 'abc', userId: owner } as never)).rejects.toMatchObject({ response: { code: 'payer_phone_invalid' } });

    // The administrator opens revision 1; the Owner then corrects the number and the screenshot.
    await proofs.review(first.id, ctx);
    const fixed = await proofs.correct(id, first.id, { buffer: PNG() }, { payerPhone: '36000002', revision: 1, userId: owner });
    expect(fixed).toMatchObject({ payerPhone: '36000002', revision: 2, status: 'under_review' });
    expect(fixed.revisedAt).not.toBeNull();
    // A correction based on what the Owner saw before is refused, as is one that changes nothing.
    await expect(proofs.correct(id, first.id, undefined, { payerPhone: '36000003', revision: 1, userId: owner })).rejects.toMatchObject({ response: { code: 'proof_revised' } });
    await expect(proofs.correct(id, first.id, undefined, { userId: owner })).rejects.toMatchObject({ response: { code: 'proof_nothing' } });

    // An approval or a refusal made on revision 1 is refused; nothing is recorded.
    await expect(proofs.approve(first.id, { amount: '600', paidAt: new Date().toISOString(), months: 1, reason: 'paid', revision: 1 }, ctx)).rejects.toMatchObject({ response: { code: 'proof_revised', revision: 2 } });
    await expect(proofs.refuse(first.id, 'wrong file', ctx, 1)).rejects.toMatchObject({ response: { code: 'proof_revised' } });
    expect(await root.subscriptionPayment.count({ where: { companyId: id, reference: 'proof:' + first.id } })).toBe(0);
    expect((await root.seatAllocation.findUniqueOrThrow({ where: { id: ksar.id } })).status).toBe('pending_payment');

    // On revision 2: approved once; a retry answers with the same approval, and no correction is accepted any more.
    const opened = await proofs.approve(first.id, { amount: '600', paidAt: new Date().toISOString(), months: 1, reason: 'paid', revision: 2 }, ctx);
    expect(opened).toMatchObject({ status: 'under_review', revision: 2, review: { openedRevision: 2 } });
    expect(await proofs.approve(first.id, { amount: '600', paidAt: new Date().toISOString(), months: 1, reason: 'paid', revision: 2 }, ctx)).toMatchObject({ status: 'under_review' });
    const approved = await proofs.confirm(first.id, { revision: 2 }, ctx2);
    expect(approved).toMatchObject({ status: 'approved', revision: 2 });
    expect(await root.subscriptionPayment.count({ where: { companyId: id, reference: 'proof:' + first.id } })).toBe(1);
    expect((await root.seatAllocation.findUniqueOrThrow({ where: { id: ksar.id } })).status).toBe('paid');
    await expect(proofs.correct(id, first.id, undefined, { payerPhone: '36000004', userId: owner })).rejects.toMatchObject({ response: { code: 'proof_decided' } });
  });

  it('0135: another business can neither read nor correct a proof; a refused proof stays refused on a retry', async () => {
    const a = await shop();
    const b = await shop();
    await requests.create(a.id, a.owner, { name: 'Ksar', requestKey: key() }, 'spec');
    const proof = await proofs.submit(a.id, { buffer: PNG() }, { idempotencyKey: key(), category: 'store_activation', months: 1, payerPhone: '36000005', userId: a.owner } as never);
    await expect(proofs.correct(b.id, proof.id, undefined, { payerPhone: '36000006', userId: b.owner })).rejects.toMatchObject({ status: 404 });
    expect((await proofs.listForCompany(b.id)).map((x: { id: string }) => x.id)).not.toContain(proof.id);
    expect((await root.paymentProof.findUniqueOrThrow({ where: { id: uuidToBin(proof.id) } })).payerPhone).toBe('36000005');
    await proofs.refuse(proof.id, 'unreadable', ctx, 1);
    await expect(proofs.refuse(proof.id, 'unreadable', ctx, 1)).rejects.toMatchObject({ response: { code: 'proof_decided' } });
    await expect(proofs.correct(a.id, proof.id, undefined, { payerPhone: '36000007', userId: a.owner })).rejects.toMatchObject({ response: { code: 'proof_decided' } });
  });

  it('0135: the activation message link signs in once, lands on that waiting store, expires after 72 hours', async () => {
    const links = new ClaimLinkService(db);
    const { id, owner } = await shop();
    await requests.create(id, owner, { name: 'Ksar', requestKey: key() }, 'spec');
    const ksar = await root.seatAllocation.findFirstOrThrow({ where: { companyId: id, kind: 'store' } });
    const notice = await root.subscriptionNotice.findFirstOrThrow({ where: { companyId: id, kind: 'branch_activation' } });
    const { token, expiresAt } = await links.issue({ companyId: id, userId: owner, noticeId: notice.id });
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(CLAIM_LINK_TTL_MS - 60_000);
    expect(CLAIM_LINK_TTL_MS).toBe(72 * 3_600_000);
    // Redeemed: the landing is that store; a second use is refused.
    const first = await links.redeem(token, (tx, link) => claimLanding(tx, link));
    expect(first).toEqual({ ok: true, result: { id: binToUuid(ksar.id), kind: 'store' } });
    await expect(links.redeem(token, (tx, link) => claimLanding(tx, link))).resolves.toEqual({ ok: false, reason: 'used' });
    // Issued 72 hours ago and a second: expired, never opened.
    const old = await links.issue({ companyId: id, userId: owner, noticeId: notice.id }, new Date(Date.now() - CLAIM_LINK_TTL_MS - 1000));
    await expect(links.redeem(old.token, (tx, link) => claimLanding(tx, link))).resolves.toEqual({ ok: false, reason: 'expired' });
    // Another business's notice named on a link lands nowhere (the subscription page).
    const other = await shop();
    await root.$transaction(async (tx) => expect(await claimLanding(tx, { companyId: other.id, noticeId: notice.id })).toBeNull());
    // A link with no notice (the welcome message) lands on the subscription page.
    await root.$transaction(async (tx) => expect(await claimLanding(tx, { companyId: id, noticeId: null })).toBeNull());
  });

  // 0136 (owner, 2026-11-11): a proof downloads under a usable name and its true type, to its Owner or an administrator only.
  it('0136: image, PDF, unknown bytes, a replacement, and another business — each proof served as what it is, to whom it belongs', async () => {
    const a = await shop();
    const b = await shop();
    await requests.create(a.id, a.owner, { name: 'Ksar', requestKey: key() }, 'spec');
    const png = PNG();
    const sent = await proofs.submit(a.id, { buffer: png, originalname: 'C:\\phone\\Screenshot 06.43.PNG' }, { idempotencyKey: key(), category: 'store_activation', months: 1, payerPhone: '36000008', userId: a.owner } as never);
    expect(sent).toMatchObject({ contentType: 'image/png', fileName: 'Screenshot 06.43.png' });
    // The administrator and the Owner get the same bytes, type and name; another business gets nothing.
    const asAdmin = await proofs.file(sent.id, ctx);
    expect(asAdmin).toMatchObject({ contentType: 'image/png', fileName: 'Screenshot 06.43.png', revision: 1, known: true });
    expect(asAdmin.file.equals(png)).toBe(true);
    expect(await proofs.fileForOwner(a.id, sent.id)).toMatchObject({ contentType: 'image/png', fileName: 'Screenshot 06.43.png' });
    await expect(proofs.fileForOwner(b.id, sent.id)).rejects.toMatchObject({ status: 404 });
    await expect(proofs.fileForOwner(a.id, 'not-an-id')).rejects.toMatchObject({ status: 404 });

    // Replaced by a PDF: the new bytes, type, name and revision are what is served — the administrator sees the latest.
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from(randomUUID())]);
    await proofs.correct(a.id, sent.id, { buffer: pdf, originalname: 'reçu final.pdf' }, { revision: 1, userId: a.owner });
    const latest = await proofs.file(sent.id, ctx);
    expect(latest).toMatchObject({ contentType: 'application/pdf', fileName: 'reçu final.pdf', revision: 2 });
    expect(latest.file.equals(pdf)).toBe(true);

    // A proof stored before 0136 (no name) is named from its date and type; bytes of no known type download as .bin.
    await root.paymentProof.update({ where: { id: uuidToBin(sent.id) }, data: { fileName: null } });
    expect((await proofs.file(sent.id, ctx)).fileName).toMatch(/^payment-proof-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.pdf$/);
    await root.paymentProof.update({ where: { id: uuidToBin(sent.id) }, data: { file: Buffer.from('GIF89a-not-a-proof') } });
    expect(await proofs.file(sent.id, ctx)).toMatchObject({ contentType: 'application/octet-stream', known: false });
    expect((await proofs.file(sent.id, ctx)).fileName).toMatch(/\.bin$/);
  });

  // ── 0138 (owner, 2026-11-12): where the money was sent, and a two-person review ─────────────────────────────

  it('0138: the receiver is one the server offers — recorded, normalised, refused when the number does not take that service; a correction may change it', async () => {
    const { id, owner } = await shop();
    const { svc } = await mainStore(id);
    await expect(svc.submit(id, { buffer: PNG() }, { idempotencyKey: key(), months: 1, receiveService: 'sedad', receiveNumber: '12345678', userId: owner } as never)).rejects.toMatchObject({ response: { code: 'receiver_invalid' } });
    await expect(svc.submit(id, { buffer: PNG() }, { idempotencyKey: key(), months: 1, receiveService: 'masrivi', receiveNumber: '36963839', userId: owner } as never)).rejects.toMatchObject({ response: { code: 'receiver_invalid' } });
    const sent = await svc.submit(id, { buffer: PNG() }, { idempotencyKey: key(), months: 1, receiveService: 'Sedad', receiveNumber: '+222 37 67 68 27', userId: owner } as never);
    expect(sent).toMatchObject({ receiveService: 'sedad', receiveNumber: '37676827' });
    const fixed = await svc.correct(id, sent.id, undefined, { receiveService: 'bankily', receiveNumber: '36963839', revision: 1, userId: owner });
    expect(fixed).toMatchObject({ receiveService: 'bankily', receiveNumber: '36963839', revision: 2 });
    expect((await svc.listForAdmin()).find((p) => p.id === sent.id)).toMatchObject({ receiveService: 'bankily', receiveNumber: '36963839', revision: 2 });
  });

  it('0138: two administrators — the first opens the access; the same person cannot confirm or refuse; a different one confirms the deposit', async () => {
    const { uuid, id, owner } = await shop();
    const { svc } = await mainStore(id);
    const main = await root.branch.findFirstOrThrow({ where: { companyId: id, type: 'store' } });
    const proof = await svc.submit(id, { buffer: PNG() }, { idempotencyKey: key(), months: 1, userId: owner });
    const opened = await svc.approve(proof.id, { amount: proof.amount, paidAt: new Date().toISOString(), months: 1, reason: 'first look', revision: 1 }, ctx);
    expect(opened).toMatchObject({ status: 'under_review', review: { openedBy: admin.email, openedRevision: 1, confirmedBy: null, overdue: false } });
    expect((await root.branchEntitlement.findUniqueOrThrow({ where: { branchId: main.id } })).paidUntil!.getTime()).toBeGreaterThan(Date.now() + 27 * 86_400_000);
    expect(await root.subscriptionPayment.findFirstOrThrow({ where: { companyId: id, reference: `proof:${proof.id}` } })).toMatchObject({ confirmedAt: null });
    expect((await svc.listForCompany(id)).find((p) => p.id === proof.id)).toMatchObject({ status: 'under_review' });
    // Opened once: no second grant from the same proof; the Owner cannot correct it now.
    await svc.approve(proof.id, { amount: proof.amount, paidAt: new Date().toISOString(), months: 1, reason: 'again', revision: 1 }, ctx2);
    expect(await root.branchPeriod.count({ where: { companyId: id, paymentProofId: uuidToBin(proof.id) } })).toBe(1);
    await expect(svc.correct(id, proof.id, undefined, { payerPhone: '36000001', userId: owner })).rejects.toMatchObject({ response: { code: 'proof_decided' } });
    await expect(svc.confirm(proof.id, { revision: 1 }, ctx)).rejects.toMatchObject({ response: { code: 'second_admin_required' } });
    await expect(svc.refuse(proof.id, 'mine', ctx, 1)).rejects.toMatchObject({ response: { code: 'second_admin_required' } });
    expect(await svc.confirm(proof.id, { revision: 1, reason: 'seen on the Bankily account' }, ctx2)).toMatchObject({ status: 'approved', review: { confirmedBy: admin2.email } });
    expect(await root.subscriptionPayment.findFirstOrThrow({ where: { companyId: id, reference: `proof:${proof.id}` } })).toMatchObject({ confirmedBy: admin2.email });
  });

  it('0138: refused after it was opened — only what this proof added is taken back; access paid before stays; the Owner is told; nothing is erased', async () => {
    const { uuid, id, owner } = await shop();
    const { svc } = await mainStore(id);
    const main = await root.branch.findFirstOrThrow({ where: { companyId: id, type: 'store' } });
    const paid = await svc.submit(id, { buffer: PNG() }, { idempotencyKey: key(), months: 1, userId: owner });
    await svc.approve(paid.id, { amount: paid.amount, paidAt: new Date().toISOString(), months: 1, reason: 'paid', revision: 1 }, ctx);
    await svc.confirm(paid.id, { revision: 1 }, ctx2);
    const paidUntil = (await root.branchEntitlement.findUniqueOrThrow({ where: { branchId: main.id } })).paidUntil!;
    const periodEnd = (await root.subscription.findFirstOrThrow({ where: { companyId: id } })).currentPeriodEnd;
    await requests.create(id, owner, { name: 'Port', requestKey: key() }, 'spec');
    const second = await svc.submit(id, { buffer: PNG() }, { idempotencyKey: key(), months: 1, userId: owner });
    await svc.approve(second.id, { amount: second.amount, paidAt: new Date().toISOString(), months: 1, reason: 'looks right', revision: 1 }, ctx);
    const port = await root.branch.findFirstOrThrow({ where: { companyId: id, name: 'Port' } });
    expect(port.isActive).toBe(true);
    expect((await root.branchEntitlement.findUniqueOrThrow({ where: { branchId: main.id } })).paidUntil!.getTime()).toBeGreaterThan(paidUntil.getTime());

    const refused = await svc.refuse(second.id, 'No deposit on 36963839', ctx2, 1);
    expect(refused).toMatchObject({ status: 'refused', refusalReason: 'No deposit on 36963839' });
    expect((await root.branchEntitlement.findUniqueOrThrow({ where: { branchId: main.id } })).paidUntil!.getTime()).toBe(paidUntil.getTime());
    expect((await root.subscription.findFirstOrThrow({ where: { companyId: id } })).currentPeriodEnd?.getTime()).toBe(periodEnd?.getTime());
    expect(await root.branch.findUniqueOrThrow({ where: { id: port.id } })).toMatchObject({ isActive: false, name: 'Port' });
    expect(await root.subscriptionPayment.findFirstOrThrow({ where: { companyId: id, reference: `proof:${second.id}` } })).toMatchObject({ confirmedAt: null, note: 'Not verified: No deposit on 36963839' });
    expect(await root.subscriptionPayment.findFirstOrThrow({ where: { companyId: id, reference: `proof:${paid.id}` } })).toMatchObject({ confirmedBy: admin2.email });
    expect(await root.notification.count({ where: { companyId: id, type: 'payment.refused', targetUserId: owner } })).toBe(1);
    expect(await root.platformAuditEvent.count({ where: { targetId: id, action: 'payment_proof.refuse' } })).toBe(1);
    await expect(svc.refuse(second.id, 'again', ctx2, 1)).rejects.toMatchObject({ response: { code: 'proof_decided' } });
  });
});
