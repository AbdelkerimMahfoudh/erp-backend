import { ConflictException, ForbiddenException, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfigService } from '../common/config/app-config.service';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { ProvisioningService } from './provisioning.service';
import { AppOwnerSetupController } from './app-owner-setup.controller';
import { OWNER_SETUP_THROTTLE, PlatformController } from './platform.controller';

/**
 * Platform-superadmin provisioning and persistent test businesses (D217; the owner's decision of 2026-10-20).
 *
 * What is pinned:
 *  - customer activation, closed, lets the console set up and give access to TEST businesses only — creating, the
 *    Owner's invitation (issued and spent), approval and grants — and every refusal is audited with what was tried;
 *  - a test business is never paid for;
 *  - its test status is an administrator's decision, refused where it would mix test and real;
 *  - a store from the console is granted under a test business's grant, and is the priced request for a customer;
 *  - provisioning and activation are two answers, and neither carries a credential.
 */

const ADMIN = { id: newUuidV7Bin(), email: 'ops@example.test', name: 'Ops' };
const CTX = { admin: ADMIN, ip: '10.0.0.9' };

/** The configuration as given, and nothing from the test runner's own environment. */
function configWith(env: Record<string, string>) {
  const read = (key: string) => env[key];
  return new AppConfigService({ get: read, getOrThrow: read } as unknown as ConfigService);
}

interface Biz {
  id: Buffer;
  name: string;
  isTest: boolean;
  testMarkedAt: Date | null;
  testMarkedBy: string | null;
}

function world(opts: { activation?: 'open' | 'closed'; connections?: number; counterparties?: number; payments?: number; status?: string; accepted?: number } = {}) {
  const real: Biz = { id: newUuidV7Bin(), name: 'Real Shop', isTest: false, testMarkedAt: null, testMarkedBy: null };
  const test: Biz = { id: newUuidV7Bin(), name: 'Test Shop', isTest: true, testMarkedAt: new Date(), testMarkedBy: ADMIN.email };
  const companies = [real, test];
  const audits: Record<string, any>[] = [];
  const seatCalls: string[] = [];
  const find = (id: Buffer) => companies.find((c) => c.id.equals(id)) ?? null;

  const prisma: any = {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(prisma),
    $queryRaw: async () => [],
    company: {
      findUnique: async ({ where }: any) => find(where.id),
      findUniqueOrThrow: async ({ where }: any) => {
        const c = find(where.id);
        if (!c) throw new Error('not found');
        return c;
      },
      update: async ({ where, data }: any) => Object.assign(find(where.id)!, data),
    },
    storeConnection: { count: async () => opts.connections ?? 0 },
    counterparty: { count: async () => opts.counterparties ?? 0 },
    subscriptionPayment: { count: async () => opts.payments ?? 0 },
    subscription: { findFirst: async () => ({ status: opts.status ?? 'pending_activation', isComplimentary: false, complimentaryUntil: null }) },
    ownerInvitation: { count: async () => opts.accepted ?? 0, findFirst: async () => null },
    registrationAttempt: { findFirst: async () => null },
    user: { findFirst: async () => null },
  };
  const audit = { record: async (e: Record<string, any>) => void audits.push(e) };
  const allocation = (status: string) => ({ label: 'Annex', activityTo: 'electronics', status, monthlyAmount: status === 'granted' ? 0 : 500 });
  const seats = {
    grantStore: async () => {
      seatCalls.push('grantStore');
      return { allocation: allocation('granted'), created: true };
    },
    requestStore: async () => {
      seatCalls.push('requestStore');
      return { allocation: allocation('pending_payment'), created: true };
    },
  };
  const config = configWith({ NODE_ENV: 'production', ...(opts.activation ? { CUSTOMER_ACTIVATION: opts.activation } : {}) });
  const service = new ProvisioningService(prisma as never, config, audit as never, seats as never);
  return { service, real, test, audits, seatCalls, prisma };
}

const codeOf = (e: unknown) => ((e as HttpException).getResponse() as { code?: string }).code;

describe('customer activation (CUSTOMER_ACTIVATION)', () => {
  it('is closed in production unless said, open elsewhere unless said', () => {
    expect(configWith({ NODE_ENV: 'production' }).customerActivationOpen).toBe(false);
    expect(configWith({ NODE_ENV: 'development' }).customerActivationOpen).toBe(true);
    expect(configWith({ NODE_ENV: 'test' }).customerActivationOpen).toBe(true);
    expect(configWith({ NODE_ENV: 'development', CUSTOMER_ACTIVATION: 'closed' }).customerActivationOpen).toBe(false);
    expect(configWith({ NODE_ENV: 'production', CUSTOMER_ACTIVATION: 'open' }).customerActivationOpen).toBe(true);
  });

  it('closed: the console creates a test business, and refuses a customer’s — the refusal audited, nothing else', async () => {
    const { service, audits } = world();
    await expect(service.assertMayCreate(true, CTX, 'Lab')).resolves.toBeUndefined();
    const refusal = await service.assertMayCreate(false, CTX, 'Customer').catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ForbiddenException);
    expect(codeOf(refusal)).toBe('customer_activation_closed');
    expect(audits).toEqual([
      expect.objectContaining({ action: 'business.create.refused', targetLabel: 'Customer', reason: 'customer_activation_closed', after: expect.objectContaining({ outcome: 'refused' }) }),
    ]);
  });

  it('closed: an invitation, an approval or a grant for a customer is refused; for a test business it goes ahead', async () => {
    const { service, real, test, audits } = world();
    for (const action of ['owner_invitation.issue', 'subscription.approve', 'subscription.activate_grant']) {
      await expect(service.assertMayActivate(binToUuid(test.id), action, CTX)).resolves.toBeUndefined();
      const refusal = await service.assertMayActivate(binToUuid(real.id), action, CTX).catch((e: unknown) => e);
      expect(codeOf(refusal)).toBe('customer_activation_closed');
    }
    expect(audits.map((a) => a.action)).toEqual([
      'owner_invitation.issue.refused',
      'subscription.approve.refused',
      'subscription.activate_grant.refused',
    ]);
    expect(audits.every((a) => a.targetId.equals(real.id) && a.admin === ADMIN)).toBe(true);
  });

  it('closed: a customer’s invitation cannot be spent; a test business’s can', async () => {
    const { service, real, test } = world();
    expect(await service.mayAcceptInvitation(real.id)).toBe(false);
    expect(await service.mayAcceptInvitation(test.id)).toBe(true);
  });

  it('open: the customer’s business goes ahead as before', async () => {
    const { service, real, audits } = world({ activation: 'open' });
    await expect(service.assertMayCreate(false, CTX, 'Customer')).resolves.toBeUndefined();
    await expect(service.assertMayActivate(binToUuid(real.id), 'subscription.approve', CTX)).resolves.toBeUndefined();
    expect(await service.mayAcceptInvitation(real.id)).toBe(true);
    expect(audits).toEqual([]);
  });
});

describe('a test business is never paid for', () => {
  it('refuses a payment for a test business, open or closed, and audits it; a customer’s goes ahead', async () => {
    for (const activation of ['open', 'closed'] as const) {
      const { service, real, test, audits } = world({ activation });
      await expect(service.assertMayTakePayment(real.id, 'subscription.payment', CTX)).resolves.toBeUndefined();
      const refusal = await service.assertMayTakePayment(test.id, 'subscription.payment', CTX).catch((e: unknown) => e);
      expect(codeOf(refusal)).toBe('test_business_no_payment');
      expect(audits.map((a) => a.action)).toEqual(['subscription.payment.refused']);
    }
  });
});

describe('the test status', () => {
  it('is set with a reason and audited, and the same status again changes nothing', async () => {
    const { service, real, audits } = world();
    expect(await service.setTestStatus(binToUuid(real.id), { isTest: true, reason: 'QA lab' }, CTX)).toEqual({ applied: true, isTest: true });
    expect(real).toMatchObject({ isTest: true, testMarkedBy: ADMIN.email });
    expect(real.testMarkedAt).toBeInstanceOf(Date);
    expect(audits).toEqual([
      expect.objectContaining({ action: 'business.test_status', reason: 'QA lab', before: { isTest: false }, after: { isTest: true, outcome: 'applied' } }),
    ]);
    expect(await service.setTestStatus(binToUuid(real.id), { isTest: true, reason: 'again' }, CTX)).toEqual({ applied: false, isTest: true });
    expect(audits).toHaveLength(1);
  });

  it.each<[string, Parameters<typeof world>[0], boolean, string]>([
    ['a business connected to another', { connections: 1 }, true, 'test_status_connected'],
    ['a business linked as a counterparty', { counterparties: 1 }, true, 'test_status_connected'],
    ['a business that has paid', { payments: 1 }, true, 'test_status_paid'],
  ])('refuses to mark %s as a test business', async (_label, opts, isTest, code) => {
    const { service, real, audits } = world(opts);
    const refusal = await service.setTestStatus(binToUuid(real.id), { isTest, reason: 'r' }, CTX).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ConflictException);
    expect(codeOf(refusal)).toBe(code);
    expect(real.isTest).toBe(false);
    expect(audits).toEqual([expect.objectContaining({ action: 'business.test_status.refused', reason: code })]);
  });

  it.each<[string, Parameters<typeof world>[0]]>([
    ['given access', { status: 'activated' }],
    ['whose Owner set a password', { accepted: 1 }],
  ])('keeps a test business %s a test business', async (_label, opts) => {
    const { service, test } = world(opts);
    const refusal = await service.setTestStatus(binToUuid(test.id), { isTest: false, reason: 'r' }, CTX).catch((e: unknown) => e);
    expect(codeOf(refusal)).toBe('test_status_in_use');
    expect(test.isTest).toBe(true);
  });

  it('clears an unused test business (a mistake at creation)', async () => {
    const { service, test } = world();
    expect(await service.setTestStatus(binToUuid(test.id), { isTest: false, reason: 'created as test by mistake' }, CTX)).toEqual({ applied: true, isTest: false });
  });

  it('needs a reason', async () => {
    const { service, real, audits } = world();
    await expect(service.setTestStatus(binToUuid(real.id), { isTest: true, reason: '  ' }, CTX)).rejects.toBeInstanceOf(HttpException);
    expect(real.isTest).toBe(false);
    expect(audits[0]).toMatchObject({ action: 'business.test_status.refused' });
  });
});

describe('a store from the console (the owner’s decision of 2026-10-20)', () => {
  it('opens a test business’s store under its grant, and files a customer’s priced request — each audited', async () => {
    const { service, real, test, seatCalls, audits } = world();
    const granted = await service.openStore(binToUuid(test.id), { name: 'Annex', reason: 'second test store' }, CTX);
    const requested = await service.openStore(binToUuid(real.id), { name: 'Annex', reason: 'asked by phone' }, CTX);
    expect(seatCalls).toEqual(['grantStore', 'requestStore']);
    expect(granted).toMatchObject({ mode: 'granted', created: true, allocation: { status: 'granted', monthlyAmount: 0 } });
    expect(requested).toMatchObject({ mode: 'requested', created: true, allocation: { status: 'pending_payment' } });
    expect(audits.map((a) => a.action)).toEqual(['business.store_grant', 'business.store_request']);
  });

  it('audits a refusal from below with its code', async () => {
    const { service, test, audits, prisma } = world();
    void prisma;
    const seats = (service as unknown as { seats: { grantStore: () => Promise<never> } }).seats;
    seats.grantStore = async () => {
      throw new ConflictException({ code: 'grant_required', message: 'x' });
    };
    const refusal = await service.openStore(binToUuid(test.id), { name: 'Annex', reason: 'r' }, CTX).catch((e: unknown) => e);
    expect(codeOf(refusal)).toBe('grant_required');
    expect(audits).toEqual([expect.objectContaining({ action: 'business.store.refused', reason: 'grant_required' })]);
  });
});

describe('provisioning and activation, separately', () => {
  it('says the Owner’s setup is awaited until the invitation is spent, and never carries a credential', async () => {
    const { service, test, prisma } = world();
    const owner = { id: newUuidV7Bin(), name: 'Tester', email: null, phone: '+22200000001', emailVerifiedAt: null, phoneVerifiedAt: null, lastLoginAt: null };
    prisma.registrationAttempt.findFirst = async () => ({ idempotencyKey: 'admin:k-1' });
    prisma.user.findFirst = async () => owner;
    const expiresAt = new Date(Date.now() + 3600_000);
    prisma.ownerInvitation.findFirst = async () => ({ issuedBy: ADMIN.email, createdAt: new Date(), expiresAt, acceptedAt: null, revokedAt: null, tokenHash: 'never-returned' });
    prisma.subscription.findFirst = async () => ({ status: 'pending_activation', isComplimentary: false, complimentaryUntil: null });

    const before = await service.status(test.id);
    expect(before).toMatchObject({
      isTest: true,
      customerActivation: 'closed',
      createdBy: 'console',
      provisioning: 'awaiting_owner_setup',
      owner: { passwordSet: false, phone: { present: true, verified: false, whatsappConsent: null } },
      invitation: { state: 'active', issuedBy: ADMIN.email },
      activation: { status: 'pending_activation', complimentaryUntil: null },
    });
    expect(JSON.stringify(before)).not.toMatch(/never-returned|token|password"/i);

    prisma.ownerInvitation.count = async () => 1;
    prisma.ownerInvitation.findFirst = async () => ({ issuedBy: ADMIN.email, createdAt: new Date(), expiresAt, acceptedAt: new Date(), revokedAt: null });
    prisma.subscription.findFirst = async () => ({ status: 'activated', isComplimentary: true, complimentaryUntil: expiresAt });
    expect(await service.status(test.id)).toMatchObject({
      provisioning: 'ready',
      owner: { passwordSet: true },
      invitation: { state: 'accepted' },
      activation: { status: 'activated', complimentaryUntil: expiresAt.toISOString() },
    });
  });

  it('tells an expired and a revoked invitation apart from none', async () => {
    const { service, test, prisma } = world();
    expect((await service.status(test.id)).invitation.state).toBe('none');
    prisma.ownerInvitation.findFirst = async () => ({ issuedBy: 'a', createdAt: new Date(0), expiresAt: new Date(1), acceptedAt: null, revokedAt: null });
    expect((await service.status(test.id)).invitation.state).toBe('expired');
    prisma.ownerInvitation.findFirst = async () => ({ issuedBy: 'a', createdAt: new Date(0), expiresAt: new Date(Date.now() + 1e6), acceptedAt: null, revokedAt: new Date() });
    expect((await service.status(test.id)).invitation.state).toBe('revoked');
  });
});

describe('the setup code’s two doors', () => {
  const throttleOf = (target: object) => Reflect.getMetadata('THROTTLER:LIMITdefault', target) as number | undefined;
  const keyOf = (target: object) => Reflect.getMetadata('THROTTLER:KEY_GENERATORdefault', target) as unknown;

  it('the website’s and the app’s spend one budget per address, and both pass the activation gate', async () => {
    const website = PlatformController.prototype.acceptOwnerInvitation;
    const app = AppOwnerSetupController.prototype.setup;
    expect(throttleOf(website)).toBe(OWNER_SETUP_THROTTLE.default.limit);
    expect(throttleOf(app)).toBe(OWNER_SETUP_THROTTLE.default.limit);
    expect(keyOf(website)).toBe(OWNER_SETUP_THROTTLE.default.generateKey);
    expect(keyOf(app)).toBe(OWNER_SETUP_THROTTLE.default.generateKey);

    const seen: unknown[] = [];
    const invitations = {
      accept: async (token: string, password: string, meta: { mayAccept?: (c: Buffer) => Promise<boolean> }) => {
        seen.push({ token, password, gated: await meta.mayAccept?.(Buffer.alloc(16)) });
        return { publicStoreId: 'P', businessName: 'B' };
      },
    };
    const controller = new AppOwnerSetupController(invitations as never, { mayAcceptInvitation: async () => false } as never);
    expect(await controller.setup({ token: 't'.repeat(43), password: 'password-1' } as never, { ip: '10.0.0.1' } as never)).toEqual({ publicStoreId: 'P', businessName: 'B', next: 'sign_in' });
    expect(seen).toEqual([{ token: 't'.repeat(43), password: 'password-1', gated: false }]);
  });
});
