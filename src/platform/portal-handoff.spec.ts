import { OtpPurpose } from '@prisma/client';
import { PortalHandoffService, HANDOFF_TTL_SECONDS } from './portal-handoff.service';
import { PORTAL_SESSION_COOKIE, readCookie } from '../common/http/cookies';
import { newUuidV7Bin, binToUuid } from '../common/utils/uuid.util';
import { hashIntentToken } from '../auth/otp/otp-code.util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLE_PERMISSIONS } from '../rbac/role-permissions';
import { DELEGATABLE_PERMISSIONS, isCompanyPermission } from '../rbac/permission-scope';

/**
 * The one-time ticket that opens the website portal signed in.
 *
 * Everything here is about what the ticket is NOT allowed to be: reusable,
 * long-lived, transferable between companies, or usable by an account that has
 * since been switched off. A handoff that is merely convenient is a handoff
 * that hands somebody else's shop to whoever catches the link.
 */

// ── A store that enforces the constraints the design leans on ──────────────

function makeWorld() {
  const intents: any[] = [];
  const sessions: any[] = [];
  const users = new Map<string, { id: Buffer; companyId: Buffer; isActive: boolean }>();

  const prisma: any = {
    verificationIntent: {
      create: jest.fn(async ({ data }: any) => { intents.push({ ...data }); return data; }),
      findUnique: jest.fn(async ({ where }: any) =>
        intents.find((i) => i.tokenHash === where.tokenHash) ?? null),
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
    },
    // `consume` runs its work inside a transaction; the fake just passes itself.
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };

  const intentsService = {
    issue: jest.fn(async (p: any) => {
      const token = 'tok_' + Math.random().toString(36).slice(2) + intents.length;
      const id = newUuidV7Bin();
      const expiresAt = new Date(Date.now() + (p.ttlSeconds ?? 600) * 1000);
      intents.push({
        id, companyId: p.companyId, userId: p.userId, purpose: p.purpose,
        tokenHash: hashIntentToken(token), expiresAt, consumedAt: null,
      });
      return { token, intentId: binToUuid(id), expiresAt: expiresAt.toISOString() };
    }),
    resolve: jest.fn(async (token: string, expect: any = {}) => {
      const i = intents.find((x) => x.tokenHash === hashIntentToken(token));
      if (!i) return { ok: false, reason: 'not_found' };
      if (i.consumedAt) return { ok: false, reason: 'consumed' };
      if (i.expiresAt <= new Date()) return { ok: false, reason: 'expired' };
      if (expect.purpose && i.purpose !== expect.purpose) return { ok: false, reason: 'mismatch' };
      return {
        ok: true, intentId: i.id, companyId: i.companyId, userId: i.userId,
        purpose: i.purpose, deviceId: null,
      };
    }),
    consume: jest.fn(async (intentId: Buffer, work: any) => {
      const row = intents.find((i) => i.id.equals(intentId));
      if (!row || row.consumedAt) return { ok: false, reason: 'consumed' };
      row.consumedAt = new Date();
      return { ok: true, result: await work(prisma) };
    }),
  };

  const sessionsService = {
    create: jest.fn(async (p: any) => {
      const id = newUuidV7Bin();
      sessions.push({ id, ...p });
      return id;
    }),
  };

  const tokensService = {
    generateRefreshSecret: jest.fn(() => 'secret'),
    signAccessToken: jest.fn((userId: string, companyId: string, sid: string) => ({
      token: `access.${userId}.${companyId}.${sid}`,
      expiresIn: 900,
    })),
  };

  const service = new PortalHandoffService(
    prisma, intentsService as any, sessionsService as any, tokensService as any,
  );

  return { service, prisma, intents, sessions, users, intentsService, tokensService };
}

function addOwner(world: ReturnType<typeof makeWorld>, isActive = true) {
  const companyId = newUuidV7Bin();
  const userId = newUuidV7Bin();
  world.users.set(userId.toString('hex'), { id: userId, companyId, isActive });
  return { companyId, userId };
}

describe('issuing a portal handoff', () => {
  it('binds the ticket to one company, one user and the portal purpose', async () => {
    const w = makeWorld();
    const { companyId, userId } = addOwner(w);

    await w.service.issue(companyId, userId);

    expect(w.intentsService.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId, userId,
        purpose: OtpPurpose.portal_handoff,
        ttlSeconds: HANDOFF_TTL_SECONDS,
      }),
    );
  });

  it('is short-lived — 90 seconds, not an hour', () => {
    expect(HANDOFF_TTL_SECONDS).toBeLessThanOrEqual(120);
    expect(HANDOFF_TTL_SECONDS).toBeGreaterThanOrEqual(60);
  });

  it('returns the raw ticket once and stores only a hash', async () => {
    const w = makeWorld();
    const { companyId, userId } = addOwner(w);

    const { token } = await w.service.issue(companyId, userId);

    expect(token).toBeTruthy();
    const stored = w.intents[0];
    expect(stored.tokenHash).not.toBe(token);
    expect(JSON.stringify(stored)).not.toContain(token);
  });
});

describe('exchanging a portal handoff', () => {
  it('creates a portal session for the right Owner', async () => {
    const w = makeWorld();
    const { companyId, userId } = addOwner(w);
    const { token } = await w.service.issue(companyId, userId);

    const result = await w.service.exchange(token);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.companyId).toBe(binToUuid(companyId));
    expect(result.userId).toBe(binToUuid(userId));
    expect(w.sessions).toHaveLength(1);
    expect(w.sessions[0].companyId.equals(companyId)).toBe(true);
  });

  it('spends the ticket — a replay is refused', async () => {
    const w = makeWorld();
    const { companyId, userId } = addOwner(w);
    const { token } = await w.service.issue(companyId, userId);

    const first = await w.service.exchange(token);
    const second = await w.service.exchange(token);

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: 'consumed' });
    // And crucially, only ONE session exists.
    expect(w.sessions).toHaveLength(1);
  });

  it('survives two simultaneous taps without issuing two sessions', async () => {
    const w = makeWorld();
    const { companyId, userId } = addOwner(w);
    const { token } = await w.service.issue(companyId, userId);

    const [a, b] = await Promise.all([w.service.exchange(token), w.service.exchange(token)]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(w.sessions).toHaveLength(1);
  });

  it('refuses an expired ticket', async () => {
    const w = makeWorld();
    const { companyId, userId } = addOwner(w);
    const { token } = await w.service.issue(companyId, userId);

    w.intents[0].expiresAt = new Date(Date.now() - 1000);

    expect(await w.service.exchange(token)).toEqual({ ok: false, reason: 'expired' });
    expect(w.sessions).toHaveLength(0);
  });

  it('refuses a ticket that was never issued', async () => {
    const w = makeWorld();
    expect(await w.service.exchange('not-a-real-ticket')).toEqual({
      ok: false, reason: 'not_found',
    });
  });

  it('refuses an empty ticket', async () => {
    const w = makeWorld();
    expect((await w.service.exchange('')).ok).toBe(false);
  });

  it('refuses a ticket whose user has since been switched off', async () => {
    const w = makeWorld();
    const { companyId, userId } = addOwner(w, true);
    const { token } = await w.service.issue(companyId, userId);

    // Disabled in the ninety seconds between the tap and the browser opening.
    w.users.get(userId.toString('hex'))!.isActive = false;

    expect(await w.service.exchange(token)).toEqual({ ok: false, reason: 'user_unavailable' });
    expect(w.sessions).toHaveLength(0);
  });

  it('refuses a ticket whose user has been deleted', async () => {
    const w = makeWorld();
    const { companyId, userId } = addOwner(w);
    const { token } = await w.service.issue(companyId, userId);
    w.users.delete(userId.toString('hex'));

    expect(await w.service.exchange(token)).toEqual({ ok: false, reason: 'user_unavailable' });
  });

  it('refuses a ticket whose user has moved to another company', async () => {
    const w = makeWorld();
    const { companyId, userId } = addOwner(w);
    const { token } = await w.service.issue(companyId, userId);

    // The ticket says one company; the user now belongs to another.
    w.users.get(userId.toString('hex'))!.companyId = newUuidV7Bin();

    expect(await w.service.exchange(token)).toEqual({ ok: false, reason: 'mismatch' });
    expect(w.sessions).toHaveLength(0);
  });

  it('refuses a ticket minted for a different purpose', async () => {
    const w = makeWorld();
    const { companyId, userId } = addOwner(w);
    // A device-verification intent must not open the subscription portal.
    w.intents.push({
      id: newUuidV7Bin(), companyId, userId,
      purpose: OtpPurpose.device_verification,
      tokenHash: hashIntentToken('borrowed'), expiresAt: new Date(Date.now() + 60_000), consumedAt: null,
    });

    expect(await w.service.exchange('borrowed')).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('one company’s ticket cannot open another company’s portal', async () => {
    const w = makeWorld();
    const a = addOwner(w);
    const b = addOwner(w);
    const ticketA = (await w.service.issue(a.companyId, a.userId)).token;

    const result = await w.service.exchange(ticketA);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // It opened A's portal, and nothing of B's.
    expect(result.companyId).toBe(binToUuid(a.companyId));
    expect(result.companyId).not.toBe(binToUuid(b.companyId));
  });

  it('creates no payment, grant or subscription change', async () => {
    const w = makeWorld();
    const { companyId, userId } = addOwner(w);
    const { token } = await w.service.issue(companyId, userId);

    await w.service.exchange(token);

    // The fake would have thrown on any table the service is not allowed to
    // touch; assert positively that only sessions were written.
    expect(Object.keys(w.prisma)).toEqual(
      expect.arrayContaining(['verificationIntent', 'user', '$transaction']),
    );
    expect(w.prisma.subscription).toBeUndefined();
    expect(w.prisma.subscriptionPayment).toBeUndefined();
    expect(w.prisma.subscriptionEvent).toBeUndefined();
  });
});

describe('what the handoff must never leak', () => {
  it('logs the company, never the ticket', async () => {
    const w = makeWorld();
    const { companyId, userId } = addOwner(w);
    const logged: string[] = [];
    jest.spyOn((w.service as any).log, 'log').mockImplementation((m: any) => logged.push(String(m)));

    const { token } = await w.service.issue(companyId, userId);
    await w.service.exchange(token);

    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain(token);
      expect(line).toContain(binToUuid(companyId));
    }
  });

  it('names the portal cookie, and the reader only reads that cookie', () => {
    expect(PORTAL_SESSION_COOKIE).toBe('erp_portal_session');
    const header = `other=1; ${PORTAL_SESSION_COOKIE}=abc123; another=2`;
    expect(readCookie(header, PORTAL_SESSION_COOKIE)).toBe('abc123');
    expect(readCookie(header, 'erp_platform_session')).toBeUndefined();
    expect(readCookie(undefined, PORTAL_SESSION_COOKIE)).toBeUndefined();
  });
});

/**
 * Who may mint one.
 *
 * The CP8 staging acceptance found a real Store Manager and a real Store
 * Employee each minting a ticket happily, over HTTP, against MySQL — both
 * HTTP 201. The portal is the account surface: what the shop is charged, what
 * it owes and how to pay. A Manager runs a branch; an Employee sells. Neither
 * settles the bill.
 *
 * Read from the source rather than by standing up Nest, because what is being
 * pinned is the decorator on the route — the guard itself already has its own
 * tests.
 */
describe('only an Owner may mint a portal handoff', () => {
  const source = readFileSync(join(__dirname, 'platform.controller.ts'), 'utf8');
  const route = source.slice(source.indexOf("@Post('portal-handoff')"));
  const signature = route.slice(0, route.indexOf('async createPortalHandoff'));

  it('gates the route on an Owner-only permission', () => {
    expect(signature).toContain("@RequirePermissions('settings.manage')");
  });

  it('uses a permission no manager and no employee holds', () => {
    /*
     * The Owner and the company `administrator` — the Owner's deputy, 58 of 61
     * permissions — hold it, and nobody else does. Every managing and selling
     * role is refused, which is the property the acceptance found broken.
     */
    for (const [role, keys] of Object.entries(ROLE_PERMISSIONS)) {
      const allowed = role === 'owner' || role === 'administrator';
      expect([role, keys.includes('settings.manage')]).toEqual([role, allowed]);
    }
    for (const role of ['store_manager', 'branch_manager', 'store_employee',
      'sales_employee', 'warehouse_employee'] as const) {
      expect(ROLE_PERMISSIONS[role]).not.toContain('settings.manage');
    }
  });

  it('uses a permission that can never be delegated to a branch', () => {
    // A branch delegation would put the account surface back within a
    // Manager's reach by another route.
    expect(DELEGATABLE_PERMISSIONS).not.toContain('settings.manage');
  });

  it('needs no branch context, so a pending Owner with no active branch still passes', () => {
    expect(isCompanyPermission('settings.manage')).toBe(true);
  });
});
