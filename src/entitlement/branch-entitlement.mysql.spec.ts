import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { HashingService } from '../common/security/hashing.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { RegistrationService } from '../platform/registration.service';
import { BranchEntitlementService, startBranchTrialTx } from './branch-entitlement.service';
import { addMonths } from './branch-rules';
import { GRACE_MS } from './grace-rules';
import { namedBranches } from './entitlement.interceptor';

/**
 * Per-branch entitlements (0132; docs/122) on real MySQL: several stores of one business in mixed states — the first on
 * its trial, a second waiting, a second paid at once, one ended while another runs, renewal, grace, a branch of another
 * business refused, and a retried approval.
 */
const url = process.env.PROVISIONING_ROOT_URL;
const suite = url ? describe : describe.skip;

suite('per-branch entitlements', () => {
  const root = url ? new PrismaClient({ datasources: { db: { url } } }) : (null as unknown as PrismaClient);
  const db = root as never;
  let now = new Date();
  const clock = { now: () => now };
  const registration = url ? new RegistrationService(db, new HashingService(), clock as never) : (null as never);
  const branches = url ? new BranchEntitlementService(db, clock) : (null as never);
  afterAll(() => root?.$disconnect());
  beforeEach(() => {
    now = new Date();
  });

  let seq = 0;
  async function business() {
    const key = randomUUID().replace(/-/g, '').slice(0, 10);
    const made = await registration.register({
      idempotencyKey: `spec:${key}`, ownerName: 'Owner', businessName: `Shop ${key}`, branchName: 'Main',
      phone: `+2225${(Date.now() + seq++).toString().slice(-7)}`, password: 'unusable-password-for-the-spec', language: 'en', actor: 'spec', trialEligible: true,
    } as never);
    const id = uuidToBin(made.companyId);
    const first = (await root.branch.findFirstOrThrow({ where: { companyId: id, type: 'store' } })).id;
    return { id, first };
  }
  async function store(companyId: Buffer, name: string) {
    const id = newUuidV7Bin();
    await root.branch.create({ data: { id, companyId, name, type: 'store' } });
    return id;
  }
  const trial = (companyId: Buffer, from = now) =>
    root.$transaction((tx) => startBranchTrialTx(tx, { companyId, startedAt: from, endsAt: new Date(from.getTime() + 168 * 3_600_000), actor: 'spec' }));
  const pay = (companyId: Buffer, branchId: Buffer, months: number, proofId: Buffer | null = newUuidV7Bin()) =>
    root.$transaction((tx) => branches.applyPaidTx(tx, { companyId, branchId, months, amount: 600 * months, paymentId: null, proofId, actor: 'spec', now }));
  const state = async (companyId: Buffer, branchId: Buffer) => (await branches.stateOf(companyId, branchId))?.state;

  it('the first branch on its trial; a second, never paid, is locked and cannot write', async () => {
    const { id, first } = await business();
    await trial(id);
    const second = await store(id, 'Ksar');
    expect(await state(id, first)).toBe('trial_active');
    expect(await state(id, second)).toBe('locked');
    expect(await branches.writeRefusal(id, first)).toBeNull();
    expect(await branches.writeRefusal(id, second)).toMatchObject({ code: 'BRANCH_LOCKED', state: 'locked' });
    expect(await branches.readRefusal(id, second)).toMatchObject({ state: 'locked' });
    // The business can still change business-wide things: its first store writes.
    expect(await branches.anyWritable(id)).toBe(true);
  });

  it('a second branch paid during the trial opens at once with its own months; the trial is untouched', async () => {
    const { id, first } = await business();
    await trial(id);
    const trialEnd = (await root.branchEntitlement.findUniqueOrThrow({ where: { branchId: first } })).trialEndsAt!;
    const second = await store(id, 'Port');
    const period = await pay(id, second, 3);
    expect(period.applied).toBe(true);
    expect(period.startsAt.getTime()).toBe(now.getTime());
    expect(period.endsAt.getTime()).toBe(addMonths(now, 3).getTime());
    expect(await state(id, second)).toBe('active');
    const own = await root.branchEntitlement.findUniqueOrThrow({ where: { branchId: second } });
    expect(own.trialEndsAt).toBeNull();
    expect((await root.branchEntitlement.findUniqueOrThrow({ where: { branchId: first } })).trialEndsAt!.getTime()).toBe(trialEnd.getTime());
    expect(await root.branchPeriod.count({ where: { branchId: second, source: 'trial' } })).toBe(0);
  });

  it('one branch ends while another runs: each decides for itself', async () => {
    const { id, first } = await business();
    await trial(id, new Date(now.getTime() - 200 * 3_600_000));
    const second = await store(id, 'Sebkha');
    await pay(id, second, 1);
    expect(await state(id, first)).toBe('trial_expired');
    expect(await state(id, second)).toBe('active');
    expect(await branches.writeRefusal(id, first)).toMatchObject({ code: 'BRANCH_ENTITLEMENT_WRITE_BLOCKED', state: 'trial_expired' });
    // An ended branch still reads: expiry never hides anything.
    expect(await branches.readRefusal(id, first)).toBeNull();
    expect(await branches.writeRefusal(id, second)).toBeNull();
    const list = await branches.listForCompany(id);
    expect(list.map((b) => [b.name, b.state])).toEqual([
      ['Main', 'trial_expired'],
      ['Sebkha', 'active'],
    ]);
  });

  it('a first branch paid during its trial goes on from the trial’s end', async () => {
    const { id, first } = await business();
    await trial(id);
    const trialEnd = (await root.branchEntitlement.findUniqueOrThrow({ where: { branchId: first } })).trialEndsAt!;
    const period = await pay(id, first, 1);
    expect(period.startsAt.getTime()).toBe(trialEnd.getTime());
    expect(period.endsAt.getTime()).toBe(addMonths(trialEnd, 1).getTime());
    expect(await state(id, first)).toBe('trial_active');
  });

  it('renewal: from the paid end while active or in grace; from the approval once ended', async () => {
    const { id } = await business();
    const a = await store(id, 'A');
    const b = await store(id, 'B');
    const c = await store(id, 'C');
    const firstEnd = (await pay(id, a, 1)).endsAt;
    // Active: extends from its end.
    const renewed = await pay(id, a, 3);
    expect(renewed.startsAt.getTime()).toBe(firstEnd.getTime());
    expect(renewed.endsAt.getTime()).toBe(addMonths(firstEnd, 3).getTime());
    // In grace: from its end, too.
    const bEnd = (await pay(id, b, 1)).endsAt;
    now = new Date(bEnd.getTime() + 3_600_000);
    expect(await state(id, b)).toBe('grace');
    const fromGrace = await pay(id, b, 1);
    expect(fromGrace.startsAt.getTime()).toBe(bEnd.getTime());
    // Ended (past its grace): from the approval.
    const cEnd = (await pay(id, c, 1)).endsAt;
    now = new Date(cEnd.getTime() + GRACE_MS + 3_600_000);
    expect(await state(id, c)).toBe('expired');
    const fromNow = await pay(id, c, 12);
    expect(fromNow.startsAt.getTime()).toBe(now.getTime());
    expect(fromNow.endsAt.getTime()).toBe(addMonths(now, 12).getTime());
  });

  it('grace: 72 hours per branch, recorded once; the fourth in 12 months is refused — on that branch only', async () => {
    const { id } = await business();
    const a = await store(id, 'A');
    const other = await store(id, 'Other');
    await pay(id, other, 12);
    const start = now;
    for (let i = 0; i < 3; i++) {
      const end = (await pay(id, a, 1)).endsAt;
      now = new Date(end.getTime() + 60_000);
      expect(await state(id, a)).toBe('grace');
      expect(await root.branchGraceEpisode.count({ where: { branchId: a, decision: 'granted' } })).toBe(i + 1);
      now = new Date(end.getTime() + GRACE_MS + 60_000);
      expect(await state(id, a)).toBe('expired');
    }
    const end = (await pay(id, a, 1)).endsAt;
    now = new Date(end.getTime() + 60_000);
    expect(now.getTime() - start.getTime()).toBeLessThan(365 * 86_400_000);
    expect(await state(id, a)).toBe('expired');
    expect(await root.branchGraceEpisode.findUniqueOrThrow({ where: { branchId_periodEnd: { branchId: a, periodEnd: end } } })).toMatchObject({ decision: 'refused' });
    // The other store's allowance is its own.
    expect(await root.branchGraceEpisode.count({ where: { branchId: other } })).toBe(0);
  });

  it('a branch of another business is refused, whatever its state — an id changed by hand reaches nothing', async () => {
    const mine = await business();
    const theirs = await business();
    await trial(theirs.id);
    expect(await state(theirs.id, theirs.first)).toBe('trial_active');
    expect(await branches.stateOf(mine.id, theirs.first)).toBeNull();
    expect(await branches.writeRefusal(mine.id, theirs.first)).toMatchObject({ code: 'BRANCH_LOCKED' });
    // The ids a request names are all checked, in the path and the body alike.
    const named = namedBranches({ params: { branchId: binToUuid(theirs.first) }, body: { toBranchId: binToUuid(mine.first), note: 'x' } });
    expect(named.map(binToUuid).sort()).toEqual([binToUuid(theirs.first), binToUuid(mine.first)].sort());
  });

  it('a retried approval extends a branch once', async () => {
    const { id } = await business();
    const a = await store(id, 'A');
    const proof = newUuidV7Bin();
    const once = await pay(id, a, 3, proof);
    const again = await pay(id, a, 3, proof);
    expect(again.applied).toBe(false);
    expect(again.endsAt.getTime()).toBe(once.endsAt.getTime());
    expect(await root.branchPeriod.count({ where: { branchId: a, source: 'payment' } })).toBe(1);
    expect((await root.branchEntitlement.findUniqueOrThrow({ where: { branchId: a } })).paidUntil!.getTime()).toBe(once.endsAt.getTime());
  });

  it('a suspended business stops every branch, paid or not', async () => {
    const { id, first } = await business();
    await pay(id, first, 12);
    await root.subscription.update({ where: { companyId: id }, data: { status: 'suspended' } });
    expect(await state(id, first)).toBe('suspended');
    expect(await branches.readRefusal(id, first)).toMatchObject({ state: 'suspended' });
    expect(await branches.anyWritable(id)).toBe(false);
  });
});
