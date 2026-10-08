import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { RequestMethod, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PlatformController } from './platform.controller';
import { PlatformAdminGuard } from './platform-admin.guard';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { ALWAYS_ALLOWED, ALWAYS_READABLE } from '../entitlement/route-classification';
import { SeatRequestsController } from './seat-requests.controller';
import {
  PAYMENT_PROVIDER_CATALOGUE,
  PLACEHOLDER_CODE,
  assertPaymentInstructionsSafeForProduction,
  paymentInstructions,
} from './payment-instructions';
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
const MAIN = readFileSync('src/main.ts', 'utf8');

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

  it('no public route answers with a price — the quote by company id is gone (2026-10-05)', () => {
    /*
     * `GET platform/quote/:id` returned a company's size and its monthly price
     * to anybody holding its id, with no credential. Prices belong to the
     * website's commercial contract and the platform's own tools (docs/68);
     * the Owner's own figure stays on the tenant route `my-subscription`.
     */
    expect(handlers).not.toContain('quote');
    expect(CONTROLLER).not.toMatch(/@Get\('quote/);
    for (const name of PUBLIC_UNGUARDED) {
      expect({ name, pricing: /this\.billing\./.test(bodyOf(name)) }).toEqual({ name, pricing: false });
    }
  });

  describe('registration is refused before anything is created when no code can be delivered (2026-10-05)', () => {
    const stub = {} as never;
    function controllerWith(registration: unknown, delivery: unknown) {
      return new PlatformController(
        stub, stub, stub, stub,
        registration as never,
        stub, stub, stub, stub, stub, stub, stub,
        delivery as never,
      );
    }
    const attempt = {
      idempotencyKey: 'k-1',
      ownerName: 'Aicha',
      businessName: 'Boutique Aicha',
      branchName: 'Main',
      email: 'aicha@example.test',
      phone: '+22243210987',
      password: 'password-1',
      language: 'en' as const,
    };

    it('refuses with its own code, and the database is never reached', async () => {
      const reached: string[] = [];
      const controller = controllerWith(
        { register: async () => { reached.push('register'); throw new Error('must not be reached'); } },
        { name: 'none', canDeliver: () => false },
      );
      const refusal = await controller.register(attempt as never).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(ServiceUnavailableException);
      expect((refusal as ServiceUnavailableException).getResponse()).toMatchObject({ code: 'registration_unavailable' });
      expect(JSON.stringify((refusal as ServiceUnavailableException).getResponse())).toMatch(/Nothing was saved/);
      expect(reached).toEqual([]);
    });

    it('asks about the channel the Owner record will carry: the email when one is given, else the number', async () => {
      const asked: string[] = [];
      const controller = controllerWith({ register: async () => { throw new Error('must not be reached'); } }, {
        canDeliver: (channel: string) => { asked.push(channel); return false; },
      });
      await controller.register(attempt as never).catch(() => undefined);
      await controller.register({ ...attempt, email: undefined } as never).catch(() => undefined);
      await controller.register({ ...attempt, email: '   ' } as never).catch(() => undefined);
      expect(asked).toEqual(['email', 'phone', 'phone']);
    });

    it('and proceeds exactly as before once a code can go out', async () => {
      const seen: string[] = [];
      const controller = controllerWith(
        {
          register: async (input: { email?: string }) => {
            seen.push(input.email ?? '');
            return { companyId: 'c', publicStoreId: 'ABCDEF0123', branchId: 'b', ownerUserId: 'u', status: 'pending_activation', created: true };
          },
          pendingOwnerFor: async () => null,
        },
        { canDeliver: (channel: string) => channel === 'email' },
      );
      await expect(controller.register(attempt as never)).resolves.toMatchObject({ created: true, next: 'sign_in', continuation: null });
      expect(seen).toEqual(['aicha@example.test']);
    });
  });
});

describe('payment instructions serve no stand-in (2026-10-05)', () => {
  it('nothing is offered until a real code exists: unavailable, no provider, no code', () => {
    const answer = paymentInstructions();
    expect(answer).toEqual({ available: false, providers: [], defaultProvider: null, placeholder: false });
    expect(JSON.stringify(answer)).not.toContain(PLACEHOLDER_CODE);
    for (const p of PAYMENT_PROVIDER_CATALOGUE) {
      expect({ key: p.key, offeredStandIn: p.enabled && p.placeholder }).toEqual({ key: p.key, offeredStandIn: false });
    }
  });

  it('an offered provider with a real code is served, Bankily first', () => {
    const real = PAYMENT_PROVIDER_CATALOGUE.map((p) => ({ ...p, enabled: true, code: `${p.order}2345`, placeholder: false }));
    const answer = paymentInstructions(real);
    expect(answer.available).toBe(true);
    expect(answer.defaultProvider).toBe('bankily');
    expect(answer.placeholder).toBe(false);
    expect(answer.providers.map((p) => p.key)).toEqual(['bankily', 'masrivi', 'sedad', 'bimbank', 'click']);
  });

  it('production refuses to boot the moment a stand-in would be offered — and boot asks', () => {
    const production = { APP_ENV: 'production' } as NodeJS.ProcessEnv;
    expect(() => assertPaymentInstructionsSafeForProduction(production)).not.toThrow();
    const offeredStub = PAYMENT_PROVIDER_CATALOGUE.map((p) => ({ ...p, enabled: true }));
    expect(() => assertPaymentInstructionsSafeForProduction(production, offeredStub)).toThrow(/placeholder/);
    expect(() => assertPaymentInstructionsSafeForProduction({ NODE_ENV: 'production' } as NodeJS.ProcessEnv, offeredStub)).toThrow();
    expect(() =>
      assertPaymentInstructionsSafeForProduction({ NODE_ENV: 'production', APP_ENV: 'staging' } as NodeJS.ProcessEnv, offeredStub),
    ).not.toThrow();
    expect(MAIN).toMatch(/^\s*assertPaymentInstructionsSafeForProduction\(\);/m);
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
    // Asking to pay for a seat or a store is the one thing a lapsed or pending shop most needs
    // to be allowed (docs/21, 2026-10-05); nothing is granted by asking. Asking for another
    // activity for a branch (D154, 2026-10-08) is the same kind of request: an upgrade waits for
    // its payment, a downgrade waits for the renewal, and nothing changes by asking.
    expect(allowedWrites).toEqual([
      'platform/my-subscription/seat-requests',
      'platform/my-subscription/store-requests',
      'platform/my-subscription/seat-requests/:rid/withdraw',
      'platform/my-subscription/activity-requests',
      'platform/portal-handoff',
    ]);
    expect(allowedReads).toEqual(['platform/my-subscription', 'platform/payment-instructions']);
  });
});

describe('the seat-requests controller keeps the same three realms (docs/21, 2026-10-05)', () => {
  const PUBLIC_UNGUARDED = new Set(['plan', 'quote']);
  // `requestActivity` (D154, 2026-10-08): the Owner asks for another activity for a branch —
  // a tenant route like the seat and store requests, priced by the server, never an amount.
  const TENANT = new Set(['mySeatRequests', 'requestSeat', 'requestStore', 'requestActivity', 'withdrawSeatRequest']);
  const SOURCE = readFileSync('src/platform/seat-requests.controller.ts', 'utf8');

  const proto = SeatRequestsController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const handlers = Object.getOwnPropertyNames(proto).filter(
    (name) => name !== 'constructor' && Reflect.hasMetadata(PATH_METADATA, proto[name]),
  );
  const guardsOf = (name: string): unknown[] => Reflect.getMetadata(GUARDS_METADATA, proto[name]) ?? [];
  const isPublic = (name: string): boolean => Reflect.getMetadata(IS_PUBLIC_KEY, proto[name]) === true;
  const methodOf = (name: string): RequestMethod => Reflect.getMetadata(METHOD_METADATA, proto[name]);

  function bodyOf(name: string): string {
    const start = SOURCE.search(new RegExp(`\\n  (?:async )?${name}\\(`));
    expect(start).toBeGreaterThan(0);
    const rest = SOURCE.slice(start + 1);
    const next = rest.search(/\n  (?:@|\/\/ ──|\/\*\*|private )/);
    return next < 0 ? rest : rest.slice(0, next);
  }

  it('has every route accounted for', () => {
    for (const name of [...PUBLIC_UNGUARDED, ...TENANT, 'seatRequests', 'businessSeatRequests', 'confirmSeatPayment', 'refuseSeatRequest', 'releaseSeat']) {
      expect(handlers).toContain(name);
    }
  });

  it('administrator routes stand down the tenant guard and stand behind the platform guard; the others do not', () => {
    for (const name of handlers) {
      const admin = !PUBLIC_UNGUARDED.has(name) && !TENANT.has(name);
      expect({ name, isPublic: isPublic(name) }).toEqual({ name, isPublic: admin || PUBLIC_UNGUARDED.has(name) });
      expect({ name, guarded: guardsOf(name).includes(PlatformAdminGuard) }).toEqual({ name, guarded: admin });
    }
  });

  it('every administrator mutation re-asks for the password', () => {
    for (const name of handlers) {
      if (PUBLIC_UNGUARDED.has(name) || TENANT.has(name)) continue;
      if (methodOf(name) === RequestMethod.GET) continue;
      expect({ name, ok: /confirmPassword\(admin\.id, dto\.confirmPassword\)/.test(bodyOf(name)) }).toEqual({ name, ok: true });
    }
  });

  it('no administrator route reads the tenant context; every tenant route answers about the caller’s own company', () => {
    for (const name of handlers) {
      if (PUBLIC_UNGUARDED.has(name) || TENANT.has(name)) continue;
      expect({ name, ok: !/this\.tenant\b/.test(bodyOf(name)) }).toEqual({ name, ok: true });
    }
    for (const name of TENANT) expect(bodyOf(name)).toMatch(/this\.tenant\.companyId\(\)/);
  });

  it('a customer never approves their own payment: confirming, refusing and releasing exist only behind the platform guard', () => {
    for (const name of ['confirmSeatPayment', 'refuseSeatRequest', 'releaseSeat']) {
      expect(guardsOf(name).includes(PlatformAdminGuard)).toBe(true);
    }
    // And no tenant route carries an amount, a status or a confirmation flag.
    for (const name of TENANT) expect(bodyOf(name)).not.toMatch(/amount|confirm|status:/);
  });

  it('a payment confirmation requires a reference and records that no provider verified it', () => {
    const service = readFileSync('src/platform/seat-allocation.service.ts', 'utf8');
    expect(service).toMatch(/reference_required/);
    expect(service).toMatch(/providerVerified: false/);
    expect(bodyOf('confirmSeatPayment')).toMatch(/reference: dto\.reference \?\? ''/);
  });

  it('the public routes answer with prices and an estimate only — never a business', () => {
    expect(bodyOf('plan')).toMatch(/publicPlan\(\)/);
    // The estimate takes one activity per store since D154; still the stores and nothing about a business.
    expect(bodyOf('quote')).toMatch(/estimate\(dto\.stores, dto\.activities \?\? \[\]\)/);
    for (const name of PUBLIC_UNGUARDED) expect(bodyOf(name)).not.toMatch(/companyId|business/);
  });
});
