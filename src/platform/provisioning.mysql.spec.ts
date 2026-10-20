import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { BillingService } from '../billing/billing.service';
import { HashingService } from '../common/security/hashing.service';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { ConnectionsService } from '../consignment/connections.service';
import { OwnerInvitationService } from './owner-invitation.service';
import { PlatformAuditService } from './platform-audit.service';
import { ProvisioningService } from './provisioning.service';
import { RegistrationService } from './registration.service';
import { SeatAllocationService } from './seat-allocation.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';

/**
 * Persistent test businesses and the console's provisioning (0102; D217) on REAL MySQL — what the in-memory worlds
 * cannot show: the migration's columns and defaults, the row locks that serialise two administrators on one business
 * and two store openings under one grant across separate connection pools, the invitation's claim and password in one
 * transaction, and the connection filters as SQL.
 *
 * Env-gated, and skipped otherwise: set PROVISIONING_ROOT_URL (root: fixtures and reads) and PROVISIONING_APP_URL
 * (phonestore_app: every service under test) to a DISPOSABLE database with 0102 applied, whose name starts with
 * `grace_` or `provisioning_`. It writes businesses it never removes: drop the database afterwards. CI runs it in the
 * database gates (`deploy/ci-database-gates.sh`).
 */

const ROOT_URL = process.env.PROVISIONING_ROOT_URL ?? '';
const APP_URL = process.env.PROVISIONING_APP_URL ?? '';
const run = ROOT_URL !== '' && APP_URL !== '' ? describe : describe.skip;

jest.setTimeout(180_000);

const clock = { now: () => new Date() };
let root: PrismaClient;
const apps: PrismaClient[] = [];
let seq = 0;
const tag = () => `${Date.now().toString(36)}${seq++}`.toUpperCase().slice(-10);
const ADMIN = { id: newUuidV7Bin(), email: `provisioning-${Date.now().toString(36)}@example.test`, name: 'Provisioning' };
const CTX = { admin: ADMIN, ip: '127.0.0.1' };

/** Everything one API process would hold, over the application account, with customer activation closed. */
function processOn(client: PrismaClient) {
  const db = client as never;
  const audit = new PlatformAuditService(db);
  const billing = new BillingService(db, clock);
  const seats = new SeatAllocationService(db, audit, billing, clock, { recordTx: async () => undefined } as never);
  const provisioning = new ProvisioningService(db, { customerActivationOpen: false } as never, audit, seats);
  return {
    registration: new RegistrationService(db, new HashingService(), clock),
    lifecycle: new SubscriptionLifecycleService(db, audit, billing, clock),
    invitations: new OwnerInvitationService(db, new HashingService(), { revokeAll: async () => 0 } as never, audit),
    seats,
    provisioning,
    connectionsAs: (companyId: Buffer) => new ConnectionsService(db, { companyId: () => companyId, userId: () => null } as never, { record: async () => undefined } as never),
  };
}

async function consoleBusiness(p: ReturnType<typeof processOn>, isTest: boolean, key = tag()) {
  return p.registration.register({
    idempotencyKey: `admin:${key}`,
    ownerName: 'Tester',
    businessName: `${isTest ? 'Lab' : 'Shop'} ${key}`,
    branchName: '',
    city: 'Nouakchott',
    phone: `+2224${(Date.now() % 10_000_000).toString().padStart(7, '0')}`,
    password: 'unusable-password-for-the-spec',
    language: 'en',
    actor: ADMIN.email,
    isTest,
    testMarkedBy: isTest ? ADMIN.email : undefined,
  });
}

run('test businesses and provisioning on real MySQL (0102)', () => {
  let a: ReturnType<typeof processOn>;
  let b: ReturnType<typeof processOn>;

  beforeAll(async () => {
    const name = new URL(ROOT_URL).pathname.slice(1);
    if (!/^(grace_|provisioning_)/.test(name)) throw new Error(`refusing to run on "${name}": a disposable grace_* or provisioning_* database only`);
    root = new PrismaClient({ datasources: { db: { url: ROOT_URL } } });
    apps.push(new PrismaClient({ datasources: { db: { url: APP_URL } } }), new PrismaClient({ datasources: { db: { url: APP_URL } } }));
    a = processOn(apps[0]);
    b = processOn(apps[1]);
    await root.$executeRaw`INSERT INTO platform_admins (id, email, name, password_hash, updated_at) VALUES (${ADMIN.id}, ${ADMIN.email}, 'Provisioning', 'x', NOW(6))`;
  });

  afterAll(async () => {
    await Promise.all([root, ...apps].map((c) => c?.$disconnect()));
  });

  it('adds the columns with their defaults: an existing business stays a customer’s', async () => {
    const cols = await root.$queryRaw<{ COLUMN_NAME: string; COLUMN_DEFAULT: string | null; IS_NULLABLE: string }[]>`
      SELECT COLUMN_NAME, COLUMN_DEFAULT, IS_NULLABLE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME IN ('is_test', 'test_marked_at', 'test_marked_by')
       ORDER BY ORDINAL_POSITION`;
    expect(cols.map((c) => [c.COLUMN_NAME, c.COLUMN_DEFAULT, c.IS_NULLABLE])).toEqual([
      ['is_test', '0', 'NO'],
      ['test_marked_at', null, 'YES'],
      ['test_marked_by', null, 'YES'],
    ]);
    const id = newUuidV7Bin();
    const t = tag();
    await root.$executeRaw`INSERT INTO companies (id, name, settings, updated_at, public_store_id) VALUES (${id}, ${`Old ${t}`}, JSON_OBJECT(), NOW(6), ${`OL${t}`})`;
    expect(await root.company.findUniqueOrThrow({ where: { id }, select: { isTest: true, testMarkedAt: true } })).toEqual({ isTest: false, testMarkedAt: null });
  });

  it('creates a test business marked in the same transaction, and a retry with the key makes no second one', async () => {
    const key = tag();
    const [first, retry] = await Promise.all([consoleBusiness(a, true, key), consoleBusiness(b, true, key)]);
    expect(first.companyId).toBe(retry.companyId);
    expect([first.created, retry.created].sort()).toEqual([false, true]);
    const rows = await root.company.findMany({ where: { name: `Lab ${key}` }, select: { isTest: true, testMarkedBy: true, testMarkedAt: true } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ isTest: true, testMarkedBy: ADMIN.email });
    expect(rows[0].testMarkedAt).toBeInstanceOf(Date);
  });

  it('opens one store under the grant when two administrators ask at once, and refuses without a grant or for a customer', async () => {
    const lab = await consoleBusiness(a, true);
    const shop = await consoleBusiness(a, false);

    const noGrant = await a.seats.grantStore(Buffer.from(lab.companyId.replace(/-/g, ''), 'hex'), { name: 'Annex', reason: 'r', by: ADMIN.email }).catch((e: unknown) => e);
    expect(noGrant).toBeInstanceOf(ConflictException);
    expect(((noGrant as ConflictException).getResponse() as { code: string }).code).toBe('grant_required');

    await a.lifecycle.activateByGrant(lab.companyId, { days: 30, reason: 'QA lab access' }, CTX as never);
    const labId = Buffer.from(lab.companyId.replace(/-/g, ''), 'hex');
    const [one, two] = await Promise.all([
      a.provisioning.openStore(lab.companyId, { name: 'Annex', reason: 'second test store' }, CTX),
      b.provisioning.openStore(lab.companyId, { name: 'Annex', reason: 'second test store' }, CTX),
    ]);
    expect([one.created, two.created].sort()).toEqual([false, true]);
    expect(one.allocation.id).toBe(two.allocation.id);
    expect(one).toMatchObject({ mode: 'granted', allocation: { status: 'granted', monthlyAmount: 0 } });

    const branches = await root.branch.findMany({ where: { companyId: labId }, select: { name: true } });
    expect(branches.map((x) => x.name).sort()).toEqual(['Annex', 'Main Store']);
    const sub = await root.subscription.findFirstOrThrow({ where: { companyId: labId }, select: { subscribedBranchCount: true } });
    expect(sub.subscribedBranchCount).toBe(2);
    // The Owner works at the new store at once.
    const annex = await root.branch.findFirstOrThrow({ where: { companyId: labId, name: 'Annex' }, select: { id: true } });
    expect(await root.userBranch.count({ where: { branchId: annex.id } })).toBe(1);
    // Nothing was paid, and the timeline says it was the grant.
    expect(await root.subscriptionPayment.count({ where: { companyId: labId } })).toBe(0);
    const events = await root.subscriptionEvent.findMany({ where: { companyId: labId, kind: 'branches_changed' }, select: { note: true } });
    expect(events.map((e) => e.note)).toEqual([expect.stringMatching(/opened at no charge under the administrative grant: second test store/)]);
    expect(await root.platformAuditEvent.count({ where: { targetId: labId, action: 'business.store_grant' } })).toBe(1);

    // A customer's store from the console is the priced request, awaiting a real payment.
    const requested = await a.provisioning.openStore(shop.companyId, { name: 'Annex', reason: 'asked by phone' }, CTX);
    expect(requested).toMatchObject({ mode: 'requested', allocation: { status: 'pending_payment' } });
    expect(requested.allocation.monthlyAmount).toBeGreaterThan(0);
    const shopId = Buffer.from(shop.companyId.replace(/-/g, ''), 'hex');
    expect(await root.branch.count({ where: { companyId: shopId } })).toBe(1);
  });

  it('serialises two administrators changing one business’s test status: one applies, the other finds it done', async () => {
    const shop = await consoleBusiness(a, false);
    const [x, y] = await Promise.all([
      a.provisioning.setTestStatus(shop.companyId, { isTest: true, reason: 'QA' }, CTX),
      b.provisioning.setTestStatus(shop.companyId, { isTest: true, reason: 'QA' }, CTX),
    ]);
    expect([x.applied, y.applied].sort()).toEqual([false, true]);
    const id = Buffer.from(shop.companyId.replace(/-/g, ''), 'hex');
    expect(await root.platformAuditEvent.count({ where: { targetId: id, action: 'business.test_status' } })).toBe(1);
  });

  it('keeps test and real stores apart: a test business finds only test businesses, and a connected business keeps its status', async () => {
    const [lab, otherLab, shop] = await Promise.all([consoleBusiness(a, true), consoleBusiness(a, true), consoleBusiness(a, false)]);
    const ids = [lab, otherLab, shop].map((r) => Buffer.from(r.companyId.replace(/-/g, ''), 'hex'));
    await root.company.updateMany({ where: { id: { in: ids } }, data: { isDiscoverable: true } });
    const codes = await Promise.all(ids.map((id) => root.company.findUniqueOrThrow({ where: { id }, select: { publicStoreId: true } })));

    const fromLab = a.connectionsAs(ids[0]);
    await expect(fromLab.lookup(codes[1].publicStoreId)).resolves.toMatchObject({ store: { publicStoreId: codes[1].publicStoreId } });
    await expect(fromLab.lookup(codes[2].publicStoreId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(fromLab.request(codes[2].publicStoreId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(a.connectionsAs(ids[2]).lookup(codes[0].publicStoreId)).rejects.toBeInstanceOf(NotFoundException);
    expect((await fromLab.search(codes[2].publicStoreId)).rows).toEqual([]);

    await fromLab.request(codes[1].publicStoreId);
    const refusal = await a.provisioning.setTestStatus(binToUuid(ids[1]), { isTest: false, reason: 'r' }, CTX).catch((e: unknown) => e);
    expect(((refusal as ConflictException).getResponse() as { code: string }).code).toBe('test_status_connected');
  });

  it('spends an invitation once, with its password, when two accepts race', async () => {
    const lab = await consoleBusiness(a, true);
    const issued = await a.invitations.issue(lab.companyId, { admin: ADMIN, ip: '127.0.0.1', reason: 'test owner' });
    const mayAccept = (companyId: Buffer) => a.provisioning.mayAcceptInvitation(companyId);
    const results = await Promise.allSettled([
      a.invitations.accept(issued.token, 'first-choice-1', { ip: '127.0.0.1', mayAccept }),
      b.invitations.accept(issued.token, 'second-choice-2', { ip: '127.0.0.1', mayAccept }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const id = Buffer.from(lab.companyId.replace(/-/g, ''), 'hex');
    const accepted = await root.ownerInvitation.findMany({ where: { companyId: id }, select: { acceptedAt: true, tokenHash: true } });
    expect(accepted).toHaveLength(1);
    expect(accepted[0].acceptedAt).toBeInstanceOf(Date);
    expect(accepted[0].tokenHash).not.toContain(issued.token);
    const status = await a.provisioning.status(id);
    expect(status).toMatchObject({ provisioning: 'ready', createdBy: 'console', owner: { passwordSet: true }, invitation: { state: 'accepted' } });
  });

  it('refuses to spend a customer’s invitation while customer activation is closed, as it refuses any other', async () => {
    const shop = await consoleBusiness(a, false);
    const issued = await a.invitations.issue(shop.companyId, { admin: ADMIN, ip: '127.0.0.1', reason: 'customer' });
    const refusal = await a.invitations
      .accept(issued.token, 'customer-choice-1', { ip: '127.0.0.1', mayAccept: (c) => a.provisioning.mayAcceptInvitation(c) })
      .catch((e: unknown) => e);
    expect((refusal as Error).message).toBe('That invitation cannot be used.');
    const id = Buffer.from(shop.companyId.replace(/-/g, ''), 'hex');
    expect(await root.ownerInvitation.count({ where: { companyId: id, acceptedAt: { not: null } } })).toBe(0);
  });
});
