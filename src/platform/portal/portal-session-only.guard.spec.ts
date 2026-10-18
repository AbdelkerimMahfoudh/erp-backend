import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { codeOf } from '../__testing__/route-table';
import { PORTAL_SESSION_REQUIRED, PortalSessionOnlyGuard } from './portal-session-only.guard';

/**
 * The portal's own session (D211; docs/101 §5): the free trial's claim and the instructions' resend are made with the
 * session the portal's sign-in opened, never with the app's bearer token — and nothing a client says about where it
 * comes from is read.
 */

const contextFor = (headers: Record<string, string>) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) }) as unknown as ExecutionContext;

function refusal(headers: Record<string, string>): unknown {
  try {
    new PortalSessionOnlyGuard().canActivate(contextFor(headers));
  } catch (e) {
    return e;
  }
  return null;
}

describe('the portal’s own session (D211)', () => {
  it('lets the portal cookie through when no bearer token rides with it', () => {
    expect(new PortalSessionOnlyGuard().canActivate(contextFor({ cookie: 'lang=fr; erp_portal_session=x.y.z' }))).toBe(true);
  });

  it('refuses a bearer token — the app’s session — whatever cookie rides with it', () => {
    const attempts: Record<string, string>[] = [
      { authorization: 'Bearer a.b.c' },
      { authorization: 'Bearer a.b.c', cookie: 'erp_portal_session=x.y.z' },
      { authorization: 'Basic eA==', cookie: 'erp_portal_session=x.y.z' },
    ];
    for (const headers of attempts) {
      expect({ headers, refused: refusal(headers) instanceof ForbiddenException }).toEqual({ headers, refused: true });
    }
  });

  it('refuses a request with no portal session — the refresh cookie, the administrator’s or a look-alike name are not it', () => {
    for (const cookie of ['', 'erp_portal_refresh=r', 'erp_platform_session=s', 'xerp_portal_session=x']) {
      expect({ cookie, refused: refusal(cookie ? { cookie } : {}) instanceof ForbiddenException }).toEqual({ cookie, refused: true });
    }
  });

  it('answers with the code the portal reads, and nothing about the request', () => {
    expect((refusal({ authorization: 'Bearer a.b.c' }) as ForbiddenException).getResponse()).toEqual(PORTAL_SESSION_REQUIRED);
  });

  it('reads which credential authenticated the request — never an Origin, a Referer or a header a client sets about itself', () => {
    const code = codeOf('src/platform/portal/portal-session-only.guard.ts');
    expect(code).not.toMatch(/origin|referer|referrer|x-forwarded|user-agent|host/i);
    expect(code).toMatch(/headers\?\.authorization/);
    expect(code).toMatch(/PORTAL_SESSION_COOKIE/);
  });
});
