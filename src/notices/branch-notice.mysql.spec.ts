import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { BillingService } from '../billing/billing.service';
import { HashingService } from '../common/security/hashing.service';
import { newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import type { DeliveryResult, WhatsAppMessage } from '../messaging/whatsapp-channel';
import { BranchRequestsService } from '../platform/branch-requests.service';
import { PlatformAuditService } from '../platform/platform-audit.service';
import { RegistrationService } from '../platform/registration.service';
import { SeatAllocationService } from '../platform/seat-allocation.service';
import { MAX_WHATSAPP_ATTEMPTS } from './notice-rules';
import { ClaimLinkService, hashClaimToken } from './claim-links.service';
import { branchNoticeKey, NoticeService } from './notice.service';

/**
 * The branch-activation notice in the outbox (0130), on real MySQL with the real NoticeService and a scripted WhatsApp
 * channel: created after the request commits, one per request; held — no attempt spent — while its template is not
 * configured; sent once when it is; bounded retries ending in a recorded reason; cancelled once the branch is no longer
 * waiting; and resent, audited by the caller, as the same notice — never a second branch or a second notice.
 */
const url = process.env.PROVISIONING_ROOT_URL;
const suite = url ? describe : describe.skip;

suite('the branch-activation notice', () => {
  const root = url ? new PrismaClient({ datasources: { db: { url } } }) : (null as unknown as PrismaClient);
  const db = root as never;
  let now = new Date();
  const clock = { now: () => now };
  let template = '';
  const config = {
    portalLive: true,
    whatsappTemplateName: (key: string) => (key === 'WHATSAPP_TEMPLATE_BRANCH_ACTIVATION' ? template : ''),
    portalSubscriptionUrl: 'https://dukan.tsxmr.com/subscription',
  };
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
  const email = { name: 'disabled', isEnabled: false, send: async () => ({ status: 'failed', reason: 'unavailable', detail: 'off', provider: 'disabled' }) };
  const records = { contactState: async () => ({ consented: true, consent: 'active', optOutScope: 'none', undeliverableAt: null, pendingLive: false }) };
  const hasher = { hash: () => 'h'.repeat(64) };
  const entitlement = { trialZone: () => 'Africa/Nouakchott' };
  // Owner, 2026-11-11: the activation message carries the single-use portal link, so the service has its claim links.
  const notices = url ? new NoticeService(db, config as never, entitlement as never, records as never, hasher as never, whatsapp as never, email as never, clock as never, new ClaimLinkService(db)) : (null as never);
  // The worker is the test's to drive: an enqueue does not start a delivery pass here.
  if (notices) (notices as unknown as { deliverNow: () => Promise<void> }).deliverNow = async () => undefined;
  const billing = url ? new BillingService(db, { now: () => new Date() } as never) : (null as never);
  const audit = url ? new PlatformAuditService(db) : (null as never);
  const allocations = url ? new SeatAllocationService(db, audit, billing, { now: () => new Date() } as never, { record: async () => undefined } as never) : (null as never);
  const requests = url ? new BranchRequestsService(db, allocations, notices) : (null as never);
  const registration = url ? new RegistrationService(db, new HashingService(), { now: () => new Date() } as never) : (null as never);

  afterAll(() => root.$disconnect());
  beforeEach(() => {
    sent.length = 0;
    script = [];
    template = '';
    now = new Date();
  });

  async function pendingBranch() {
    const key = randomUUID().replace(/-/g, '').slice(0, 10);
    const made = await registration.register({
      idempotencyKey: `spec:${key}`, ownerName: 'Owner', businessName: `Shop ${key}`, branchName: 'Main',
      phone: `+2223${Date.now().toString().slice(-7)}`, password: 'unusable-password-for-the-spec', language: 'fr', actor: 'spec',
    } as never);
    const id = uuidToBin(made.companyId);
    const owner = uuidToBin(made.ownerUserId);
    // The Owner's number verified, as registration finishes it: WhatsApp can reach them.
    await root.user.update({ where: { id: owner }, data: { phoneVerifiedAt: new Date(), isActive: true } });
    const r = await requests.create(id, owner, { name: 'Ksar', requestKey: randomUUID() }, 'spec');
    const allocation = uuidToBin(r.request.id);
    const notice = await root.subscriptionNotice.findFirstOrThrow({ where: { companyId: id, periodKey: branchNoticeKey(allocation) } });
    return { id, owner, allocation, notice };
  }
  const row = (id: Buffer) => root.subscriptionNotice.findUniqueOrThrow({ where: { id } });
  const later = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };

  it('created once the request commits — one per request, in the business’s language', async () => {
    const { id, notice } = await pendingBranch();
    expect(notice).toMatchObject({ kind: 'branch_activation', threshold: 'activation', state: 'pending', attempts: 0, language: 'fr' });
    expect(await root.subscriptionNotice.count({ where: { companyId: id, kind: 'branch_activation' } })).toBe(1);
  });

  it('without the template: held, no attempt spent, nothing sent — and the branch request stands', async () => {
    const { notice, allocation } = await pendingBranch();
    expect(await notices.deliverOne(notice.id)).toBe(true);
    const held = await row(notice.id);
    expect(held).toMatchObject({ state: 'pending', whatsappOutcome: 'held_template', attempts: 0 });
    expect(held.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
    expect(sent).toHaveLength(0);
    expect((await root.seatAllocation.findUniqueOrThrow({ where: { id: allocation } })).status).toBe('pending_payment');
  });

  it('with the approved template: sent once, the branch’s name and the business’s; a second pass sends nothing', async () => {
    const { notice } = await pendingBranch();
    template = 'dukan_branch_activation_ready';
    await notices.deliverOne(notice.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ template: 'branch.activation_ready', language: 'fr', variables: { branch: 'Ksar' } });
    // The button's single-use link, stored only as its hash and tied to this notice.
    expect(sent[0].variables.claim).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await root.portalClaimLink.findFirst({ where: { tokenHash: hashClaimToken(sent[0].variables.claim), noticeId: notice.id } })).toBeTruthy();
    expect(sent[0].variables.business).toMatch(/^Shop /);
    expect((await row(notice.id)).state).toBe('accepted');
    later(60 * 60_000);
    expect(await notices.deliverOne(notice.id)).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it('temporary failures: bounded retries, then a final failure with its reason recorded', async () => {
    const { notice } = await pendingBranch();
    template = 'dukan_branch_activation_ready';
    script = Array.from({ length: MAX_WHATSAPP_ATTEMPTS + 2 }, () => ({ status: 'failed', reason: 'temporary', detail: '503', provider: 'cloud-api' }) as DeliveryResult);
    for (let i = 0; i < MAX_WHATSAPP_ATTEMPTS + 3; i++) {
      await notices.deliverOne(notice.id);
      later(24 * 60 * 60_000);
    }
    const last = await row(notice.id);
    expect(sent.length).toBeLessThanOrEqual(MAX_WHATSAPP_ATTEMPTS);
    expect(last.state).toBe('failed');
    expect(last.failureReason).toBeTruthy();
  });

  it('a branch no longer waiting (activated meanwhile): cancelled, nothing sent', async () => {
    const { notice, allocation } = await pendingBranch();
    template = 'dukan_branch_activation_ready';
    await root.seatAllocation.update({ where: { id: allocation }, data: { status: 'paid' } });
    await notices.deliverOne(notice.id);
    expect(await row(notice.id)).toMatchObject({ state: 'cancelled', cancelReason: 'branch_not_pending' });
    expect(sent).toHaveLength(0);
  });

  it('a resend is the same notice, waiting again — never a second notice or a second branch', async () => {
    const { id, notice, allocation } = await pendingBranch();
    template = 'dukan_branch_activation_ready';
    script = [{ status: 'failed', reason: 'rejected', detail: 'refused', provider: 'cloud-api' } as DeliveryResult];
    await notices.deliverOne(notice.id);
    expect((await row(notice.id)).state).not.toBe('pending');
    expect(await notices.resendBranchActivation(id, allocation)).toBe('queued');
    expect(await row(notice.id)).toMatchObject({ state: 'pending', attempts: 0, failureReason: null });
    await notices.deliverOne(notice.id);
    expect(sent).toHaveLength(2);
    expect(await root.subscriptionNotice.count({ where: { companyId: id, kind: 'branch_activation' } })).toBe(1);
    expect(await root.seatAllocation.count({ where: { companyId: id, kind: 'store' } })).toBe(1);
    // A branch already active has nothing to resend.
    await root.seatAllocation.update({ where: { id: allocation }, data: { status: 'paid' } });
    expect(await notices.resendBranchActivation(id, allocation)).toBe('not_pending');
  });

  it('an enqueue repeated for the same request finds the one notice', async () => {
    const { id, allocation } = await pendingBranch();
    expect(await notices.enqueueBranchActivation(id, allocation)).toEqual({ created: false });
    expect(await root.subscriptionNotice.count({ where: { companyId: id, kind: 'branch_activation' } })).toBe(1);
    void newUuidV7Bin;
  });
  it('in the language the business set for WhatsApp in the app — EN, FR and AR — each with its own one-time link', async () => {
    template = 'dukan_store_activation_ready';
    for (const lang of ['en', 'fr', 'ar'] as const) {
      const key = randomUUID().replace(/-/g, '').slice(0, 10);
      const made = await registration.register({
        idempotencyKey: `spec:${key}`, ownerName: 'Owner', businessName: `Shop ${key}`, branchName: 'Main',
        phone: `+2223${(Date.now() + lang.length).toString().slice(-7)}`, password: 'unusable-password-for-the-spec', language: 'fr', actor: 'spec',
      } as never);
      const id = uuidToBin(made.companyId);
      await root.user.update({ where: { id: uuidToBin(made.ownerUserId) }, data: { phoneVerifiedAt: new Date(), isActive: true } });
      // Registered in French; the app's WhatsApp language decides.
      await root.companySettings.upsert({ where: { companyId: id }, update: { whatsappLanguage: lang }, create: { companyId: id, whatsappLanguage: lang } as never });
      const r = await requests.create(id, uuidToBin(made.ownerUserId), { name: 'Ksar', requestKey: randomUUID() }, 'spec');
      const notice = await root.subscriptionNotice.findFirstOrThrow({ where: { companyId: id, periodKey: branchNoticeKey(uuidToBin(r.request.id)) } });
      expect(notice.language).toBe(lang);
      sent.length = 0;
      await notices.deliverOne(notice.id);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ template: 'branch.activation_ready', language: lang, variables: { branch: 'Ksar' } });
      expect(sent[0].variables.claim).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });
});
