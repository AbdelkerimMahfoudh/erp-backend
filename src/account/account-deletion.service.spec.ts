import { HttpException } from '@nestjs/common';
import { OtpService } from '../auth/otp/otp.service';
import { DisabledWhatsAppChannel, TestWhatsAppChannel } from '../messaging/channels';
import { ACCOUNT_DELETED_TEMPLATE, ACCOUNT_DELETION_TEMPLATE } from '../messaging/templates';
import { uuidToBin } from '../common/utils/uuid.util';
import { AccountDeletionService, DeletionPrincipal } from './account-deletion.service';
import { AccountService } from './account.service';
import { FakePrisma } from './testing/fake-prisma';
import { DELETED_USER_NAME, UNUSABLE_PASSWORD_HASH } from './deletion-rules';

/**
 * Account deletion, end to end against an in-memory database (docs/64).
 *
 * The claim under test is the product rule: nothing is deleted unless a
 * single-use deletion code went to the verified WhatsApp number and came
 * back — and once it does, the person's identity, contacts and credentials
 * are gone while the records the law requires stay.
 */

const PEPPER = 'test-pepper-at-least-32-characters-long!!';
const NOW = new Date('2026-09-30T12:00:00.000Z');

const id = (n: string) => uuidToBin(`018f0000-0000-7000-8000-${n.padStart(12, '0')}`);
const C1 = id('c001');
const C2 = id('c002');
const OWNER = id('a001');
const EMPLOYEE = id('a002');
const NO_PHONE = id('a003');
const OTHER_OWNER = id('a004');
const STRANGER = id('b001'); // another company's owner
const ROLE_OWNER = id('e001');
const ROLE_EMPLOYEE = id('e002');
const ROLE_OWNER_C2 = id('e003');
const BRANCH = id('d001');
const BRANCH_C2 = id('d002');
const SESSION_OWNER = id('5001');
const SESSION_OWNER_2 = id('5002');
const SESSION_EMPLOYEE = id('5003');
const SESSION_STRANGER = id('5004');
const SUB = id('6001');

function user(over: Record<string, unknown>) {
  return {
    companyId: C1,
    name: 'Somebody',
    login: 'somebody',
    personalId: 'U-XXXXXXXX',
    phone: '+22231234567',
    phoneVerifiedAt: new Date('2026-09-01T00:00:00Z'),
    email: null,
    emailVerifiedAt: null,
    passwordHash: 'hash:secret',
    pinHash: null,
    isActive: true,
    deletedAt: null,
    ...over,
  };
}

function harness(opts: { pepper?: string | null; withOtherOwner?: boolean; whatsappOff?: boolean } = {}) {
  const prisma = new FakePrisma();
  const channel = new TestWhatsAppChannel();
  /** `WHATSAPP_CHANNEL=disabled` with a pepper set: production while WhatsApp sending is postponed. */
  const sender = opts.whatsappOff ? new DisabledWhatsAppChannel() : channel;
  const audits: Record<string, unknown>[] = [];
  const config = {
    otpPepper: opts.pepper === undefined ? PEPPER : opts.pepper,
    otpTtlSeconds: 300,
    otpMaxAttempts: 5,
    otpResendCooldownSeconds: 60,
    otpMaxSendsPerWindow: 3,
    otpSendWindowSeconds: 900,
    otpMaxSendsPerDay: 10,
  };
  const hashing = {
    verify: async (hash: string, plain: string) => hash === `hash:${plain}`,
    verifyDummy: async () => false,
  };
  const otpAudit = { record: jest.fn(async (p: Record<string, unknown>) => void audits.push(p)) };
  const otp = new OtpService(prisma as never, config as never, otpAudit as never, sender);
  const service = new AccountDeletionService(prisma as never, hashing as never, otp, sender);
  const account = new AccountService(prisma as never, hashing as never, otp, service);

  prisma.seed('company', { id: C1, name: 'Boutique Un', isActive: true, closedAt: null, publicPhone: '+22200000001', logoRef: 'logo', isDiscoverable: true });
  prisma.seed('company', { id: C2, name: 'Boutique Deux', isActive: true, closedAt: null, publicPhone: null, logoRef: null, isDiscoverable: false });
  prisma.seed('role', { id: ROLE_OWNER, companyId: C1, key: 'owner' }, { id: ROLE_EMPLOYEE, companyId: C1, key: 'store_employee' }, { id: ROLE_OWNER_C2, companyId: C2, key: 'owner' });
  prisma.seed('branch', { id: BRANCH, companyId: C1, isActive: true, phone: '+22200000002' }, { id: BRANCH_C2, companyId: C2, isActive: true, phone: null });
  prisma.seed(
    'user',
    { id: OWNER, ...user({ name: 'Aminata Owner', login: 'aminata', passwordHash: 'hash:owner-pw' }) },
    { id: EMPLOYEE, ...user({ name: 'Moussa Employee', login: 'moussa', phone: '+22231234568', passwordHash: 'hash:employee-pw' }) },
    { id: NO_PHONE, ...user({ name: 'Fatou NoPhone', login: 'fatou', phone: '+22231234569', phoneVerifiedAt: null, passwordHash: 'hash:fatou-pw' }) },
    { id: STRANGER, ...user({ companyId: C2, name: 'Other Owner', login: 'other', phone: '+22231234570', passwordHash: 'hash:other-pw' }) },
  );
  if (opts.withOtherOwner) {
    prisma.seed('user', { id: OTHER_OWNER, ...user({ name: 'Second Owner', login: 'second', phone: '+22231234571', passwordHash: 'hash:second-pw' }) });
    prisma.seed('userBranch', { id: id('7009'), companyId: C1, userId: OTHER_OWNER, branchId: BRANCH, roleId: ROLE_OWNER });
  }
  prisma.seed(
    'userBranch',
    { id: id('7001'), companyId: C1, userId: OWNER, branchId: BRANCH, roleId: ROLE_OWNER },
    { id: id('7002'), companyId: C1, userId: EMPLOYEE, branchId: BRANCH, roleId: ROLE_EMPLOYEE },
    { id: id('7003'), companyId: C1, userId: NO_PHONE, branchId: BRANCH, roleId: ROLE_EMPLOYEE },
    { id: id('7004'), companyId: C2, userId: STRANGER, branchId: BRANCH_C2, roleId: ROLE_OWNER_C2 },
  );
  prisma.seed(
    'authSession',
    { id: SESSION_OWNER, companyId: C1, userId: OWNER, revokedAt: null },
    { id: SESSION_OWNER_2, companyId: C1, userId: OWNER, revokedAt: null },
    { id: SESSION_EMPLOYEE, companyId: C1, userId: EMPLOYEE, revokedAt: null },
    { id: SESSION_STRANGER, companyId: C2, userId: STRANGER, revokedAt: null },
  );
  prisma.seed(
    'userDevice',
    { id: id('8001'), companyId: C1, userId: OWNER, revokedAt: null, revokedById: null },
    { id: id('8002'), companyId: C1, userId: EMPLOYEE, revokedAt: null, revokedById: null },
    { id: id('8003'), companyId: C2, userId: STRANGER, revokedAt: null, revokedById: null },
  );
  prisma.seed('syncDevice', { id: id('9001'), companyId: C1, userId: EMPLOYEE, deviceId: 'phone-1' }, { id: id('9002'), companyId: C1, userId: OWNER, deviceId: 'phone-2' });
  prisma.seed('notification', { id: id('9101'), companyId: C1, targetUserId: EMPLOYEE }, { id: id('9102'), companyId: C1, targetUserId: OWNER }, { id: id('9103'), companyId: C2, targetUserId: STRANGER });
  prisma.seed('customer', { id: id('9201'), companyId: C1, name: 'Client A', phone: '+22240000001', notes: 'likes red' }, { id: id('9202'), companyId: C2, name: 'Client B', phone: '+22240000002', notes: null });
  prisma.seed('supplier', { id: id('9301'), companyId: C1, name: 'Fournisseur', phone: '+22250000001', notes: 'net 30' });
  prisma.seed('sale', { id: id('9401'), companyId: C1 }, { id: id('9402'), companyId: C1 }, { id: id('9403'), companyId: C2 });
  prisma.seed('purchase', { id: id('9501'), companyId: C1 });
  prisma.seed('dailyClosing', { id: id('9601'), companyId: C1 });
  prisma.seed('employeeDebtEntry', { id: id('9701'), companyId: C1, userId: EMPLOYEE });
  prisma.seed('subscription', { id: SUB, companyId: C1, status: 'activated', currentPeriodEnd: new Date('2027-01-01T00:00:00Z'), subscribedBranchCount: 1, additionalSeats: 0, version: 3 });
  prisma.seed('registrationAttempt', { id: id('9801'), companyId: C1, ownerName: 'Aminata Owner', email: 'a@example.test', phone: '+22231234567' });
  prisma.seed('ownerInvitation', { id: id('9901'), companyId: C1, userId: OWNER, acceptedAt: null, revokedAt: null });

  const principal = (userId: Buffer, companyId = C1, sessionId = SESSION_OWNER): DeletionPrincipal => ({ userId, companyId, sessionId });
  const lastCode = () => channel.messages.filter((m) => m.template === ACCOUNT_DELETION_TEMPLATE.key).slice(-1)[0]?.variables.code;
  const row = (model: string, key: Buffer) => prisma.rows(model).find((r) => (r.id as Buffer).equals(key))!;

  return { prisma, channel, service, account, otp, audits, principal, lastCode, row };
}

const codeOf = (e: unknown) => (e as HttpException).getResponse() as { code: string; [k: string]: unknown };
const statusOf = (e: unknown) => (e as HttpException).getStatus();

/** `rejects.toSatisfy(predicate)`: the refusal is inspected as a whole — status and code together. */
expect.extend({
  toSatisfy(received: unknown, predicate: (value: unknown) => boolean) {
    const pass = predicate(received);
    const shown =
      received instanceof HttpException ? `${received.getStatus()} ${JSON.stringify(received.getResponse())}` : String(received);
    return { pass, message: () => `expected ${shown} ${pass ? 'not ' : ''}to satisfy the predicate` };
  },
});
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      toSatisfy(predicate: (value: unknown) => boolean): R;
    }
  }
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
});
afterEach(() => {
  jest.useRealTimers();
});

describe('asking to delete', () => {
  it('needs the password again, and says nothing more on a wrong one', async () => {
    const h = harness();
    await expect(h.service.start(h.principal(EMPLOYEE), { password: 'wrong' })).rejects.toSatisfy((e: unknown) => {
      return statusOf(e) === 401 && codeOf(e).code === 'reauthentication_failed';
    });
    expect(h.prisma.rows('accountDeletionRequest')).toHaveLength(0);
    expect(h.channel.messages).toHaveLength(0);
  });

  it('refuses without a verified WhatsApp number, and substitutes nothing', async () => {
    const h = harness();
    await expect(h.service.start(h.principal(NO_PHONE), { password: 'fatou-pw' })).rejects.toSatisfy(
      (e: unknown) => statusOf(e) === 409 && codeOf(e).code === 'whatsapp_number_required',
    );
    expect(h.channel.messages).toHaveLength(0);
    expect(h.prisma.rows('accountDeletionRequest')).toHaveLength(0);
  });

  it('refuses when no code can be issued at all, and changes nothing', async () => {
    const h = harness({ pepper: null });
    await expect(h.service.start(h.principal(EMPLOYEE), { password: 'employee-pw' })).rejects.toSatisfy(
      (e: unknown) => statusOf(e) === 503 && codeOf(e).code === 'deletion_unavailable',
    );
    expect(h.row('user', EMPLOYEE).deletedAt).toBeNull();
  });

  describe('with WhatsApp switched off (a pepper, but no channel that sends)', () => {
    it('refuses a login with a verified number before anything is created — no request, no challenge', async () => {
      const h = harness({ whatsappOff: true });
      await expect(h.service.start(h.principal(EMPLOYEE), { password: 'employee-pw', clientUuid: '018f0000-0000-7000-8000-00000000dddd' })).rejects.toSatisfy(
        (e: unknown) => statusOf(e) === 503 && codeOf(e).code === 'deletion_unavailable',
      );
      expect(h.prisma.rows('accountDeletionRequest')).toHaveLength(0);
      expect(h.prisma.rows('otpChallenge')).toHaveLength(0);
      expect(h.row('user', EMPLOYEE).deletedAt).toBeNull();
    });

    it('tells an email-only login that codes cannot be sent, rather than sending it to verify a number', async () => {
      const h = harness({ whatsappOff: true });
      await expect(h.service.start(h.principal(NO_PHONE), { password: 'fatou-pw' })).rejects.toSatisfy(
        (e: unknown) => statusOf(e) === 503 && codeOf(e).code === 'deletion_unavailable',
      );
      expect(h.prisma.rows('accountDeletionRequest')).toHaveLength(0);
    });

    it('still asks for the password first, and says nothing more on a wrong one', async () => {
      const h = harness({ whatsappOff: true });
      await expect(h.service.start(h.principal(EMPLOYEE), { password: 'wrong' })).rejects.toSatisfy(
        (e: unknown) => statusOf(e) === 401 && codeOf(e).code === 'reauthentication_failed',
      );
    });

    it('refuses to verify a WhatsApp number without writing a challenge, and blames no number', async () => {
      const h = harness({ whatsappOff: true });
      await expect(
        h.account.startPhoneVerification(h.principal(NO_PHONE), { password: 'fatou-pw', phone: '+22231234569' }),
      ).rejects.toSatisfy((e: unknown) => statusOf(e) === 503 && codeOf(e).code === 'verification_unavailable');
      expect(h.prisma.rows('otpChallenge')).toHaveLength(0);
    });
  });

  it('sends a deletion code — not a sign-in code — to the verified number, in the asked language', async () => {
    const h = harness();
    const view = await h.service.start(h.principal(EMPLOYEE), { password: 'employee-pw', language: 'fr', clientUuid: '018f0000-0000-7000-8000-00000000cccc' });

    expect(view.status).toBe('awaiting_code');
    expect(view.kind).toBe('personal_login');
    expect(view.delivered).toBe(true);
    expect(view.deliveryProblem).toBeNull();
    expect(view.destinationMasked).toBe('+222***68');
    expect(view.destinationMasked).not.toContain('31234568');
    expect(view.attemptsRemaining).toBe(5);
    expect(view.codeExpiresAt).toBe(new Date(NOW.getTime() + 300_000).toISOString());

    const sent = h.channel.last!;
    expect(sent.template).toBe(ACCOUNT_DELETION_TEMPLATE.key);
    expect(sent.language).toBe('fr');
    expect(sent.to).toBe('+22231234568');
    expect(sent.variables.code).toMatch(/^\d{6}$/);
    expect(sent.variables.ttlMinutes).toBe('5');

    const challenge = h.prisma.rows('otpChallenge')[0];
    expect(challenge.purpose).toBe('account_deletion');
    expect(JSON.stringify(h.prisma.rows('accountDeletionRequest'))).not.toContain(sent.variables.code);
  });

  it('the last active Owner closes the business; an Owner with another Owner deletes a login', async () => {
    const alone = harness();
    expect((await alone.service.start(alone.principal(OWNER), { password: 'owner-pw' })).kind).toBe('company_closure');

    const shared = harness({ withOtherOwner: true });
    expect((await shared.service.start(shared.principal(OWNER), { password: 'owner-pw' })).kind).toBe('personal_login');
  });

  it('keeps one open request per person: a second ask returns it and sends no second code', async () => {
    const h = harness();
    const first = await h.service.start(h.principal(EMPLOYEE), { password: 'employee-pw' });
    const second = await h.service.start(h.principal(EMPLOYEE), { password: 'employee-pw' });
    expect(second.id).toBe(first.id);
    expect(h.channel.messages).toHaveLength(1);
    expect(h.prisma.rows('accountDeletionRequest')).toHaveLength(1);
  });

  it('keeps the account intact and says so when the provider does not accept the message', async () => {
    const h = harness();
    h.channel.nextResult = { status: 'failed', reason: 'temporary', detail: 'simulated outage', provider: 'test' };
    const view = await h.service.start(h.principal(EMPLOYEE), { password: 'employee-pw' });

    expect(view.status).toBe('awaiting_code');
    expect(view.delivered).toBe(false);
    expect(view.deliveryProblem).toBe('temporary_failure');
    expect(view.codeSentAt).toBeNull();
    expect(h.row('user', EMPLOYEE).deletedAt).toBeNull();
    expect(h.row('user', EMPLOYEE).isActive).toBe(true);
  });

  it('is visible on the person account afterwards', async () => {
    const h = harness();
    expect(await h.service.current(h.principal(EMPLOYEE))).toBeNull();
    await h.service.start(h.principal(EMPLOYEE), { password: 'employee-pw' });
    expect((await h.service.current(h.principal(EMPLOYEE)))?.status).toBe('awaiting_code');
    // Somebody else, even in the same company, sees nothing of it.
    expect(await h.service.current(h.principal(OWNER))).toBeNull();
  });
});

describe('the code', () => {
  it('a wrong code is refused with the attempts left, and nothing is deleted', async () => {
    const h = harness();
    await h.service.start(h.principal(EMPLOYEE), { password: 'employee-pw' });
    const wrong = h.lastCode() === '000000' ? '111111' : '000000';

    await expect(h.service.confirm(h.principal(EMPLOYEE), wrong)).rejects.toSatisfy(
      (e: unknown) => statusOf(e) === 400 && codeOf(e).code === 'invalid_code' && codeOf(e).attemptsRemaining === 4,
    );
    expect(h.row('user', EMPLOYEE).deletedAt).toBeNull();
    expect((await h.service.current(h.principal(EMPLOYEE)))?.status).toBe('awaiting_code');
  });

  it('too many wrong codes end the request; the password is needed again', async () => {
    const h = harness();
    await h.service.start(h.principal(EMPLOYEE), { password: 'employee-pw' });
    const wrong = h.lastCode() === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) {
      await expect(h.service.confirm(h.principal(EMPLOYEE), wrong)).rejects.toSatisfy((e: unknown) => codeOf(e).code === 'invalid_code');
    }
    await expect(h.service.confirm(h.principal(EMPLOYEE), wrong)).rejects.toSatisfy(
      (e: unknown) => statusOf(e) === 409 && codeOf(e).code === 'too_many_attempts',
    );
    expect((await h.service.current(h.principal(EMPLOYEE)))?.status).toBe('failed');
    // The right code no longer works either: the request is over.
    await expect(h.service.confirm(h.principal(EMPLOYEE), h.lastCode()!)).rejects.toSatisfy(
      (e: unknown) => statusOf(e) === 404 && codeOf(e).code === 'no_open_request',
    );
    expect(h.row('user', EMPLOYEE).deletedAt).toBeNull();
  });

  it('an expired code is refused; a resent one works', async () => {
    const h = harness();
    await h.service.start(h.principal(EMPLOYEE), { password: 'employee-pw' });
    const stale = h.lastCode()!;
    jest.setSystemTime(new Date(NOW.getTime() + 301_000));

    await expect(h.service.confirm(h.principal(EMPLOYEE), stale)).rejects.toSatisfy(
      (e: unknown) => statusOf(e) === 410 && codeOf(e).code === 'code_expired',
    );

    const resent = await h.service.resend(h.principal(EMPLOYEE));
    expect(resent.status).toBe('awaiting_code');
    expect(h.channel.messages).toHaveLength(2);
    const fresh = h.lastCode()!;
    // The old code is dead even if it happened to equal the new one's digits by chance — different challenge.
    const done = await h.service.confirm(h.principal(EMPLOYEE), fresh);
    expect(done.status).toBe('completed');
  });

  it('a resend within the cooldown is refused, with when to try again', async () => {
    const h = harness();
    await h.service.start(h.principal(EMPLOYEE), { password: 'employee-pw' });
    await expect(h.service.resend(h.principal(EMPLOYEE))).rejects.toSatisfy(
      (e: unknown) => statusOf(e) === 429 && codeOf(e).code === 'too_many_codes' && typeof codeOf(e).resendAvailableAt === 'string',
    );
    expect(h.channel.messages).toHaveLength(1);
  });

  it('a resend after the cooldown replaces the code; the old one stops working', async () => {
    const h = harness();
    await h.service.start(h.principal(EMPLOYEE), { password: 'employee-pw' });
    const old = h.lastCode()!;
    jest.setSystemTime(new Date(NOW.getTime() + 61_000));
    await h.service.resend(h.principal(EMPLOYEE));
    expect(h.channel.messages).toHaveLength(2);
    const live = h.prisma.rows('otpChallenge').filter((c) => c.status === 'pending');
    expect(live).toHaveLength(1);
    if (old !== h.lastCode()) {
      await expect(h.service.confirm(h.principal(EMPLOYEE), old)).rejects.toSatisfy((e: unknown) => codeOf(e).code === 'invalid_code');
    }
    expect((await h.service.confirm(h.principal(EMPLOYEE), h.lastCode()!)).status).toBe('completed');
  });

  it("a code that went to a number the person no longer holds is refused", async () => {
    const h = harness();
    await h.service.start(h.principal(EMPLOYEE), { password: 'employee-pw' });
    const code = h.lastCode()!;
    // The number changed under the request (an Owner edited it, say): the proof no longer matches.
    h.row('user', EMPLOYEE).phone = '+22231239999';
    h.row('user', EMPLOYEE).phoneVerifiedAt = null;

    await expect(h.service.confirm(h.principal(EMPLOYEE), code)).rejects.toSatisfy(
      (e: unknown) => statusOf(e) === 409 && codeOf(e).code === 'number_changed',
    );
    expect((await h.service.current(h.principal(EMPLOYEE)))?.status).toBe('failed');
    expect(h.row('user', EMPLOYEE).deletedAt).toBeNull();
  });

  it('a request older than thirty minutes needs the password again', async () => {
    const h = harness();
    await h.service.start(h.principal(EMPLOYEE), { password: 'employee-pw' });
    const code = h.lastCode()!;
    jest.setSystemTime(new Date(NOW.getTime() + 31 * 60_000));
    await expect(h.service.confirm(h.principal(EMPLOYEE), code)).rejects.toSatisfy(
      (e: unknown) => statusOf(e) === 410 && codeOf(e).code === 'request_expired',
    );
    expect(h.row('user', EMPLOYEE).deletedAt).toBeNull();
  });

  it("somebody else's code — another company, another person — never confirms this request", async () => {
    const h = harness();
    await h.service.start(h.principal(EMPLOYEE), { password: 'employee-pw' });
    const employeeCode = h.lastCode()!;
    await h.service.start(h.principal(STRANGER, C2, SESSION_STRANGER), { password: 'other-pw' });
    const strangerCode = h.lastCode()!;

    // The stranger tries the employee's code against their own request: it is not their challenge's code.
    if (strangerCode !== employeeCode) {
      await expect(h.service.confirm(h.principal(STRANGER, C2, SESSION_STRANGER), employeeCode)).rejects.toSatisfy(
        (e: unknown) => codeOf(e).code === 'invalid_code',
      );
    }
    // A forged principal naming the employee's user id under the wrong company finds no request at all.
    await expect(h.service.confirm(h.principal(EMPLOYEE, C2, SESSION_STRANGER), employeeCode)).rejects.toSatisfy(
      (e: unknown) => statusOf(e) === 404 && codeOf(e).code === 'no_open_request',
    );
    expect(h.row('user', EMPLOYEE).deletedAt).toBeNull();
    expect(h.row('user', STRANGER).deletedAt).toBeNull();
  });

  it('a code issued for another purpose never deletes, even when it verifies', async () => {
    const h = harness();
    await h.service.start(h.principal(EMPLOYEE), { password: 'employee-pw' });
    // Swap the request's challenge for a phone-verification challenge of the same person.
    const phoneChallenge = await h.otp.request({ companyId: C1, userId: EMPLOYEE, purpose: 'phone_verification', destination: '+22231234568', candidatePhone: '+22231234568' });
    if (!phoneChallenge.ok) throw new Error('setup');
    const request = h.prisma.rows('accountDeletionRequest')[0];
    request.challengeId = uuidToBin(phoneChallenge.challenge.challengeId);
    const phoneCode = h.channel.last!.variables.code;

    await expect(h.service.confirm(h.principal(EMPLOYEE), phoneCode)).rejects.toSatisfy(
      (e: unknown) => statusOf(e) === 409 && codeOf(e).code === 'code_not_active',
    );
    expect(request.status).toBe('failed');
    expect(h.row('user', EMPLOYEE).deletedAt).toBeNull();
  });
});

describe('the executor insists on proof', () => {
  it('refuses a request that was never confirmed, whatever its row says', async () => {
    const h = harness();
    await h.service.start(h.principal(EMPLOYEE), { password: 'employee-pw' });
    const request = h.prisma.rows('accountDeletionRequest')[0];

    await expect(h.service.execute(request.id as Buffer)).rejects.toSatisfy(
      (e: unknown) => statusOf(e) === 503 && codeOf(e).code === 'deletion_failed',
    );
    expect(h.row('user', EMPLOYEE).deletedAt).toBeNull();
    expect(h.row('user', EMPLOYEE).name).toBe('Moussa Employee');
  });

  it('refuses a status flipped to confirmed by hand when the code never came back', async () => {
    // The administrator-tool / background-job bypass: a row edited to `confirmed`
    // with a challenge still pending. The executor re-reads the challenge and stops.
    const h = harness();
    await h.service.start(h.principal(EMPLOYEE), { password: 'employee-pw' });
    const request = h.prisma.rows('accountDeletionRequest')[0];
    request.status = 'confirmed';
    request.confirmedAt = NOW;

    await expect(h.service.execute(request.id as Buffer)).rejects.toSatisfy((e: unknown) => codeOf(e).code === 'deletion_failed');
    expect(request.status).toBe('failed');
    expect(request.failureDetail).toBe('challenge was not verified');
    expect(h.row('user', EMPLOYEE).deletedAt).toBeNull();
    expect(h.row('authSession', SESSION_EMPLOYEE).revokedAt).toBeNull();
  });

  it("refuses a confirmed request whose challenge belongs to somebody else", async () => {
    const h = harness();
    await h.service.start(h.principal(EMPLOYEE), { password: 'employee-pw' });
    await h.service.start(h.principal(STRANGER, C2, SESSION_STRANGER), { password: 'other-pw' });
    // The stranger genuinely verifies THEIR code…
    const strangerCode = h.lastCode()!;
    const strangerRequest = h.prisma.rows('accountDeletionRequest')[1];
    // …but somebody wires the stranger's verified challenge onto the employee's request.
    const verified = await h.otp.verify({ companyId: C2, userId: STRANGER, challengeId: strangerRequest.challengeId as Buffer, code: strangerCode });
    expect(verified.ok).toBe(true);
    const employeeRequest = h.prisma.rows('accountDeletionRequest')[0];
    employeeRequest.status = 'confirmed';
    employeeRequest.challengeId = strangerRequest.challengeId;

    await expect(h.service.execute(employeeRequest.id as Buffer)).rejects.toSatisfy((e: unknown) => codeOf(e).code === 'deletion_failed');
    expect(employeeRequest.failureDetail).toBe('challenge belongs to another company');
    expect(h.row('user', EMPLOYEE).deletedAt).toBeNull();
  });

  it('rolls everything back when the deletion itself fails, and says so', async () => {
    const h = harness();
    await h.service.start(h.principal(EMPLOYEE), { password: 'employee-pw' });
    const code = h.lastCode()!;
    // Make the last step blow up: the audit table refuses.
    const auditLog = (h.prisma as never as { auditLog: { create: unknown } }).auditLog;
    const real = auditLog.create as (...a: unknown[]) => unknown;
    (h.prisma as never as { tables: Map<string, unknown[]> }).tables.set('auditLog', []);
    jest.spyOn(h.prisma as never as { delegate: (m: string) => unknown }, 'delegate' as never);
    const originalDelegate = (h.prisma as never as { delegate: (m: string) => unknown }).delegate.bind(h.prisma);
    (h.prisma as never as { delegate: (m: string) => unknown }).delegate = (m: string) => {
      const d = originalDelegate(m) as Record<string, unknown>;
      if (m === 'auditLog') return { ...d, create: async () => { throw new Error('audit table is read-only tonight'); } };
      return d;
    };
    void real;

    await expect(h.service.confirm(h.principal(EMPLOYEE), code)).rejects.toSatisfy(
      (e: unknown) => statusOf(e) === 503 && codeOf(e).code === 'deletion_failed',
    );
    const request = h.prisma.rows('accountDeletionRequest')[0];
    expect(request.status).toBe('failed');
    expect(request.failureDetail).toBe('The deletion could not be completed; nothing was changed');
    expect(h.row('user', EMPLOYEE).deletedAt).toBeNull();
    expect(h.row('user', EMPLOYEE).name).toBe('Moussa Employee');
    expect(h.row('authSession', SESSION_EMPLOYEE).revokedAt).toBeNull();
  });
});

describe('deleting a login', () => {
  it('removes the person and every credential, keeps the records, tells them', async () => {
    const h = harness();
    await h.service.start(h.principal(EMPLOYEE), { password: 'employee-pw', language: 'fr' });
    const view = await h.service.confirm(h.principal(EMPLOYEE), h.lastCode()!);

    expect(view.status).toBe('completed');
    expect(view.completedAt).not.toBeNull();
    expect(view.retained).toMatchObject({ kind: 'personal_login', loginsDeleted: 1, sessionsRevoked: 1, devicesRevoked: 1, retained: { ledgerEntries: 1 } });

    const u = h.row('user', EMPLOYEE);
    expect(u.name).toBe(DELETED_USER_NAME);
    expect(u.login).toBe(`deleted-${EMPLOYEE.toString('hex')}`);
    expect(u.phone).toBeNull();
    expect(u.phoneVerifiedAt).toBeNull();
    expect(u.passwordHash).toBe(UNUSABLE_PASSWORD_HASH);
    expect(u.isActive).toBe(false);
    expect(u.deletedAt).not.toBeNull();
    expect(h.row('authSession', SESSION_EMPLOYEE).revokedAt).not.toBeNull();
    expect(h.row('userDevice', id('8002')).revokedAt).not.toBeNull();
    expect(h.prisma.rows('syncDevice').some((r) => (r.userId as Buffer).equals(EMPLOYEE))).toBe(false);
    expect(h.prisma.rows('notification').some((r) => (r.targetUserId as Buffer).equals(EMPLOYEE))).toBe(false);

    // Kept: the ledger row that names them, the sales, the company, everybody else.
    expect(h.prisma.rows('employeeDebtEntry')).toHaveLength(1);
    expect(h.prisma.rows('sale')).toHaveLength(3);
    expect(h.row('company', C1).isActive).toBe(true);
    expect(h.row('user', OWNER).name).toBe('Aminata Owner');
    expect(h.row('authSession', SESSION_OWNER).revokedAt).toBeNull();

    // The audit trail says what happened, without a name, a number or the code.
    const audit = h.prisma.rows('auditLog').find((a) => a.entityType === 'AccountDeletionRequest' && a.action === 'delete')!;
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit)).not.toContain('31234568');
    expect(JSON.stringify(audit)).not.toContain('Moussa');

    // Told, in their language, what was deleted.
    const notice = h.channel.messages.find((m) => m.template === ACCOUNT_DELETED_TEMPLATE.key)!;
    expect(notice.to).toBe('+22231234568');
    expect(notice.language).toBe('fr');
    expect(notice.variables.what).toBe('votre identifiant');
  });

  it('a retried confirmation after a lost response answers with the final state', async () => {
    const h = harness();
    await h.service.start(h.principal(EMPLOYEE), { password: 'employee-pw' });
    const code = h.lastCode()!;
    const first = await h.service.confirm(h.principal(EMPLOYEE), code);
    const again = await h.service.confirm(h.principal(EMPLOYEE), code);
    expect(first.status).toBe('completed');
    expect(again.status).toBe('completed');
    expect(again.id).toBe(first.id);
    expect(h.channel.messages.filter((m) => m.template === ACCOUNT_DELETED_TEMPLATE.key)).toHaveLength(1);
  });

  it('two confirmations racing produce exactly one deletion', async () => {
    const h = harness();
    await h.service.start(h.principal(EMPLOYEE), { password: 'employee-pw' });
    const code = h.lastCode()!;
    const [a, b] = await Promise.all([
      h.service.confirm(h.principal(EMPLOYEE), code),
      h.service.confirm(h.principal(EMPLOYEE), code),
    ]);
    // One of them carried the deletion out; the other answered with the request as it stood at that instant.
    expect([a.status, b.status]).toContain('completed');
    expect(a.id).toBe(b.id);
    expect(h.prisma.rows('accountDeletionRequest')).toHaveLength(1);
    expect(h.prisma.rows('accountDeletionRequest')[0].status).toBe('completed');
    expect(h.prisma.rows('auditLog').filter((r) => r.entityType === 'AccountDeletionRequest' && r.action === 'delete')).toHaveLength(1);
    expect(h.prisma.rows('otpChallenge').filter((c) => c.status === 'verified')).toHaveLength(1);
  });
});

describe('closing the business', () => {
  it('clears the numbers its payments came from (D151) and keeps every payment; another business keeps its own', async () => {
    const h = harness();
    h.prisma.seed(
      'payment',
      { id: id('9601'), companyId: C1, method: 'mobile', amount: 300, payerNumber: '+22236123456' },
      { id: id('9602'), companyId: C1, method: 'cash', amount: 599, payerNumber: null },
      { id: id('9603'), companyId: C2, method: 'mobile', amount: 100, payerNumber: '+22245000000' },
    );
    await h.service.start(h.principal(OWNER), { password: 'owner-pw', language: 'ar' });
    const view = await h.service.confirm(h.principal(OWNER), h.lastCode()!);
    expect(view.status).toBe('completed');

    expect(h.row('payment', id('9601'))).toMatchObject({ method: 'mobile', amount: 300, payerNumber: null });
    expect(h.row('payment', id('9602'))).toMatchObject({ method: 'cash', amount: 599, payerNumber: null });
    expect(h.row('payment', id('9603'))).toMatchObject({ payerNumber: '+22245000000' });
    expect(h.prisma.rows('payment')).toHaveLength(3);
  });

  it('removes every person, contact and credential in it, closes it, and keeps the books', async () => {
    const h = harness();
    await h.service.start(h.principal(OWNER), { password: 'owner-pw', language: 'ar' });
    const view = await h.service.confirm(h.principal(OWNER), h.lastCode()!);

    expect(view.kind).toBe('company_closure');
    expect(view.status).toBe('completed');
    expect(view.retained).toMatchObject({
      kind: 'company_closure',
      loginsDeleted: 3,
      sessionsRevoked: 3,
      devicesRevoked: 2,
      customersDeidentified: 1,
      suppliersDeidentified: 1,
      retained: { sales: 2, purchases: 1, closings: 1, subscriptionEvents: 1 },
    });

    for (const who of [OWNER, EMPLOYEE, NO_PHONE]) {
      const u = h.row('user', who);
      expect(u.name).toBe(DELETED_USER_NAME);
      expect(u.phone).toBeNull();
      expect(u.email).toBeNull();
      expect(u.isActive).toBe(false);
      expect(u.passwordHash).toBe(UNUSABLE_PASSWORD_HASH);
    }
    for (const s of [SESSION_OWNER, SESSION_OWNER_2, SESSION_EMPLOYEE]) expect(h.row('authSession', s).revokedAt).not.toBeNull();

    const company = h.row('company', C1);
    expect(company.isActive).toBe(false);
    expect(company.closedAt).not.toBeNull();
    expect(company.publicPhone).toBeNull();
    expect(company.logoRef).toBeNull();
    expect(company.isDiscoverable).toBe(false);
    expect(company.name).toBe('Boutique Un'); // on every retained invoice

    expect(h.row('customer', id('9201'))).toMatchObject({ name: null, phone: null, notes: null });
    expect(h.row('supplier', id('9301'))).toMatchObject({ name: 'Fournisseur', phone: null, notes: null });
    expect(h.row('branch', BRANCH).isActive).toBe(false);
    expect(h.row('registrationAttempt', id('9801'))).toMatchObject({ ownerName: DELETED_USER_NAME, email: null, phone: null });
    expect(h.row('ownerInvitation', id('9901')).revokedAt).not.toBeNull();
    expect(h.row('subscription', SUB)).toMatchObject({ status: 'cancelled', version: 4 });
    expect(h.prisma.rows('subscriptionEvent')).toHaveLength(1);
    expect(h.prisma.rows('subscriptionEvent')[0]).toMatchObject({ kind: 'cancelled', actor: 'owner:account-deletion' });

    // The books: untouched.
    expect(h.prisma.rows('sale').filter((s) => (s.companyId as Buffer).equals(C1))).toHaveLength(2);
    expect(h.prisma.rows('purchase')).toHaveLength(1);
    expect(h.prisma.rows('dailyClosing')).toHaveLength(1);

    // The other business: untouched.
    expect(h.row('company', C2).isActive).toBe(true);
    expect(h.row('user', STRANGER).name).toBe('Other Owner');
    expect(h.row('authSession', SESSION_STRANGER).revokedAt).toBeNull();
    expect(h.row('customer', id('9202')).name).toBe('Client B');
    expect(h.prisma.rows('notification').filter((n) => (n.companyId as Buffer).equals(C2))).toHaveLength(1);

    const notice = h.channel.messages.find((m) => m.template === ACCOUNT_DELETED_TEMPLATE.key)!;
    expect(notice.language).toBe('ar');
    expect(notice.variables.what).toBe('متجرك وجميع حسابات الدخول فيه');
  });
});

describe('withdrawing', () => {
  it('cancels the request and its code; a later start begins afresh', async () => {
    const h = harness();
    await h.service.start(h.principal(EMPLOYEE), { password: 'employee-pw' });
    const code = h.lastCode()!;
    const cancelled = await h.service.cancel(h.principal(EMPLOYEE));
    expect(cancelled?.status).toBe('cancelled');
    expect(h.prisma.rows('otpChallenge')[0].status).toBe('cancelled');

    await expect(h.service.confirm(h.principal(EMPLOYEE), code)).rejects.toSatisfy((e: unknown) => codeOf(e).code === 'no_open_request');
    // Repeating is harmless.
    expect((await h.service.cancel(h.principal(EMPLOYEE)))?.status).toBe('cancelled');

    const fresh = await h.service.start(h.principal(EMPLOYEE), { password: 'employee-pw' });
    expect(fresh.id).not.toBe(cancelled?.id);
    expect(h.prisma.rows('accountDeletionRequest')).toHaveLength(2);
  });
});
