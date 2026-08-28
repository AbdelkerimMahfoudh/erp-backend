import { OtpPurpose } from '@prisma/client';
import {
  RegistrationContinuationService,
  CONTINUATION_TTL_SECONDS,
} from './registration-continuation.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import { hashIntentToken } from '../auth/otp/otp-code.util';

/**
 * Finishing a registration, and everything that must NOT finish one.
 *
 * The shortcut this design exists to refuse is a single line:
 *
 *     isVerified(destination) === true  →  issue a session
 *
 * It reads like a check and is not one. `isVerified` answers for the most
 * recent consumed verification of an address, **ever** — no bound on when, by
 * whom, or in which attempt. An endpoint trusting it hands an Owner session to
 * anyone who can name an address somebody once verified, with no password in
 * the story at all.
 *
 * So most of what follows is not "does the happy path work". It is: here is a
 * caller holding something that looks almost right, and it still gets nothing.
 */

function makeWorld() {
  const intents: any[] = [];
  const challenges: any[] = [];
  const users = new Map<string, any>();
  const sessions: any[] = [];

  const prisma: any = {
    verificationIntent: {
      create: jest.fn(async ({ data }: any) => {
        intents.push({ ...data });
        return data;
      }),
      findUnique: jest.fn(async ({ where }: any) =>
        intents.find((i) => i.tokenHash === where.tokenHash) ?? null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = intents.find((i) => i.id.equals(where.id));
        Object.assign(row, data);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = intents.find(
          (i) => i.id.equals(where.id) && (where.consumedAt === null ? !i.consumedAt : true),
        );
        if (!row) return { count: 0 };
        row.consumedAt = data.consumedAt;
        return { count: 1 };
      }),
    },
    user: {
      findUnique: jest.fn(async ({ where }: any) => users.get(where.id.toString('hex')) ?? null),
      update: jest.fn(async ({ where, data }: any) => {
        const u = users.get(where.id.toString('hex'));
        Object.assign(u, data);
        return u;
      }),
    },
    contactVerification: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = challenges.find(
          (c) => c.id.equals(where.id) && (where.consumedAt === null ? !c.consumedAt : true),
        );
        if (!row) return { count: 0 };
        row.consumedAt = data.consumedAt;
        return { count: 1 };
      }),
    },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };

  const intentService: any = {
    issue: jest.fn(async (p: any) => {
      const token = 'tok_' + Math.random().toString(36).slice(2) + Date.now();
      const id = newUuidV7Bin();
      await prisma.verificationIntent.create({
        data: {
          id,
          companyId: p.companyId,
          userId: p.userId,
          purpose: p.purpose,
          challengeId: p.challengeId ?? null,
          tokenHash: hashIntentToken(token),
          expiresAt: new Date(Date.now() + (p.ttlSeconds ?? 600) * 1000),
        },
      });
      return { token, intentId: id, expiresAt: new Date().toISOString() };
    }),
    resolve: jest.fn(async (token: string, expect: any = {}) => {
      const row = await prisma.verificationIntent.findUnique({
        where: { tokenHash: hashIntentToken(token) },
      });
      if (!row) return { ok: false, reason: 'not_found' };
      if (row.consumedAt) return { ok: false, reason: 'consumed' };
      if (row.expiresAt <= new Date()) return { ok: false, reason: 'expired' };
      if (expect.purpose && row.purpose !== expect.purpose) return { ok: false, reason: 'mismatch' };
      return {
        ok: true,
        intentId: row.id,
        companyId: row.companyId,
        userId: row.userId,
        purpose: row.purpose,
        deviceId: row.deviceId ?? null,
        challengeId: row.challengeId ?? null,
      };
    }),
    consume: jest.fn(async (intentId: Buffer, work: any) => {
      return prisma.$transaction(async (tx: any) => {
        const { count } = await tx.verificationIntent.updateMany({
          where: { id: intentId, consumedAt: null },
          data: { consumedAt: new Date() },
        });
        if (count !== 1) return { ok: false, reason: 'consumed' };
        return { ok: true, result: await work(tx) };
      });
    }),
  };

  const verification: any = {
    start: jest.fn(async (destination: string) => {
      const id = newUuidV7Bin();
      challenges.push({
        id,
        destination,
        code: '424242',
        consumedAt: null,
        expiresAt: new Date(Date.now() + 600_000),
      });
      return { delivery: 'outbox' as const };
    }),
    latestChallengeFor: jest.fn(async (destination: string) => {
      const open = challenges.filter((c) => c.destination === destination && !c.consumedAt);
      return open.length ? open[open.length - 1].id : null;
    }),
    confirmChallenge: jest.fn(async (challengeId: Buffer, code: string) => {
      const row = challenges.find((c) => c.id.equals(challengeId));
      if (!row || row.consumedAt || row.expiresAt <= new Date()) return 'gone';
      return row.code === code.trim() ? 'ok' : 'wrong';
    }),
    isVerified: jest.fn(async () => true), // the trap, always true
  };

  const sessionsService: any = {
    create: jest.fn(async (p: any) => {
      const id = newUuidV7Bin();
      sessions.push({ id, ...p });
      return id;
    }),
  };

  const tokensService: any = {
    generateRefreshSecret: jest.fn(() => 'secret'),
    buildRefreshToken: jest.fn((sid: string) => 'refresh.' + sid),
    signAccessToken: jest.fn(() => ({ token: 'access.token', expiresIn: 900 })),
  };

  const service = new RegistrationContinuationService(
    prisma,
    intentService,
    verification,
    sessionsService,
    tokensService,
  );

  function addOwner(over: Partial<any> = {}) {
    const companyId = over.companyId ?? newUuidV7Bin();
    const id = over.id ?? newUuidV7Bin();
    const user = {
      id,
      companyId,
      email: 'owner@example.invalid',
      phone: null,
      emailVerifiedAt: null,
      phoneVerifiedAt: null,
      isActive: true,
      deletedAt: null,
      ...over,
    };
    users.set(id.toString('hex'), user);
    return user;
  }

  return { service, prisma, intents, challenges, users, sessions, verification, sessionsService, addOwner, intentService };
}

/** Register → send code → the code that was actually sent. */
async function upToCode(w: ReturnType<typeof makeWorld>, owner: any) {
  const { token } = await w.service.issue(owner.companyId, owner.id);
  const started = await w.service.startChallenge(token, 'en');
  expect(started.ok).toBe(true);
  return { token, code: '424242' };
}

describe('a registration is finished by proving THIS attempt, not an address', () => {
  it('the happy path issues exactly one ordinary session', async () => {
    const w = makeWorld();
    const owner = w.addOwner();
    const { token, code } = await upToCode(w, owner);

    const done = await w.service.complete(token, code);
    expect(done.ok).toBe(true);
    expect(w.sessions).toHaveLength(1);
    // From SessionsService, like any password sign-in — not minted in place.
    expect(w.sessionsService.create).toHaveBeenCalledTimes(1);
    expect(w.sessions[0].userId).toEqual(owner.id);
  });

  it('marks the contact proved on the Owner, which is what stops a second continuation', async () => {
    const w = makeWorld();
    const owner = w.addOwner();
    const { token, code } = await upToCode(w, owner);
    await w.service.complete(token, code);
    expect(w.users.get(owner.id.toString('hex')).emailVerifiedAt).toBeInstanceOf(Date);
  });

  // ── the trap ──────────────────────────────────────────────────────────────

  it('an address verified in SOME earlier attempt buys nothing', async () => {
    const w = makeWorld();
    const owner = w.addOwner();

    // A consumed challenge for the same address, from a previous life.
    w.challenges.push({
      id: newUuidV7Bin(),
      destination: 'owner@example.invalid',
      code: '424242',
      consumedAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000),
    });

    // A continuation exists, but nothing was ever sent FOR IT.
    const { token } = await w.service.issue(owner.companyId, owner.id);
    const done = await w.service.complete(token, '424242');

    expect(done.ok).toBe(false);
    expect(!done.ok && done.reason).toBe('no_challenge');
    expect(w.sessions).toHaveLength(0);
    // And note the world's `isVerified` says true throughout. It is never asked.
    expect(w.verification.isVerified).not.toHaveBeenCalled();
  });

  it('a challenge belonging to ANOTHER registration cannot be spent here', async () => {
    const w = makeWorld();
    const mine = w.addOwner();
    const theirs = w.addOwner({ email: 'owner@example.invalid' });

    // Their attempt sends a code to the same address.
    await upToCode(w, theirs);

    // Mine has a continuation with no challenge of its own.
    const { token } = await w.service.issue(mine.companyId, mine.id);
    const done = await w.service.complete(token, '424242');

    expect(done.ok).toBe(false);
    expect(w.sessions).toHaveLength(0);
  });

  // ── the ordinary refusals ────────────────────────────────────────────────

  it('a wrong code fails and issues nothing', async () => {
    const w = makeWorld();
    const owner = w.addOwner();
    const { token } = await upToCode(w, owner);
    const done = await w.service.complete(token, '000000');
    expect(!done.ok && done.reason).toBe('wrong_code');
    expect(w.sessions).toHaveLength(0);
  });

  it('the right code with an unknown continuation fails', async () => {
    const w = makeWorld();
    const owner = w.addOwner();
    await upToCode(w, owner);
    const done = await w.service.complete('tok_not_a_real_one', '424242');
    expect(!done.ok && done.reason).toBe('not_found');
    expect(w.sessions).toHaveLength(0);
  });

  it('an expired continuation fails', async () => {
    const w = makeWorld();
    const owner = w.addOwner();
    const { token, code } = await upToCode(w, owner);
    w.intents[0].expiresAt = new Date(Date.now() - 1000);
    const done = await w.service.complete(token, code);
    expect(!done.ok && done.reason).toBe('expired');
  });

  it('the continuation is single-use', async () => {
    const w = makeWorld();
    const owner = w.addOwner();
    const { token, code } = await upToCode(w, owner);

    expect((await w.service.complete(token, code)).ok).toBe(true);
    const again = await w.service.complete(token, code);
    expect(again.ok).toBe(false);
    expect(w.sessions).toHaveLength(1);
  });

  it('two concurrent completions issue exactly one session', async () => {
    const w = makeWorld();
    const owner = w.addOwner();
    const { token, code } = await upToCode(w, owner);

    const [a, b] = await Promise.all([
      w.service.complete(token, code),
      w.service.complete(token, code),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(w.sessions).toHaveLength(1);
  });

  it('a disabled Owner cannot finish', async () => {
    const w = makeWorld();
    const owner = w.addOwner();
    const { token, code } = await upToCode(w, owner);
    w.users.get(owner.id.toString('hex')).isActive = false;

    const done = await w.service.complete(token, code);
    expect(!done.ok && done.reason).toBe('user_unavailable');
    expect(w.sessions).toHaveLength(0);
  });

  it('a ticket minted for the PORTAL cannot finish a registration', async () => {
    const w = makeWorld();
    const owner = w.addOwner();
    // Same table, same shape, different purpose — and purpose is checked.
    const other = await w.intentService.issue({
      companyId: owner.companyId,
      userId: owner.id,
      purpose: OtpPurpose.portal_handoff,
      ttlSeconds: 90,
    });
    const done = await w.service.complete(other.token, '424242');
    expect(!done.ok && done.reason).toBe('mismatch');
    expect(w.sessions).toHaveLength(0);
  });

  // ── where the code goes ──────────────────────────────────────────────────

  it('the code goes to the Owner record, never to an address in the request', async () => {
    const w = makeWorld();
    const owner = w.addOwner({ email: 'real@example.invalid' });
    const { token } = await w.service.issue(owner.companyId, owner.id);

    // The API takes no destination at all; this proves where it comes from.
    await w.service.startChallenge(token, 'en');
    expect(w.verification.start).toHaveBeenCalledWith('real@example.invalid', 'en');
  });

  it('resending rebinds, so the older code stops working', async () => {
    const w = makeWorld();
    const owner = w.addOwner();
    const { token } = await w.service.issue(owner.companyId, owner.id);

    await w.service.startChallenge(token, 'en');
    const first = w.challenges[0].id;
    await w.service.startChallenge(token, 'en');
    const second = w.challenges[1].id;

    expect(first.equals(second)).toBe(false);
    const bound = w.intents[0].challengeId;
    expect(bound.equals(second)).toBe(true);
  });

  it('a disabled Owner is refused a code as well as a session', async () => {
    const w = makeWorld();
    const owner = w.addOwner({ isActive: false });
    const { token } = await w.service.issue(owner.companyId, owner.id);
    const started = await w.service.startChallenge(token, 'en');
    expect(started.ok).toBe(false);
    expect(w.verification.start).not.toHaveBeenCalled();
  });

  // ── the credential itself ────────────────────────────────────────────────

  it('only a hash is stored, never the continuation', async () => {
    const w = makeWorld();
    const owner = w.addOwner();
    const { token } = await w.service.issue(owner.companyId, owner.id);

    const stored = JSON.stringify(w.intents);
    expect(stored).not.toContain(token);
    expect(w.intents[0].tokenHash).toBe(hashIntentToken(token));
  });

  it('is short-lived by construction', () => {
    expect(CONTINUATION_TTL_SECONDS).toBeLessThanOrEqual(15 * 60);
    expect(CONTINUATION_TTL_SECONDS).toBeGreaterThan(0);
  });

  it('carries the registration purpose and nothing broader', async () => {
    const w = makeWorld();
    const owner = w.addOwner();
    await w.service.issue(owner.companyId, owner.id);
    expect(w.intents[0].purpose).toBe(OtpPurpose.registration_continuation);
    expect(w.intents[0].companyId).toEqual(owner.companyId);
    expect(w.intents[0].userId).toEqual(owner.id);
  });
});
