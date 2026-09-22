import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { RequestMethod, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PlatformController } from './platform.controller';
import { PlatformAdminGuard } from './platform-admin.guard';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { ALWAYS_ALLOWED, ALWAYS_READABLE } from '../entitlement/route-classification';
import { EntitlementService } from '../entitlement/entitlement.service';
import {
  ENTITLEMENT_PENDING,
  ENTITLEMENT_REJECTED,
  ENTITLEMENT_SUSPENDED,
} from '../entitlement/entitlement-rules';

/**
 * The wall between the platform and every shop, tested from both sides.
 *
 * From the shop's side: no tenant credential — not an Employee's, not a
 * Manager's, not the Owner's, not a forged company or branch header — reaches
 * a platform route. From the platform's side: no administrator route reads a
 * tenant header or the tenant context, so no header a phone can set changes
 * what an administrator sees. And in between: a business the platform has
 * closed stays closed on the server, whatever build, clock or header the
 * phone brings.
 */

const CONTROLLER = readFileSync('src/platform/platform.controller.ts', 'utf8');
const GUARD = readFileSync('src/platform/platform-admin.guard.ts', 'utf8');
const ADMINS = readFileSync('src/platform/platform-admin.service.ts', 'utf8');
const ENTITLEMENT = readFileSync('src/entitlement/entitlement.service.ts', 'utf8');

const IDENTITY = { id: Buffer.alloc(16, 1), email: 'ops@example.test', name: 'Ops' };

function guardWith(resolve: (token?: string) => Promise<typeof IDENTITY | null>) {
  const seen: (string | undefined)[] = [];
  const guard = new PlatformAdminGuard({
    resolve: async (token?: string) => {
      seen.push(token);
      return resolve(token);
    },
  } as never);
  return { guard, seen };
}

function requestWith(headers: Record<string, string>) {
  const req: Record<string, unknown> = { headers };
  const context = { switchToHttp: () => ({ getRequest: () => req }) } as never;
  return { req, context };
}

const validOnly = async (token?: string) => (token === 'good-session' ? IDENTITY : null);

describe('the guard, from the shop’s side', () => {
  it('refuses a request carrying nothing', async () => {
    const { guard } = guardWith(validOnly);
    await expect(guard.canActivate(requestWith({}).context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a tenant JWT — an Owner’s, a Manager’s, an Employee’s — because it is not a platform session', async () => {
    // A tenant token is looked up as a platform session token and matches
    // nothing. The role behind it never comes into it: there is no path from
    // any store role to the platform table.
    const { guard, seen } = guardWith(validOnly);
    for (const jwt of ['owner.jwt.token', 'manager.jwt.token', 'employee.jwt.token']) {
      await expect(
        guard.canActivate(requestWith({ authorization: `Bearer ${jwt}` }).context),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect(seen).toEqual(['owner.jwt.token', 'manager.jwt.token', 'employee.jwt.token']);
  });

  it('refuses forged company and branch headers with no platform session behind them', async () => {
    const { guard } = guardWith(validOnly);
    const forged = requestWith({
      'x-company-id': '018f0000-0000-7000-8000-00000000c001',
      'x-branch-id': '018f0000-0000-7000-8000-00000000b001',
      authorization: 'Bearer owner.jwt.token',
    });
    await expect(guard.canActivate(forged.context)).rejects.toBeInstanceOf(UnauthorizedException);
    // And the guard never so much as reads them.
    expect(GUARD).not.toMatch(/x-company-id|x-branch-id|companyId|branchId/i);
  });

  it('admits a platform session from the HttpOnly cookie, and stashes what authenticated it', async () => {
    const { guard } = guardWith(validOnly);
    const { req, context } = requestWith({ cookie: 'theme=dark; erp_platform_session=good-session' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.platformAdmin).toEqual(IDENTITY);
    expect(req.platformSessionToken).toBe('good-session');
  });

  it('refuses a session whose administrator was disabled, expired or revoked — identically', async () => {
    // `resolve` answers null for all three; the guard cannot tell them apart
    // and neither can the caller.
    const { guard } = guardWith(async () => null);
    await expect(
      guard.canActivate(requestWith({ cookie: 'erp_platform_session=was-good-once' }).context),
    ).rejects.toThrow('Not signed in');
    expect(ADMINS).toMatch(/revokedAt: null,\s*expiresAt: \{ gt: new Date\(\) \}/);
    expect(ADMINS).toMatch(/!session\.admin\.isActive \|\| session\.admin\.deletedAt/);
  });

  it('accepts a bearer session outside production only', async () => {
    const { guard, seen } = guardWith(validOnly);
    await expect(
      guard.canActivate(requestWith({ authorization: 'Bearer good-session' }).context),
    ).resolves.toBe(true);

    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(
        guard.canActivate(requestWith({ authorization: 'Bearer good-session' }).context),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    } finally {
      process.env.NODE_ENV = env;
    }
    // In production the header was never even offered to the session lookup.
    expect(seen).toEqual(['good-session', undefined]);
  });
});

describe('the controller, from the platform’s side', () => {
  const PUBLIC_UNGUARDED = new Set([
    'register',
    'continueStart',
    'continueConfirm',
    'verifyStart',
    'verifyConfirm',
    'quote',
    'adminSignIn',
    'exchangePortalHandoff',
    'portalSignOut',
    'acceptOwnerInvitation',
  ]);
  const TENANT = new Set(['mySubscription', 'createPortalHandoff', 'paymentInstructions']);

  const proto = PlatformController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const handlers = Object.getOwnPropertyNames(proto).filter(
    (name) => name !== 'constructor' && Reflect.hasMetadata(PATH_METADATA, proto[name]),
  );
  const guardsOf = (name: string): unknown[] => Reflect.getMetadata(GUARDS_METADATA, proto[name]) ?? [];
  const isPublic = (name: string): boolean => Reflect.getMetadata(IS_PUBLIC_KEY, proto[name]) === true;
  const methodOf = (name: string): RequestMethod => Reflect.getMetadata(METHOD_METADATA, proto[name]);

  /** The handler's own source, decorators excluded. */
  function bodyOf(name: string): string {
    const start = CONTROLLER.search(new RegExp(`\\n  (?:async )?${name}\\(`));
    expect(start).toBeGreaterThan(0);
    const rest = CONTROLLER.slice(start + 1);
    const next = rest.search(/\n  (?:@|\/\/ ──|\/\*\*)/);
    return next < 0 ? rest : rest.slice(0, next);
  }

  it('has every route accounted for', () => {
    expect(handlers.length).toBeGreaterThanOrEqual(30);
    for (const name of [...PUBLIC_UNGUARDED, ...TENANT]) expect(handlers).toContain(name);
    for (const name of ['createBusiness', 'ownerInvitation', 'approve', 'reject', 'setPeriod', 'dashboard', 'businesses', 'auditLog']) {
      expect(handlers).toContain(name);
    }
  });

  it('every administrator route stands down the tenant guard AND stands behind the platform guard', () => {
    for (const name of handlers) {
      if (PUBLIC_UNGUARDED.has(name) || TENANT.has(name)) continue;
      expect({ name, isPublic: isPublic(name) }).toEqual({ name, isPublic: true });
      expect({ name, guarded: guardsOf(name).includes(PlatformAdminGuard) }).toEqual({ name, guarded: true });
    }
  });

  it('the genuinely public routes carry no platform guard, and the tenant routes carry no @Public', () => {
    for (const name of PUBLIC_UNGUARDED) {
      expect({ name, isPublic: isPublic(name) }).toEqual({ name, isPublic: true });
      expect({ name, guarded: guardsOf(name).includes(PlatformAdminGuard) }).toEqual({ name, guarded: false });
    }
    for (const name of TENANT) {
      expect({ name, isPublic: isPublic(name) }).toEqual({ name, isPublic: false });
      expect({ name, guarded: guardsOf(name).includes(PlatformAdminGuard) }).toEqual({ name, guarded: false });
    }
  });

  it('no administrator route reads the tenant context or a tenant header', () => {
    for (const name of handlers) {
      if (PUBLIC_UNGUARDED.has(name) || TENANT.has(name)) continue;
      const body = bodyOf(name);
      expect({ name, ok: !/this\.tenant\b/.test(body) }).toEqual({ name, ok: true });
      expect({ name, ok: !/x-company-id|x-branch-id/i.test(body) }).toEqual({ name, ok: true });
    }
    // The three tenant routes answer about the caller's OWN company, from the JWT.
    for (const name of TENANT) expect(bodyOf(name)).toMatch(/this\.tenant\.companyId\(\)/);
  });

  it('every administrator mutation re-asks for the password, except signing out', () => {
    for (const name of handlers) {
      if (PUBLIC_UNGUARDED.has(name) || TENANT.has(name) || name === 'adminSignOut') continue;
      if (methodOf(name) !== RequestMethod.POST) continue;
      expect({ name, stepUp: /confirmPassword\(/.test(bodyOf(name)) }).toEqual({ name, stepUp: true });
    }
  });

  it('the administrator reads never return a shop’s takings', () => {
    // Structural: the queries cannot select what the platform must not see.
    for (const name of ['business', 'businesses', 'dashboard', 'pending']) {
      const body = bodyOf(name);
      expect({ name, clean: !/\b(sale|saleItem|unit|payment|expense|costPrice|margin)\b\s*[:.]/.test(body) }).toEqual({
        name,
        clean: true,
      });
    }
    expect(CONTROLLER).not.toMatch(/impersonat/i);
  });

  it('creating a business mints an invitation once, and never a password anybody chose', () => {
    const body = bodyOf('createBusiness');
    expect(body).toMatch(/password: randomBytes\(48\)/);
    expect(body).toMatch(/if \(!result\.created\) \{\s*return \{ \.\.\.result, invitation: null \};/);
  });
});

describe('a closed business stays closed on the server', () => {
  function serviceWith(status: string, currentPeriodEnd: Date | null = null) {
    const prisma = {
      subscription: {
        findFirst: async () => ({
          status,
          currentPeriodEnd,
          isComplimentary: false,
          complimentaryUntil: null,
          subscribedBranchCount: 1,
          additionalSeats: 0,
        }),
      },
      branch: { count: async () => 1 },
      $queryRaw: async () => [{ n: 0n }],
    };
    const clock = { now: () => new Date('2026-06-15T12:00:00.000Z') };
    return new EntitlementService(prisma as never, {} as never, clock as never);
  }
  const company = Buffer.alloc(16, 7);

  it('names each closed state by its own code', async () => {
    await expect(serviceWith('pending_activation').operationalAccessBlocked(company)).resolves.toMatchObject({
      code: ENTITLEMENT_PENDING,
      state: 'pending',
    });
    await expect(serviceWith('rejected').operationalAccessBlocked(company)).resolves.toMatchObject({
      code: ENTITLEMENT_REJECTED,
      state: 'rejected',
    });
    await expect(serviceWith('suspended').operationalAccessBlocked(company)).resolves.toMatchObject({
      code: ENTITLEMENT_SUSPENDED,
      state: 'suspended',
    });
    await expect(serviceWith('cancelled').operationalAccessBlocked(company)).resolves.toMatchObject({
      code: ENTITLEMENT_SUSPENDED,
      state: 'cancelled',
    });
  });

  it('expiry still hides nothing, and none of the five may write', async () => {
    await expect(serviceWith('activated', null).operationalAccessBlocked(company)).resolves.toBeNull();
    for (const status of ['pending_activation', 'rejected', 'suspended', 'cancelled', 'activated']) {
      await expect(serviceWith(status, null).mayWrite(company)).resolves.toBe(false);
    }
  });

  it('is decided by the server clock and the subscription row — nothing the phone sends', () => {
    // No wall clock, no request, no header: the answer comes from the row and
    // the injected clock, so a changed phone date or an old build cannot move it.
    expect(ENTITLEMENT).not.toMatch(/new Date\(|Date\.now\(/);
    expect(ENTITLEMENT).not.toMatch(/req\.|headers/);
  });

  it('the only platform routes open to a locked tenant are its own account surface', () => {
    const allowedWrites = ALWAYS_ALLOWED.map((r) => r.path).filter((p) => p.startsWith('platform/'));
    const allowedReads = ALWAYS_READABLE.filter((p) => p.startsWith('platform/'));
    expect(allowedWrites).toEqual(['platform/portal-handoff']);
    expect(allowedReads).toEqual(['platform/my-subscription', 'platform/payment-instructions']);
  });
});
