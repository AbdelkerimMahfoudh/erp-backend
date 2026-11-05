import { PrismaClient } from '@prisma/client';
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
  const proofs = url ? new PaymentProofsService(db, lifecycle, audit, entitlement as never, { proofSubmitted: async () => ({ sent: 0 }) } as never) : (null as never);

  beforeAll(() => root.$executeRaw`INSERT INTO platform_admins (id, email, name, password_hash, updated_at) VALUES (${admin.id}, ${admin.email}, ${admin.name}, 'x', NOW(6))`);
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
    const made = await requests.create(id, owner, { name: '  Ksar   Centre ', location: ' Nouakchott ', requestKey: key() }, 'spec');
    expect(made).toMatchObject({ created: true, request: { name: 'Ksar Centre', location: 'Nouakchott', state: 'pending_activation', branchId: null } });
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
    await expect(requests.create(id, owner, { name: 'Ok', location: 'y'.repeat(161), requestKey: key() }, 'spec')).rejects.toMatchObject({ response: { code: 'branch_location_too_long' } });
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
    await requests.create(id, owner, { name: 'Ksar', location: 'Nouakchott', requestKey: key() }, 'spec');
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
    expect(await requests.list(id, owner)).toEqual([]);
    // The notice has nothing left to announce once the branch is active: the worker cancels it as not pending.
    // A repeated approval is the decision already made.
    await proofs.approve(proof.id, { amount: proof.amount, paidAt: new Date().toISOString(), months: 1, reason: 'again' }, ctx);
    expect((await facts(id)).branches).toBe(after.branches);
    expect(await root.platformAuditEvent.count({ where: { targetId: id, action: 'branch.activate' } })).toBe(1);
  });

  it('during the free trial: the new branch receives no trial — paid, it waits for the trial to end', async () => {
    const { uuid, id, owner } = await shop({ trial: true });
    const trial = (await facts(id)).claim;
    await requests.create(id, owner, { name: 'Port', requestKey: key() }, 'spec');
    expect(await facts(id)).toMatchObject({ branches: 1, claim: trial });
    const proof = await proofFor(uuid, id, owner);
    await proofs.approve(proof.id, { amount: proof.amount, paidAt: new Date().toISOString(), months: 1, reason: 'paid' }, ctx);
    const request = await root.seatAllocation.findFirstOrThrow({ where: { companyId: id, kind: 'store' } });
    expect(request.status).toBe('scheduled');
    expect(request.effectiveAt?.getTime()).toBe(trial!.endsAt.getTime());
    expect(request.branchId).toBeNull();
    expect(await facts(id)).toMatchObject({ branches: 1, claim: trial });
  });
});
