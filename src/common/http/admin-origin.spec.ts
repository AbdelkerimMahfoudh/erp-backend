import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AdminOriginGuard, PlatformAdminGuard } from '../../platform/platform-admin.guard';
import { adminOriginAllowed, adminOrigins } from './admin-origin';

const ADMIN = 'https://admin.tsxmr.com';

const contextOf = (method: string, origin?: string, cookie?: string) =>
  ({
    getHandler: () => () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ method, headers: { ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) } }) }),
  }) as unknown as ExecutionContext;

describe('the administrator origin rule', () => {
  it('is not enforced until ADMIN_ORIGINS names an origin', () => {
    expect(adminOrigins({})).toEqual([]);
    expect(adminOriginAllowed('POST', 'https://dukan.tsxmr.com', [])).toBe(true);
  });

  it('reads a list exactly', () => {
    expect(adminOrigins({ ADMIN_ORIGINS: ` ${ADMIN} , https://dukan-test.tsxmr.com,` })).toEqual([ADMIN, 'https://dukan-test.tsxmr.com']);
  });

  it.each(['https://dukan.tsxmr.com', 'https://erp-test.tsxmr.com', 'https://tsxmr.com', 'null', `${ADMIN}.evil.example`, 'http://admin.tsxmr.com'])('refuses %s on every method', (origin) => {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) expect(adminOriginAllowed(method, origin, [ADMIN])).toBe(false);
  });

  it('allows its own origin, and no origin only on a safe method', () => {
    expect(adminOriginAllowed('POST', ADMIN, [ADMIN])).toBe(true);
    expect(adminOriginAllowed('GET', undefined, [ADMIN])).toBe(true);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(adminOriginAllowed(method, undefined, [ADMIN])).toBe(false);
  });
});

describe('the guards apply it', () => {
  const before = process.env.ADMIN_ORIGINS;
  beforeEach(() => {
    process.env.ADMIN_ORIGINS = ADMIN;
  });
  afterEach(() => {
    if (before === undefined) delete process.env.ADMIN_ORIGINS;
    else process.env.ADMIN_ORIGINS = before;
  });

  it('sign-in and setup refuse another origin before reading anything', () => {
    const guard = new AdminOriginGuard();
    expect(() => guard.canActivate(contextOf('POST', 'https://dukan.tsxmr.com'))).toThrow(ForbiddenException);
    expect(guard.canActivate(contextOf('POST', ADMIN))).toBe(true);
  });

  it('a valid administrator session from another origin never reaches its session lookup', async () => {
    const admins = { resolveSession: jest.fn() };
    const guard = new PlatformAdminGuard(admins as never);
    await expect(guard.canActivate(contextOf('GET', 'https://dukan.tsxmr.com', 'erp_platform_session=x'))).rejects.toThrow(ForbiddenException);
    expect(admins.resolveSession).not.toHaveBeenCalled();
  });

  it('from its own origin the session rules still decide', async () => {
    const guard = new PlatformAdminGuard({ resolveSession: jest.fn().mockResolvedValue(null) } as never);
    await expect(guard.canActivate(contextOf('GET', ADMIN))).rejects.toThrow(UnauthorizedException);
  });

  it('a customer portal cookie gives nothing on the administrator origin', async () => {
    const admins = { resolveSession: jest.fn().mockResolvedValue(null) };
    const guard = new PlatformAdminGuard(admins as never);
    await expect(guard.canActivate(contextOf('GET', ADMIN, 'erp_portal_session=owner'))).rejects.toThrow(UnauthorizedException);
    expect(admins.resolveSession).toHaveBeenCalledWith(undefined);
  });
});
