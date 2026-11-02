import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { BillingService } from '../billing/billing.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { HashingService } from '../common/security/hashing.service';
import { UsersService } from '../users/users.service';
import { PaymentProofsService, RECOVERY_AFTER_MS } from './payment-proofs.service';
import { PlatformAuditService } from './platform-audit.service';
import { finishDraft } from './provisioning-draft';
import { RegistrationService } from './registration.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';

/**
 * The two correctness gaps closed in D227, through the real lifecycle on real MySQL: a committed decision always has its
 * trail and audit, and an approval that stopped part-way is read and settled, never retried blind.
 */
const url = process.env.PROVISIONING_ROOT_URL;
const suite = url ? describe : describe.skip;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const clock = { now: () => new Date() };

suite('committed decisions and stopped approvals', () => {
  const root = url ? new PrismaClient({ datasources: { db: { url } } }) : (null as unknown as PrismaClient);
  const adminId = newUuidV7Bin();
  const admin = { id: adminId, email: `ops-${binToUuid(adminId).slice(-12)}@example.test`, name: 'Ops' };
  const ctx = { admin, ip: '127.0.0.1' } as never;
  let failAudit: string | null = null;

  class Audit extends PlatformAuditService {
    async record(input: Parameters<PlatformAuditService['record']>[0], db?: Parameters<PlatformAuditService['record']>[1]) {
      if (failAudit === input.action) {
        failAudit = null;
        throw new Error('audit down');
      }
      return super.record(input, db);
    }
  }
  const db = root as never;
  const audit = url ? new Audit(db) : (null as never);
  const lifecycle = url ? new SubscriptionLifecycleService(db, audit, new BillingService(db, clock as never), clock as never) : (null as never);
  const registration = url ? new RegistrationService(db, new HashingService(), clock as never) : (null as never);
  const proofs = url ? new PaymentProofsService(db, lifecycle, audit) : (null as never);

  beforeAll(() => root.$executeRaw`INSERT INTO platform_admins (id, email, name, password_hash, updated_at) VALUES (${admin.id}, ${admin.email}, ${admin.name}, 'x', NOW(6))`);
  afterAll(() => root.$disconnect());
  afterEach(() => {
    failAudit = null;
    jest.restoreAllMocks();
  });

  let seq = 0;
  async function shop(draft?: Record<string, unknown>) {
    const key = randomUUID().replace(/-/g, '').slice(0, 10);
    const phone = `+2224${(Date.now() + seq++).toString().slice(-7)}`;
    const made = await registration.register({
      idempotencyKey: `admin:${key}`,
      ownerName: 'Owner',
      businessName: `Shop ${key}`,
      branchName: 'Main',
      phone,
      password: 'unusable-password-for-the-spec',
      language: 'en',
      actor: 'spec',
      provisioningDraft: draft,
    } as never);
    return { uuid: made.companyId as string, id: uuidToBin(made.companyId), phone };
  }
  const counts = async (id: Buffer, action: string, kind: string) => ({
    audits: await root.platformAuditEvent.count({ where: { targetId: id, action } }),
    events: await root.subscriptionEvent.count({ where: { companyId: id, kind: kind as never } }),
  });
  const sub = (id: Buffer) => root.subscription.findFirstOrThrow({ where: { companyId: id } });

  describe('a grant and its record', () => {
    const GRANT = { kind: 'grant', reason: 'pilot', days: 30 };

    it('an audit failure undoes the grant; a resume grants once, with exactly one record of each', async () => {
      const { uuid, id } = await shop(GRANT);
      failAudit = 'subscription.activate_grant';
      expect(await finishDraft(root, lifecycle, id, uuid, ctx)).toMatchObject({ complete: false });
      expect((await sub(id)).status).toBe('pending_activation');
      expect(await counts(id, 'subscription.activate_grant', 'administrative_grant')).toEqual({ audits: 0, events: 0 });
      expect(await root.billingPeriod.count({ where: { companyId: id } })).toBe(0);

      expect(await finishDraft(root, lifecycle, id, uuid, ctx)).toMatchObject({ complete: true, completedNow: true });
      const until = (await sub(id)).complimentaryUntil;
      expect((await sub(id)).status).toBe('activated');
      expect(await counts(id, 'subscription.activate_grant', 'administrative_grant')).toEqual({ audits: 1, events: 1 });
      expect(await root.billingPeriod.count({ where: { companyId: id } })).toBe(1);

      expect(await finishDraft(root, lifecycle, id, uuid, ctx)).toMatchObject({ complete: true, completedNow: false });
      expect((await sub(id)).complimentaryUntil).toEqual(until);
      expect(await counts(id, 'subscription.activate_grant', 'administrative_grant')).toEqual({ audits: 1, events: 1 });
    });

    it('an approval and an extension are all-or-nothing in the same way', async () => {
      const { uuid, id } = await shop();
      failAudit = 'subscription.approve';
      await expect(lifecycle.approve(uuid, { months: 1, reason: 'paid' }, ctx)).rejects.toThrow('audit down');
      expect((await sub(id)).status).toBe('pending_activation');
      expect(await counts(id, 'subscription.approve', 'approved')).toEqual({ audits: 0, events: 0 });
      await lifecycle.approve(uuid, { months: 1, reason: 'paid' }, ctx);
      const end = (await sub(id)).currentPeriodEnd;

      failAudit = 'subscription.extend';
      await expect(lifecycle.extend(uuid, { months: 1, reason: 'again' }, ctx)).rejects.toThrow('audit down');
      expect((await sub(id)).currentPeriodEnd).toEqual(end);
      expect(await counts(id, 'subscription.extend', 'extended')).toEqual({ audits: 0, events: 0 });
    });

    it('a draft’s Owner cannot be found to sign in, and can once it is finished', async () => {
      const { uuid, id, phone } = await shop(GRANT);
      const users = new UsersService(db, new HashingService());
      expect(await users.findCandidatesForAuth('phone', phone)).toEqual([]);
      await finishDraft(root, lifecycle, id, uuid, ctx);
      expect(await users.findCandidatesForAuth('phone', phone)).toHaveLength(1);
    });
  });

  describe('a stopped proof approval', () => {
    const decision = { amount: '300', paidAt: '2026-10-01T00:00:00.000Z', months: 1, reason: 'seen in the account' };
    const payments = (id: Buffer) => root.subscriptionPayment.count({ where: { companyId: id } });

    async function paidShopWithProof() {
      const s = await shop();
      await lifecycle.approve(s.uuid, { months: 1, reason: 'first' }, ctx);
      const proof = await proofs.submit(s.id, { buffer: Buffer.concat([PNG, Buffer.from(randomUUID())]) }, {
        idempotencyKey: randomUUID(),
        amount: '300',
        paidAt: decision.paidAt,
        userId: Buffer.alloc(16, 7),
      });
      return { ...s, proof, end: (await sub(s.id)).currentPeriodEnd! };
    }
    const age = (id: string) =>
      root.paymentProof.update({ where: { id: uuidToBin(id) }, data: { appliedAt: new Date(Date.now() - RECOVERY_AFTER_MS - 1000) } });

    it('a failure before any money releases the claim, so the next decision is fresh', async () => {
      const { proof, id } = await paidShopWithProof();
      failAudit = 'payment.record_and_confirm';
      await expect(proofs.approve(proof.id, decision, ctx)).rejects.toThrow('audit down');
      expect(await proofs.recovery(proof.id)).toMatchObject({ stopped: false, paymentRecorded: false });
      expect(await proofs.approve(proof.id, decision, ctx)).toMatchObject({ status: 'approved' });
      expect(await payments(id)).toBe(1);
    });

    it('money recorded and no period: blocked and shown; no new amount; completing applies one period', async () => {
      const { proof, id, end } = await paidShopWithProof();
      failAudit = 'subscription.extend';
      await expect(proofs.approve(proof.id, decision, ctx)).rejects.toThrow('audit down');
      await expect(proofs.approve(proof.id, { ...decision, amount: '999' }, ctx)).rejects.toMatchObject({ response: { code: 'proof_applying' } });
      await expect(proofs.refuse(proof.id, 'no', ctx)).rejects.toMatchObject({ response: { code: 'proof_decided' } });
      expect(await payments(id)).toBe(1);

      expect(await proofs.recovery(proof.id)).toMatchObject({ stopped: true, mayStillBeRunning: true, paymentRecorded: true, periodApplied: false, actions: { complete: false, release: false } });
      await expect(proofs.completeRecovery(proof.id, { reason: 'x' }, ctx)).rejects.toMatchObject({ response: { code: 'proof_may_be_running' } });

      await age(proof.id);
      expect((await proofs.recovery(proof.id)).actions).toEqual({ complete: true, closeWithoutPeriod: true, release: false });
      await expect(proofs.releaseRecovery(proof.id, 'x', ctx)).rejects.toMatchObject({ response: { code: 'proof_recovery_refused' } });

      expect(await proofs.completeRecovery(proof.id, { reason: 'read the evidence' }, ctx)).toMatchObject({ status: 'approved', months: 1 });
      expect(await payments(id)).toBe(1);
      expect((await sub(id)).currentPeriodEnd!.getTime()).toBeGreaterThan(end.getTime());
      expect(await root.platformAuditEvent.count({ where: { targetId: id, action: 'payment_proof.recovery_complete' } })).toBe(1);
      expect(await root.platformAuditEvent.count({ where: { targetId: id, action: 'payment_proof.approve' } })).toBe(1);
    });

    it('period applied and then a crash: completing adds no second period', async () => {
      const { proof, id } = await paidShopWithProof();
      failAudit = 'payment_proof.approve';
      await expect(proofs.approve(proof.id, decision, ctx)).rejects.toThrow('audit down');
      const extended = (await sub(id)).currentPeriodEnd;
      expect(await proofs.recovery(proof.id)).toMatchObject({ stopped: true, paymentRecorded: true, periodApplied: true });

      await age(proof.id);
      expect((await proofs.recovery(proof.id)).actions).toEqual({ complete: true, closeWithoutPeriod: false, release: false });
      expect(await proofs.completeRecovery(proof.id, { reason: 'finish' }, ctx)).toMatchObject({ status: 'approved' });
      expect((await sub(id)).currentPeriodEnd).toEqual(extended);
      expect(await payments(id)).toBe(1);
    });

    it('two recoveries at once: one payment, one period, one decision', async () => {
      const { proof, id, end } = await paidShopWithProof();
      failAudit = 'subscription.extend';
      await expect(proofs.approve(proof.id, decision, ctx)).rejects.toThrow('audit down');
      await age(proof.id);
      await Promise.all([proofs.completeRecovery(proof.id, { reason: 'a' }, ctx), proofs.completeRecovery(proof.id, { reason: 'b' }, ctx)]);
      expect(await payments(id)).toBe(1);
      expect(await root.subscriptionEvent.count({ where: { companyId: id, kind: 'extended' } })).toBe(1);
      expect((await sub(id)).currentPeriodEnd!.getTime()).toBeGreaterThan(end.getTime());
      expect(await root.platformAuditEvent.count({ where: { targetId: id, action: 'payment_proof.approve' } })).toBe(1);
    });

    it('a period given some other way: closed with the money recorded and no period added', async () => {
      const { proof, id, end } = await paidShopWithProof();
      failAudit = 'subscription.extend';
      await expect(proofs.approve(proof.id, decision, ctx)).rejects.toThrow('audit down');
      await age(proof.id);
      expect(await proofs.completeRecovery(proof.id, { reason: 'extended by hand', closeWithoutPeriod: true }, ctx)).toMatchObject({ status: 'approved', months: null });
      expect((await sub(id)).currentPeriodEnd).toEqual(end);
      expect(await payments(id)).toBe(1);
    });

    it('a crash right after the claim: nothing happened, so it may be released and decided afresh', async () => {
      const { proof, id } = await paidShopWithProof();
      await root.paymentProof.update({ where: { id: uuidToBin(proof.id) }, data: { appliedAt: new Date(Date.now() - RECOVERY_AFTER_MS - 1000), applyRequest: decision } });
      expect((await proofs.recovery(proof.id)).actions).toEqual({ complete: true, closeWithoutPeriod: false, release: true });
      await proofs.releaseRecovery(proof.id, 'nothing was applied', ctx);
      expect(await root.platformAuditEvent.count({ where: { targetId: id, action: 'payment_proof.recovery_release' } })).toBe(1);
      expect(await proofs.approve(proof.id, { ...decision, amount: '250' }, ctx)).toMatchObject({ status: 'approved' });
      expect(await payments(id)).toBe(1);
    });

    it('an untouched or decided proof has nothing to recover', async () => {
      const { proof } = await paidShopWithProof();
      expect((await proofs.recovery(proof.id)).actions).toEqual({ complete: false, closeWithoutPeriod: false, release: false });
      await expect(proofs.releaseRecovery(proof.id, 'x', ctx)).rejects.toMatchObject({ response: { code: 'proof_recovery_refused' } });
    });
  });
});
