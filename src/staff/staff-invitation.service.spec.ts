import { readFileSync } from 'node:fs';
import { ConflictException } from '@nestjs/common';
import { StaffInvitationService } from './staff-invitation.service';
import { newUuidV7Bin, uuidToBin, binToUuid } from '../common/utils/uuid.util';
import { WhatsAppRecords } from '../messaging/whatsapp-records';
import { WHATSAPP_CONSENT_VERSION } from '../messaging/whatsapp-consent';
import { recipientHash } from '../messaging/recipient-hash';
import { fakeMessagingPrisma } from '../messaging/__testing__/fake-messaging-prisma';
import { normaliseReference, referenceHash } from './invitation-reference';

/**
 * Employee accounts and their invitations (docs/21, 2026-10-05; D213, D214).
 *
 * Creating an account is not the account being usable: it is created pending, with an unguessable password, and the
 * Owner's act sends nothing — no WhatsApp, no email. It issues an invitation whose reference is shown once and stored
 * only as a keyed hash. The employee opens it, types their number, accepts the operational WhatsApp consent and asks
 * for the code themselves; the code activates the consent, uses the invitation and activates the account together.
 * Every unusable reference answers the same way. Cancelling or reinviting ends the invitation and its pending consent.
 */

const COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c001');
const OWNER = uuidToBin('018f0000-0000-7000-8000-00000000a001');
const COMPANY_B = uuidToBin('018f0000-0000-7000-8000-00000000c002');
const OWNER_B = uuidToBin('018f0000-0000-7000-8000-00000000a002');
const MAIN = uuidToBin('018f0000-0000-7000-8000-00000000b001');
const ROLE = uuidToBin('018f0000-0000-7000-8000-00000000d001');
const NOW = new Date('2026-10-05T10:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const KEY = 'test-messaging-hash-key-of-32-characters!';
const INVITATION_KEY = 'a-staff-invitation-key-for-tests-32+chars';
const FATIMA = '+22233445566';

function makeWorld(
  opts: {
    canDeliver?: (channel: string) => boolean;
    /** What activation inside the confirmation's transaction answers. */
    activateInTx?: { activated: boolean; pending: string[] };
    /** What the service's own activation answers afterwards (it prices a missing seat). */
    activation?: { activated: boolean; pending: string[] };
    covered?: boolean;
    invitationKey?: string | null;
  } = {},
) {
  const owner = (id: Buffer, companyId: Buffer, email: string) => ({
    id,
    companyId,
    name: 'Owner',
    email,
    phone: null,
    deletedAt: null,
    invitedAt: null,
    activatedAt: NOW,
    isActive: true,
    emailVerifiedAt: NOW,
    phoneVerifiedAt: null,
  });
  const users: any[] = [owner(OWNER, COMPANY, 'owner@shop.test'), owner(OWNER_B, COMPANY_B, 'owner@other.test')];
  const companies = new Map([
    [binToUuid(COMPANY), 'Shop'],
    [binToUuid(COMPANY_B), 'Other shop'],
  ]);
  const userBranches: any[] = [];
  const invitations: any[] = [];
  const audits: any[] = [];
  const started: string[] = [];
  const challenges = new Map<string, { id: Buffer; code: string; consumedAt: Date | null }>();
  const hashed: string[] = [];
  const inTx: Buffer[] = [];
  const activations: Buffer[] = [];
  const seatRequests: any[] = [];
  const withdrawn: Buffer[] = [];
  let seatsFull: string[] = [];
  let actor = { companyId: COMPANY, userId: OWNER };

  const matchesUser = (u: any, where: any): boolean => {
    if (where.id && !u.id.equals(where.id)) return false;
    if (where.companyId && !u.companyId.equals(where.companyId)) return false;
    if ('deletedAt' in where && where.deletedAt === null && u.deletedAt !== null) return false;
    if (where.OR && !where.OR.some((o: any) => (o.email && u.email === o.email) || (o.phone && u.phone === o.phone)))
      return false;
    return true;
  };
  const hydrate = (u: any) => ({
    ...u,
    company: { name: companies.get(binToUuid(u.companyId)) },
    userBranches: userBranches
      .filter((ub) => ub.userId.equals(u.id))
      .map(() => ({ branch: { id: MAIN, name: 'Main' }, role: { key: 'store_employee' } })),
    seatAllocations: seatRequests.filter((r) => r.userId?.equals(u.id)).map((r) => ({ branchId: r.branchId, status: 'pending_payment' })),
  });
  const invitationWith = (row: any) =>
    row && { ...row, company: { name: companies.get(binToUuid(row.companyId)) }, user: users.find((u) => u.id.equals(row.userId)) };
  const live = (i: any) => i.usedAt === null && i.revokedAt === null;

  const db = {
    user: {
      findUniqueOrThrow: async ({ where }: any) => hydrate(users.find((u) => u.id.equals(where.id))),
      findFirst: async ({ where }: any) => {
        const u = users.find((x) => matchesUser(x, where));
        return u ? hydrate(u) : null;
      },
      create: async ({ data }: any) => {
        hashed.push(data.passwordHash);
        users.push({ ...data, emailVerifiedAt: null, phoneVerifiedAt: null, deletedAt: null });
        return data;
      },
      update: async ({ where, data }: any) => Object.assign(users.find((x) => x.id.equals(where.id)), data),
    },
    branch: {
      findMany: async ({ where }: any) => (where.id.in.some((id: Buffer) => id.equals(MAIN)) ? [{ id: MAIN, name: 'Main' }] : []),
    },
    role: { findFirst: async () => ({ id: ROLE }) },
    userBranch: { create: async ({ data }: any) => (userBranches.push(data), data) },
    seatAllocation: { findMany: async () => seatRequests.map((r) => ({ id: r.id })) },
    contactVerification: {
      updateMany: async ({ where }: any) => {
        const c = [...challenges.values()].find((x) => x.id.equals(where.id) && x.consumedAt === null);
        if (c) c.consumedAt = NOW;
        return { count: c ? 1 : 0 };
      },
    },
    // 0101 as the database holds it: a UNIQUE hash, one live invitation per person, an ended one never changed.
    staffInvitation: {
      create: async ({ data }: any) => {
        if (invitations.some((i) => i.tokenHash === data.tokenHash)) throw new Error('ux_staff_invitations_token');
        if (invitations.some((i) => live(i) && i.userId.equals(data.userId))) throw new Error('ux_staff_invitations_live');
        const row = { pendingConsentId: null, usedAt: null, revokedAt: null, revokedReason: null, ...data };
        invitations.push(row);
        return row;
      },
      findUnique: async ({ where }: any) =>
        invitationWith(invitations.find((i) => (where.id ? i.id.equals(where.id) : i.tokenHash === where.tokenHash))) ?? null,
      update: async ({ where, data }: any) => {
        const row = invitations.find((i) => i.id.equals(where.id));
        if (!live(row)) throw new Error('staff_invitations: an ended invitation is never changed');
        return Object.assign(row, data);
      },
    },
  };
  // The consent records on the same database: the invitation, the consent and the account commit together.
  const messaging = fakeMessagingPrisma();
  // The locking reads, answered as the rows stand now (a locking read sees the latest commit).
  const queryRaw = async (q: { sql: string; values: unknown[] }) => {
    const [first, second] = q.values as Buffer[];
    if (/FROM staff_invitations WHERE id = \? FOR UPDATE/.test(q.sql)) {
      const r = invitations.find((i) => i.id.equals(first));
      return r ? [{ used_at: r.usedAt, revoked_at: r.revokedAt, expires_at: r.expiresAt, pending_consent_id: r.pendingConsentId }] : [];
    }
    if (/FROM staff_invitations WHERE user_id = \? AND company_id = \?/.test(q.sql)) {
      return invitations.filter((i) => i.userId.equals(first) && i.companyId.equals(second) && live(i)).map((i) => ({ id: i.id, pending_consent_id: i.pendingConsentId }));
    }
    if (/FROM users WHERE id = \? FOR UPDATE/.test(q.sql)) {
      const u = users.find((x) => x.id.equals(first));
      return u ? [{ activated_at: u.activatedAt, deleted_at: u.deletedAt }] : [];
    }
    return [];
  };
  Object.assign(db, { whatsAppConsent: messaging.whatsAppConsent, whatsAppContact: messaging.whatsAppContact, auditLog: messaging.auditLog, $queryRaw: queryRaw });
  const records = new WhatsAppRecords(messaging as never, { hash: (n: string) => recipientHash(n, KEY) } as never);
  const prisma = { ...db, $transaction: async (fn: (t: typeof db) => Promise<unknown>) => fn(db) };
  const tenant = { companyId: () => actor.companyId, requireUserId: () => actor.userId };
  const audit = { recordTx: async (_tx: unknown, e: unknown) => void audits.push(e) };
  const hashing = { hash: async (s: string) => `hash(${s})` };
  const verification = {
    start: async (destination: string) => {
      started.push(destination);
      challenges.set(destination, { id: newUuidV7Bin(), code: '123456', consumedAt: null });
      return { delivery: 'outbox' as const };
    },
    latestChallengeFor: async (destination: string) => {
      const c = challenges.get(destination);
      return c && c.consumedAt === null ? c.id : null;
    },
    confirmChallenge: async (id: Buffer, code: string) => {
      const c = [...challenges.values()].find((x) => x.id.equals(id));
      if (!c || c.consumedAt) return 'gone';
      return c.code === code ? 'ok' : 'wrong';
    },
  };
  const delivery = { canDeliver: opts.canDeliver ?? (() => true) };
  const entitlement = {
    maySeat: async () => ({ allowed: seatsFull.length === 0, full: seatsFull, seatsUsed: 0, seatLimit: 1, stores: [] }),
  };
  const activation = {
    pendingFor: async () => ({ activated: false, alreadyActive: false, pending: ['phone_verification'] }),
    activateInTx: async (_tx: unknown, userId: Buffer) => {
      inTx.push(userId);
      return { alreadyActive: false, ...(opts.activateInTx ?? { activated: true, pending: [] }) };
    },
    tryActivate: async (userId: Buffer) => {
      activations.push(userId);
      return { alreadyActive: false, ...(opts.activation ?? { activated: false, pending: ['seat_payment'] }) };
    },
    coveredByScheduledSeat: async () => opts.covered ?? false,
  };
  const allocations = {
    requestSeat: async (_c: Buffer, input: any) => {
      seatRequests.push({ id: newUuidV7Bin(), ...input });
      return { created: true };
    },
    withdraw: async (_c: Buffer, id: Buffer) => void withdrawn.push(id),
  };
  const config = { staffInvitationKey: opts.invitationKey === undefined ? INVITATION_KEY : opts.invitationKey };
  const service = new StaffInvitationService(
    prisma as never,
    tenant as never,
    audit as never,
    hashing as never,
    verification as never,
    delivery as never,
    entitlement as never,
    activation as never,
    allocations as never,
    config as never,
    records,
  );
  return {
    service,
    records,
    consents: messaging.whatsAppConsent.rows,
    consentAudits: messaging.auditLog.rows,
    users,
    invitations,
    audits,
    started,
    hashed,
    inTx,
    activations,
    seatRequests,
    withdrawn,
    setSeatsFull: (ids: string[]) => void (seatsFull = ids),
    actAs: (companyId: Buffer, userId: Buffer) => void (actor = { companyId, userId }),
    person: (name: string, companyId = COMPANY) => users.find((u) => u.name === name && u.companyId.equals(companyId))!,
  };
}

type World = ReturnType<typeof makeWorld>;

const INVITE = { name: 'Fatima', phone: '+222 33 44 55 66', branchIds: [binToUuid(MAIN)], role: 'store_employee' as const };

/** The Owner adds Fatima; the reference shown once. */
async function invite(w: World, extra: Partial<typeof INVITE & { email: string }> = {}): Promise<{ id: string; reference: string }> {
  const r = await w.service.invite({ ...INVITE, ...extra });
  return { id: r.user.id, reference: r.invitation!.reference };
}

/** The employee, on their own phone: types the number, ticks the consent and asks for the code. */
const ask = (w: World, reference: string, number = FATIMA, locale: 'en' | 'fr' | 'ar' = 'fr') =>
  w.service.requestCode(reference, number, locale, { version: WHATSAPP_CONSENT_VERSION, locale }, '198.51.100.7');

const unavailable = { response: { code: 'invitation_unavailable' } };

describe('the Owner creates an account', () => {
  it('pending and inactive, with a password nobody knows — and nothing sent, by WhatsApp or email: an invitation only', async () => {
    const w = makeWorld();
    const r = await w.service.invite({ ...INVITE, email: 'Fatima@Shop.test' });
    expect(r.created).toBe(true);
    expect(r.user.status).toBe('pending');
    const row = w.person('Fatima');
    expect(row).toMatchObject({ isActive: false, activatedAt: null, phone: FATIMA, email: 'fatima@shop.test' });
    expect(row.invitedAt).toBeInstanceOf(Date);
    expect(w.hashed[0]).toMatch(/^hash\(/);
    // No message of any kind, and no consent: Fatima has agreed to nothing.
    expect(w.started).toEqual([]);
    expect(w.consents).toEqual([]);
    expect(r.invitation!.reference).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(r.invitation!.link).toBe(`dukanerp://join?ref=${r.invitation!.reference}`);
    expect(new Date(r.invitation!.expiresAt).getTime() - Date.now()).toBeGreaterThan(71.9 * HOUR);
    expect(new Date(r.invitation!.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(72 * HOUR);
    expect(w.audits[0]).toMatchObject({ action: 'create', after: expect.objectContaining({ status: 'pending' }) });
  });

  it('the reference is stored nowhere: one keyed hash in the invitation, and neither the audit nor any row holds it', async () => {
    const w = makeWorld();
    const { reference } = await invite(w);
    expect(w.invitations).toHaveLength(1);
    const plain = normaliseReference(reference)!;
    expect(w.invitations[0].tokenHash).toBe(referenceHash(INVITATION_KEY, plain));
    expect(w.invitations[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const everything = JSON.stringify([w.invitations, w.audits, w.users, w.consentAudits]);
    expect(everything).not.toContain(plain);
    expect(everything).not.toContain(reference);
    // A purpose-specific key: the same reference under another secret is another hash.
    expect(referenceHash(KEY, plain)).not.toBe(w.invitations[0].tokenHash);
  });

  it('refuses an employee without a WhatsApp number, with or without an email address — nothing created', async () => {
    const w = makeWorld();
    for (const extra of [{ phone: '' }, { phone: '', email: 'f@shop.test' }]) {
      await expect(w.service.invite({ ...INVITE, ...extra })).rejects.toMatchObject({ response: { code: 'whatsapp_required' } });
    }
    expect(w.users).toHaveLength(2);
    expect(w.invitations).toEqual([]);
  });

  it('without the invitation key, nothing is created and the Owner is told plainly', async () => {
    const w = makeWorld({ invitationKey: null });
    await expect(w.service.invite(INVITE)).rejects.toMatchObject({ response: { code: 'invitations_unavailable' } });
    expect(w.users).toHaveLength(2);
    expect(w.invitations).toEqual([]);
  });

  it('the same person added twice is one pending account; no second reference is issued silently', async () => {
    const w = makeWorld();
    const a = await invite(w);
    const b = await w.service.invite({ ...INVITE, name: 'Fatima again' });
    expect(b).toMatchObject({ created: false, invitation: null });
    expect(b.user.id).toBe(a.id);
    expect(w.invitations).toHaveLength(1);
    expect(w.started).toEqual([]);
  });

  it('a contact an active colleague already uses is refused', async () => {
    const w = makeWorld();
    await expect(w.service.invite({ ...INVITE, email: 'owner@shop.test' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('with no free seat at the store, the server prices a seat and the account waits for the payment', async () => {
    const w = makeWorld();
    w.setSeatsFull([binToUuid(MAIN)]);
    const r = await w.service.invite(INVITE);
    expect(w.seatRequests).toHaveLength(1);
    expect(r.seats).toEqual([{ storeId: binToUuid(MAIN), store: 'Main', state: 'awaiting_payment' }]);
  });

  it('into a full store that a seat paid for during the free trial covers, nothing is priced (D176)', async () => {
    const w = makeWorld({ covered: true });
    w.setSeatsFull([binToUuid(MAIN)]);
    const r = await w.service.invite(INVITE);
    expect(w.seatRequests).toEqual([]);
    expect(r.seats).toEqual([{ storeId: binToUuid(MAIN), store: 'Main', state: 'included' }]);
  });
});

describe('the employee opens the invitation', () => {
  it('as typed — lowercase, spaces, O for 0, I or L for 1: the business, their name, the number’s last two digits — never the number', async () => {
    const w = makeWorld();
    const { reference } = await invite(w);
    const typed = reference.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
    const opened = await w.service.open(typed);
    expect(opened).toEqual({ business: 'Shop', name: 'Fatima', numberEnding: '66', expiresAt: expect.any(String) });
    expect(JSON.stringify(opened)).not.toContain('33445566');
    expect(w.started).toEqual([]);
  });

  it('unknown, malformed, expired, revoked and used references all answer the same', async () => {
    const w = makeWorld();
    for (const typed of ['K7QM-9XRT-2CHD', 'not a reference', '', 'K7QM-9XRT-2CH!']) {
      await expect(w.service.open(typed)).rejects.toMatchObject(unavailable);
    }
    const expired = await invite(w);
    w.invitations[0].expiresAt = new Date(Date.now() - 1);
    await expect(w.service.open(expired.reference)).rejects.toMatchObject(unavailable);
    w.invitations[0].expiresAt = new Date(Date.now() + HOUR);
    const { invitation } = await w.service.reinvite(expired.id);
    await expect(w.service.open(expired.reference)).rejects.toMatchObject(unavailable);
    await ask(w, invitation.reference);
    await w.service.confirm(invitation.reference, '123456', 'Secret-pass-1');
    await expect(w.service.open(invitation.reference)).rejects.toMatchObject(unavailable);
  });

  it('the link only opens the form: opening accepts no consent, sends nothing and activates nothing', async () => {
    const w = makeWorld();
    const { reference } = await invite(w);
    await w.service.open(reference);
    expect(w.consents).toEqual([]);
    expect(w.started).toEqual([]);
    expect(w.invitations[0]).toMatchObject({ pendingConsentId: null, usedAt: null });
    expect(w.person('Fatima')).toMatchObject({ activatedAt: null, phoneVerifiedAt: null });
  });
});

describe('the employee accepts the consent and asks for the code', () => {
  it('no code without the agreement to the current copy: nothing recorded, nothing sent', async () => {
    const w = makeWorld();
    const { reference } = await invite(w);
    await expect(w.service.requestCode(reference, FATIMA, 'en')).rejects.toMatchObject({ response: { code: 'whatsapp_consent_required' } });
    await expect(w.service.requestCode(reference, FATIMA, 'en', { version: 'wa-consent-2026-10-17' })).rejects.toMatchObject({
      response: { code: 'whatsapp_consent_outdated' },
    });
    expect(w.started).toEqual([]);
    expect(w.consents).toEqual([]);
  });

  it('the number must be the one the Owner entered: another is refused before anything is recorded or sent', async () => {
    const w = makeWorld();
    const { reference } = await invite(w);
    await expect(ask(w, reference, '+22299999999')).rejects.toMatchObject({ response: { code: 'number_mismatch' } });
    await expect(ask(w, reference, 'abc')).rejects.toMatchObject({ response: { code: 'number_invalid' } });
    expect(w.started).toEqual([]);
    expect(w.consents).toEqual([]);
  });

  it('ticked: a pending agreement — the employee its actor, the version, the language shown, the source, the address — bound to the invitation; then the code', async () => {
    const w = makeWorld();
    const { reference } = await invite(w);
    expect(await ask(w, reference, '+222 33 44 55 66')).toEqual({ accepted: true });
    const fatima = w.person('Fatima');
    expect(w.consents).toEqual([
      expect.objectContaining({
        event: 'pending_unverified',
        version: WHATSAPP_CONSENT_VERSION,
        locale: 'fr',
        source: 'employee_activation',
        actorUserId: fatima.id,
        actorCompanyId: COMPANY,
        numberHash: recipientHash(FATIMA, KEY),
      }),
    ]);
    expect(w.consents.some((c) => (c.actorUserId as Buffer).equals(OWNER))).toBe(false);
    expect(w.consentAudits[0]).toMatchObject({ userId: fatima.id, ip: '198.51.100.7' });
    expect(w.invitations[0].pendingConsentId.equals(w.consents[0].id)).toBe(true);
    expect(w.started).toEqual([FATIMA]);
  });

  it('asking again, while the agreement and the invitation are both valid, sends a new code under the same agreement', async () => {
    const w = makeWorld();
    const { reference } = await invite(w);
    await ask(w, reference);
    await ask(w, reference);
    expect(w.consents).toHaveLength(1);
    expect(w.started).toEqual([FATIMA, FATIMA]);
  });

  it('an agreement that expired (24 h) inside the invitation’s 72 is accepted again: a new pending agreement, the invitation re-bound', async () => {
    const w = makeWorld();
    const { reference } = await invite(w);
    await ask(w, reference);
    w.consents[0].createdAt = new Date(Date.now() - 25 * HOUR);
    await ask(w, reference);
    expect(w.consents.map((c) => c.event)).toEqual(['pending_unverified', 'pending_unverified']);
    expect(w.invitations[0].pendingConsentId.equals(w.consents[1].id)).toBe(true);
  });

  it('nothing can deliver: refused honestly, nothing recorded', async () => {
    const w = makeWorld({ canDeliver: () => false });
    const { reference } = await invite(w);
    await expect(ask(w, reference)).rejects.toMatchObject({ response: { code: 'delivery_unavailable' } });
    expect(w.consents).toEqual([]);
    expect(w.started).toEqual([]);
  });

  it('an unusable reference is refused before the number is even compared', async () => {
    const w = makeWorld();
    await invite(w);
    await expect(ask(w, 'K7QM-9XRT-2CHD')).rejects.toMatchObject(unavailable);
    await expect(ask(w, 'K7QM-9XRT-2CHD', '+22299999999')).rejects.toMatchObject(unavailable);
    expect(w.consents).toEqual([]);
  });
});

describe('the employee confirms the code', () => {
  it('a wrong code is a miss and changes nothing; the first time, a password is asked for without spending the code', async () => {
    const w = makeWorld();
    const { reference } = await invite(w);
    await ask(w, reference);
    await expect(w.service.confirm(reference, '000000', 'Secret-pass-1')).rejects.toMatchObject({ response: { code: 'code_mismatch' } });
    await expect(w.service.confirm(reference, '123456')).rejects.toMatchObject({ response: { code: 'password_required' } });
    expect(w.person('Fatima').phoneVerifiedAt).toBeNull();
    expect(w.invitations[0].usedAt).toBeNull();
    expect((await w.service.confirm(reference, '123456', 'Secret-pass-1')).verified).toBe(true);
  });

  it('without a code requested, nothing confirms', async () => {
    const w = makeWorld();
    const { reference } = await invite(w);
    await expect(w.service.confirm(reference, '123456', 'Secret-pass-1')).rejects.toMatchObject({ response: { code: 'code_mismatch' } });
  });

  it('together: the number verified, the password set, exactly the bound agreement activated, the invitation used, the account activated', async () => {
    const w = makeWorld();
    const { reference } = await invite(w);
    await ask(w, reference);
    const r = await w.service.confirm(reference, '123456', 'Secret-pass-1');
    const fatima = w.person('Fatima');
    expect(fatima.phoneVerifiedAt).toBeInstanceOf(Date);
    expect(fatima.passwordHash).toBe('hash(Secret-pass-1)');
    expect(w.consents.map((c) => c.event)).toEqual(['pending_unverified', 'active']);
    expect(w.consents[1]).toMatchObject({ actorUserId: fatima.id, pendingId: w.consents[0].id, source: 'employee_activation' });
    expect(w.invitations[0].usedAt).toBeInstanceOf(Date);
    expect(w.inTx).toHaveLength(1);
    expect(w.activations).toEqual([]);
    expect(r).toEqual({ verified: true, business: 'Shop', name: 'Fatima', activated: true, pending: [] });
    expect(await w.records.contactState(FATIMA)).toMatchObject({ consented: true, consent: 'active' });
  });

  it('a used invitation cannot be used again — not to open, not to ask, not to confirm', async () => {
    const w = makeWorld();
    const { reference } = await invite(w);
    await ask(w, reference);
    await w.service.confirm(reference, '123456', 'Secret-pass-1');
    await expect(w.service.open(reference)).rejects.toMatchObject(unavailable);
    await expect(ask(w, reference)).rejects.toMatchObject(unavailable);
    await expect(w.service.confirm(reference, '123456', 'Secret-pass-1')).rejects.toMatchObject(unavailable);
    expect(w.consents.filter((c) => c.event === 'active')).toHaveLength(1);
  });

  it('an agreement that expired since the code was asked for activates nothing: the invitation and the account stay as they were', async () => {
    const w = makeWorld();
    const { reference } = await invite(w);
    await ask(w, reference);
    w.consents[0].createdAt = new Date(Date.now() - 25 * HOUR);
    await expect(w.service.confirm(reference, '123456', 'Secret-pass-1')).rejects.toMatchObject({ response: { code: 'consent_expired' } });
    expect(w.consents.map((c) => c.event)).toEqual(['pending_unverified']);
    expect(w.invitations[0].usedAt).toBeNull();
    expect(w.person('Fatima').phoneVerifiedAt).toBeNull();
  });

  it('no seat yet: the consent and the number stand, and the service prices the seat after the commit', async () => {
    const w = makeWorld({ activateInTx: { activated: false, pending: ['seat_payment'] } });
    const { reference } = await invite(w);
    await ask(w, reference);
    const r = await w.service.confirm(reference, '123456', 'Secret-pass-1');
    expect(r).toMatchObject({ activated: false, pending: ['seat_payment'] });
    expect(w.activations).toHaveLength(1);
    expect(w.invitations[0].usedAt).toBeInstanceOf(Date);
  });

  it('an expired invitation confirms nothing, even with a good code', async () => {
    const w = makeWorld();
    const { reference } = await invite(w);
    await ask(w, reference);
    w.invitations[0].expiresAt = new Date(Date.now() - 1);
    await expect(w.service.confirm(reference, '123456', 'Secret-pass-1')).rejects.toMatchObject(unavailable);
    expect(w.consents.map((c) => c.event)).toEqual(['pending_unverified']);
  });
});

describe('the Owner reinvites or cancels', () => {
  it('a new invitation: the old one revoked and its pending agreement concluded `cancelled` by the Owner; the new reference shown once', async () => {
    const w = makeWorld();
    const first = await invite(w);
    await ask(w, first.reference);
    const { invitation } = await w.service.reinvite(first.id);
    expect(invitation.reference).not.toBe(first.reference);
    expect(w.invitations[0]).toMatchObject({ revokedReason: 'reinvited' });
    expect(w.invitations[1]).toMatchObject({ revokedAt: null, usedAt: null, pendingConsentId: null });
    expect(w.consents.map((c) => c.event)).toEqual(['pending_unverified', 'cancelled']);
    expect(w.consents[1]).toMatchObject({ pendingId: w.consents[0].id, source: 'invitation_replaced', actorUserId: OWNER });
    await expect(ask(w, first.reference)).rejects.toMatchObject(unavailable);
    // The new one starts clean: the employee agrees again.
    await ask(w, invitation.reference);
    expect(w.consents.map((c) => c.event)).toEqual(['pending_unverified', 'cancelled', 'pending_unverified']);
    expect(w.started).toEqual([FATIMA, FATIMA]);
  });

  it('a code asked for under the replaced invitation cannot activate the new one', async () => {
    const w = makeWorld();
    const first = await invite(w);
    await ask(w, first.reference);
    const { invitation } = await w.service.reinvite(first.id);
    await expect(w.service.confirm(invitation.reference, '123456', 'Secret-pass-1')).rejects.toMatchObject({ response: { code: 'code_mismatch' } });
    expect(w.person('Fatima').phoneVerifiedAt).toBeNull();
  });

  it('cancelling: the account withdrawn, its seat request withdrawn, its invitation revoked and its pending agreement concluded', async () => {
    const w = makeWorld();
    w.setSeatsFull([binToUuid(MAIN)]);
    const { id, reference } = await invite(w);
    await ask(w, reference);
    await w.service.cancel(id);
    expect(w.person('Fatima').deletedAt).toBeInstanceOf(Date);
    expect(w.withdrawn).toHaveLength(1);
    expect(w.invitations[0]).toMatchObject({ revokedReason: 'cancelled' });
    expect(w.consents.map((c) => c.event)).toEqual(['pending_unverified', 'cancelled']);
    expect(w.consents[1]).toMatchObject({ source: 'invitation_cancelled' });
    await expect(w.service.confirm(reference, '123456', 'Secret-pass-1')).rejects.toMatchObject(unavailable);
    await expect(w.service.cancel(id)).rejects.toThrow('Unknown user');
  });

  it('an active account is not an invitation', async () => {
    const w = makeWorld();
    await expect(w.service.reinvite(binToUuid(OWNER))).rejects.toMatchObject({ response: { code: 'not_pending' } });
  });
});

describe('across businesses', () => {
  it('another business’s Owner can neither reinvite nor cancel this business’s employee', async () => {
    const w = makeWorld();
    const { id } = await invite(w);
    w.actAs(COMPANY_B, OWNER_B);
    await expect(w.service.reinvite(id)).rejects.toThrow('Unknown user');
    await expect(w.service.cancel(id)).rejects.toThrow('Unknown user');
    expect(w.invitations[0]).toMatchObject({ revokedAt: null });
  });

  it('one number invited by two businesses: each invitation activates only its own account', async () => {
    const w = makeWorld();
    const a = await invite(w);
    w.actAs(COMPANY_B, OWNER_B);
    const b = await invite(w);
    await ask(w, a.reference);
    await w.service.confirm(a.reference, '123456', 'Secret-pass-1');
    const atA = w.person('Fatima', COMPANY);
    const atB = w.person('Fatima', COMPANY_B);
    expect(atA.phoneVerifiedAt).toBeInstanceOf(Date);
    expect(atB.phoneVerifiedAt).toBeNull();
    expect(w.invitations.find((i) => i.companyId.equals(COMPANY_B))).toMatchObject({ usedAt: null, revokedAt: null, pendingConsentId: null });
    expect(w.consents.filter((c) => c.event === 'active').map((c) => binToUuid(c.actorUserId as Buffer))).toEqual([binToUuid(atA.id)]);
    // B's invitation opens on its own, for its own business.
    expect(await w.service.open(b.reference)).toMatchObject({ business: 'Other shop' });
  });
});

describe('the gate holds on every other path', () => {
  const source = readFileSync('src/staff/staff-invitation.service.ts', 'utf8');

  it('creating, reinviting and cancelling send nothing: the one code this service sends is the employee’s own request', () => {
    expect(source.match(/this\.verification\.start\(/g)).toHaveLength(1);
    const requestCode = source.slice(source.indexOf('async requestCode('), source.indexOf('async confirm('));
    expect(requestCode).toContain('this.verification.start(');
  });

  it('the destination-only routes are gone: a code is asked for, and confirmed, by invitation only', () => {
    const controller = readFileSync('src/staff/staff.controller.ts', 'utf8');
    expect(controller).not.toMatch(/verify\/(resend|confirm)|resend-verification/);
    expect(controller).toMatch(/'staff\/join'/);
    expect(controller.match(/@Throttle\(PUBLIC_THROTTLE\)/g)).toHaveLength(3);
  });

  it('sign-in considers only active accounts, so a pending one cannot sign in by any client', () => {
    expect(readFileSync('src/users/users.service.ts', 'utf8')).toMatch(/const base = \{ deletedAt: null, isActive: true \};/);
  });

  it('the Team PATCH cannot switch a pending account on by hand, nor change the number its invitation is for', () => {
    const management = readFileSync('src/users/user-management.service.ts', 'utf8');
    expect(management).toMatch(/activation_pending/);
    expect(management).toMatch(/pending_number_locked/);
  });

  it('only the activation service writes activated_at', () => {
    for (const f of ['src/staff/staff-invitation.service.ts', 'src/users/user-management.service.ts', 'src/platform/seat-allocation.service.ts']) {
      expect({ f, ok: !/activatedAt:\s*(now|new Date)/.test(readFileSync(f, 'utf8')) }).toEqual({ f, ok: true });
    }
  });

  it('the reference is never logged or audited', () => {
    expect(source).not.toMatch(/log\w*\([^)]*reference/i);
    const issue = source.slice(source.indexOf('private async issue('), source.indexOf('private async endLive('));
    expect(issue).not.toMatch(/after: \{[^}]*reference/);
  });
});

describe('no existing employee is migrated', () => {
  it('a verified number with no agreement has no consent, and nothing issues an invitation for an existing account on its own', async () => {
    const w = makeWorld();
    expect(await w.records.contactState(FATIMA)).toMatchObject({ consented: false, consent: 'none' });
    expect(w.invitations).toEqual([]);
  });
});

