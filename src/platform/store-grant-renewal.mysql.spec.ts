import { PrismaClient } from '@prisma/client';
import { BillingService } from '../billing/billing.service';
import { SubscriptionRenewal } from '../billing/renewal';
import { HashingService } from '../common/security/hashing.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { PlatformAuditService } from './platform-audit.service';
import { ProvisioningService } from './provisioning.service';
import { RegistrationService } from './registration.service';
import { SeatAllocationService } from './seat-allocation.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';

/**
 * A customer's store granted free until renewal (D227), on REAL MySQL, through the REAL renewal: the owner asked that
 * nothing here be simulated by editing a row. Env-gated like the provisioning spec: a DISPOSABLE grace_* database.
 */
const ROOT_URL = process.env.PROVISIONING_ROOT_URL ?? '';
const APP_URL = process.env.PROVISIONING_APP_URL ?? '';
const run = ROOT_URL !== '' && APP_URL !== '' ? describe : describe.skip;

jest.setTimeout(180_000);

let offset = 0;
const clock = { now: () => new Date(Date.now() + offset) };
const ADMIN = { id: newUuidV7Bin(), email: `renewal-${Date.now().toString(36)}@example.test`, name: 'Admin' } as never;
const CTX = { admin: ADMIN, ip: '127.0.0.1' };
let root: PrismaClient;
const apps: PrismaClient[] = [];
let seq = 0;

function processOn(client: PrismaClient) {
  const db = client as never;
  const audit = new PlatformAuditService(db);
  const billing = new BillingService(db, clock);
  const seats = new SeatAllocationService(db, audit, billing, clock, { recordTx: async () => undefined } as never);
  return {
    billing,
    seats,
    renewal: new SubscriptionRenewal(db, billing, clock),
    registration: new RegistrationService(db, new HashingService(), clock),
    lifecycle: new SubscriptionLifecycleService(db, audit, billing, clock),
    provisioning: new ProvisioningService(db, { customerActivationOpen: true } as never, audit, seats),
  };
}

run('a store free until renewal, through the real renewal', () => {
  let a: ReturnType<typeof processOn>;
  let b: ReturnType<typeof processOn>;

  beforeAll(async () => {
    if (!/^(grace_|provisioning_)/.test(new URL(ROOT_URL).pathname.slice(1))) throw new Error('refusing: not a disposable database');
    root = new PrismaClient({ datasources: { db: { url: ROOT_URL } } });
    apps.push(new PrismaClient({ datasources: { db: { url: APP_URL } } }), new PrismaClient({ datasources: { db: { url: APP_URL } } }));
    a = processOn(apps[0]);
    b = processOn(apps[1]);
    const admin = ADMIN as unknown as { id: Buffer; email: string; name: string };
    await root.$executeRaw`INSERT INTO platform_admins (id, email, name, password_hash, updated_at) VALUES (${admin.id}, ${admin.email}, ${admin.name}, 'x', NOW(6))`;
  });
  afterEach(() => {
    offset = 0;
  });
  afterAll(async () => {
    await Promise.all([root, ...apps].map((c) => c?.$disconnect()));
  });

  async function paidShop() {
    const key = `${Date.now().toString(36)}${seq++}`.toUpperCase().slice(-10);
    const shop = await a.registration.register({
      idempotencyKey: `admin:${key}`,
      ownerName: 'Owner',
      businessName: `Shop ${key}`,
      branchName: '',
      phone: `+2224${(Date.now() + seq).toString().slice(-7)}`,
      password: 'unusable-password-for-the-spec',
      language: 'en',
      actor: 'spec',
    });
    await a.lifecycle.approve(shop.companyId, { months: 1, reason: 'paid' }, CTX);
    return { uuid: shop.companyId, id: uuidToBin(shop.companyId) };
  }
  const periods = (id: Buffer) => root.billingPeriod.findMany({ where: { companyId: id }, orderBy: { periodStart: 'asc' } });
  const grant = (uuid: string, name: string, p = a) =>
    p.provisioning.openStore(uuid, { name, reason: 'pilot', access: { kind: 'grant', reason: 'goodwill' } }, CTX);

  /** A staff member at a store, in its included seat: through the rows the census reads. */
  async function employee(id: Buffer, branchId: Buffer) {
    const role = await root.role.findFirstOrThrow({ where: { companyId: id, key: 'store_employee' } });
    const userId = newUuidV7Bin();
    const tag = userId.toString('hex').slice(-12);
    await root.user.create({ data: { id: userId, companyId: id, name: 'Staff', login: `s-${tag}`, personalId: `U-${tag.slice(0, 8)}`, passwordHash: 'x' } });
    await root.userBranch.create({ data: { id: newUuidV7Bin(), companyId: id, userId, branchId, roleId: role.id } });
  }

  async function paidSeat(id: Buffer, branchId: Buffer) {
    const seat = await a.seats.requestSeat(id, { branchId, requestedBy: 'spec' });
    expect(seat.allocation.monthlyAmount).toBeGreaterThan(0);
    await a.seats.confirmPayment(
      uuidToBin(seat.allocation.id),
      { amount: String(seat.allocation.monthlyAmount), paidAt: clock.now(), reference: `seat-${seq++}-ref` },
      CTX,
    );
    return seat.allocation.monthlyAmount;
  }

  /** The real way past a period: the Owner pays for the next month, its end arrives, and the roll is due. */
  async function reachRenewal(uuid: string) {
    const [first] = await periods(uuidToBin(uuid));
    await a.lifecycle.extend(uuid, { months: 1, reason: 'paid again' }, CTX);
    offset = first.periodEnd!.getTime() - Date.now() + 60_000;
  }

  it('covers the store and its included seat, never an extra paid seat, and renewal bills all of it exactly once', async () => {
    const { uuid, id } = await paidShop();
    const [before] = await periods(id);

    const opened = await grant(uuid, 'Gift');
    expect(opened).toMatchObject({ mode: 'opened', allocation: { status: 'granted', monthlyAmount: 0 } });
    const gift = await root.branch.findFirstOrThrow({ where: { companyId: id, name: 'Gift' } });

    // No charge for the store, and none for the person in its included seat.
    await employee(id, gift.id);
    await a.billing.assessNow(id);
    let [p1] = await periods(id);
    expect(Number(p1.assessedTotal)).toBe(Number(before.assessedTotal));

    // A seat beyond the included one is still paid for, in this very period.
    const seatFee = await paidSeat(id, gift.id);
    await a.billing.assessNow(id);
    [p1] = await periods(id);
    expect(Number(p1.assessedStaffFee)).toBe(Number(before.assessedStaffFee) + seatFee);
    expect(Number(p1.assessedBranchFee)).toBe(Number(before.assessedBranchFee));

    // The real renewal, twice at once and once more: one new period, charged in full.
    await reachRenewal(uuid);
    await Promise.all([a.renewal.rollIfDue(id), b.renewal.rollIfDue(id)]);
    await a.renewal.rollIfDue(id);
    const after = await periods(id);
    expect(after).toHaveLength(2);
    const storeFee = Number(before.assessedBranchFee);
    expect(Number(after[1].assessedBranchFee)).toBe(storeFee * 2);
    expect(Number(after[1].assessedStaffFee)).toBe(seatFee);

    // No leak: assessing the new period changes nothing, and the mark still names only the old one.
    await a.billing.assessNow(id);
    const again = await periods(id);
    expect(Number(again[1].assessedTotal)).toBe(Number(after[1].assessedTotal));
    const mark = await root.seatAllocation.findFirstOrThrow({ where: { companyId: id, label: 'Gift', status: 'granted' } });
    expect(mark.freeUntilPeriodId?.equals(before.id)).toBe(true);
    expect(mark.freeUntilPeriodId?.equals(after[1].id)).toBe(false);
  });

  it('correcting the period does not move the free date; only the audited extension does', async () => {
    const { uuid, id } = await paidShop();
    const [before] = await periods(id);
    await grant(uuid, 'Fixed');
    const row = await root.seatAllocation.findFirstOrThrow({ where: { companyId: id, label: 'Fixed', status: 'granted' } });
    const original = row.freeUntilAt!;
    expect(original.getTime()).toBe(before.periodEnd!.getTime());

    const later = new Date(original.getTime() + 10 * 24 * 60 * 60 * 1000);
    await a.lifecycle.setPeriodEnd(uuid, { periodEnd: later, reason: 'typo' }, CTX);
    const kept = await root.seatAllocation.findUniqueOrThrow({ where: { id: row.id } });
    expect(kept.freeUntilAt!.getTime()).toBe(original.getTime());

    // Past the recorded date, inside the re-dated period: the store is charged.
    offset = original.getTime() - Date.now() + 60_000;
    await a.billing.assessNow(id);
    const [charged] = await periods(id);
    expect(Number(charged.assessedBranchFee)).toBe(Number(before.assessedBranchFee) * 2);
  });

  it('the extension is explicit, audited, forward and inside the period', async () => {
    const { uuid, id } = await paidShop();
    const [before] = await periods(id);
    await grant(uuid, 'Longer');
    const row = await root.seatAllocation.findFirstOrThrow({ where: { companyId: id, label: 'Longer', status: 'granted' } });
    const end = row.freeUntilAt!.getTime();
    const later = new Date(end + 5 * 24 * 60 * 60 * 1000);
    const rid = binToUuid(row.id);
    await expect(a.provisioning.extendStoreGrant(uuid, rid, { until: later, reason: 'x' }, CTX)).rejects.toMatchObject({ response: { code: 'grant_until_invalid' } });
    await a.lifecycle.setPeriodEnd(uuid, { periodEnd: new Date(end + 10 * 24 * 60 * 60 * 1000), reason: 'corrected' }, CTX);
    await a.provisioning.extendStoreGrant(uuid, rid, { until: later, reason: 'goodwill' }, CTX);
    expect((await root.seatAllocation.findUniqueOrThrow({ where: { id: row.id } })).freeUntilAt!.getTime()).toBe(later.getTime());
    expect(await root.platformAuditEvent.count({ where: { targetId: id, action: 'business.store_grant_extend' } })).toBeGreaterThan(0);
    offset = end - Date.now() + 60_000;
    await a.billing.assessNow(id);
    const [still] = await periods(id);
    expect(Number(still.assessedBranchFee)).toBe(Number(before.assessedBranchFee));
  });

  it('a grant racing a due renewal cannot double-charge or extend the exemption', async () => {
    const { uuid, id } = await paidShop();
    const [before] = await periods(id);
    await reachRenewal(uuid);

    const [granted] = await Promise.allSettled([grant(uuid, 'Racer', b), a.renewal.rollIfDue(id), b.renewal.rollIfDue(id)]);
    const after = await periods(id);
    expect(after).toHaveLength(2);
    await a.billing.assessNow(id);
    const settled = await periods(id);
    const fee = Number(before.assessedBranchFee);

    const mark = await root.seatAllocation.findFirst({ where: { companyId: id, label: 'Racer', status: 'granted' } });
    if (granted.status === 'fulfilled' && mark) {
      // Granted inside the new period: free for that one alone, and billed by the one after.
      expect(mark.freeUntilPeriodId?.equals(settled[1].id)).toBe(true);
    } else {
      expect(await root.branch.count({ where: { companyId: id, name: 'Racer' } })).toBe(0);
    }
    expect(Number(settled[1].assessedBranchFee)).toBe(fee);

    const next = settled[1];
    await a.lifecycle.extend(uuid, { months: 1, reason: 'paid again' }, CTX);
    offset = next.periodEnd!.getTime() - Date.now() + 60_000;
    await a.renewal.rollIfDue(id);
    const third = await periods(id);
    expect(third).toHaveLength(3);
    expect(Number(third[2].assessedBranchFee)).toBe(mark ? fee * 2 : fee);
  });

  it('a name never withdraws somebody else’s request: only its exact id acts on it', async () => {
    const { uuid, id } = await paidShop();
    const owners = await a.seats.requestStore(id, { name: 'Annex', requestedBy: 'owner@example.test' });
    expect(owners.allocation.status).toBe('pending_payment');

    await expect(grant(uuid, 'Annex')).rejects.toMatchObject({ response: { code: 'pending_request_exists', requestId: owners.allocation.id } });
    const still = await root.seatAllocation.findUniqueOrThrow({ where: { id: uuidToBin(owners.allocation.id) } });
    expect(still.status).toBe('pending_payment');
    expect(await root.branch.count({ where: { companyId: id, name: 'Annex' } })).toBe(0);

    const exact = await a.provisioning.openStore(
      uuid,
      { name: 'Annex', reason: 'pilot', access: { kind: 'grant', reason: 'goodwill' }, requestId: owners.allocation.id },
      CTX,
    );
    expect(exact.mode).toBe('opened');
    const withdrawn = await root.seatAllocation.findUniqueOrThrow({ where: { id: uuidToBin(owners.allocation.id) } });
    expect(withdrawn.status).toBe('released');
    expect(binToUuid(withdrawn.id)).toBe(owners.allocation.id);
  });
});
