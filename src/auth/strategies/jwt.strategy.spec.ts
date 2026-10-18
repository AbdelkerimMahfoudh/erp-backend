import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { portalCsrfToken } from '../../common/http/portal-csrf';
import { JwtStrategy } from './jwt.strategy';
import { AccessTokenPayload } from '../../common/types/auth-user';
import { binToUuid, newUuidV7Bin } from '../../common/utils/uuid.util';

/**
 * The access token is only as good as the session behind it. These tests pin the
 * F1.1 rule: a request is authorized only when its `sid` names a live session and
 * the user is still active — so revoking sessions (what deactivation does) or
 * deactivating the user cuts the token off immediately.
 */
const USER = binToUuid(newUuidV7Bin());
const COMPANY = binToUuid(newUuidV7Bin());
const SID = binToUuid(newUuidV7Bin());

function makeStrategy(isAccessValid: jest.Mock) {
  const cls = { set: jest.fn() };
  const strategy = new JwtStrategy(
    { jwtAccessSecret: 'test-secret' } as never,
    cls as never,
    { isAccessValid } as never,
  );
  return { strategy, cls, isAccessValid };
}

/** A request from the app: a bearer token, on any route. */
const APP = { method: 'POST', originalUrl: '/api/v1/sales', headers: { authorization: 'Bearer x.y.z' } };

const payload = (over: Partial<AccessTokenPayload> = {}): AccessTokenPayload => ({
  sub: USER,
  companyId: COMPANY,
  type: 'access',
  sid: SID,
  ...over,
});

describe('JwtStrategy.validate', () => {
  it('accepts a valid access token backed by a live session', async () => {
    const { strategy, cls } = makeStrategy(jest.fn(async () => true));

    const result = await strategy.validate(APP, payload());

    // Stage 3 added `sessionId`: device routes must be able to answer "which
    // device is this request on?" from the token, never from a client header.
    expect(result).toEqual({ userId: USER, companyId: COMPANY, sessionId: SID });
    expect(cls.set).toHaveBeenCalledWith('userId', USER);
    expect(cls.set).toHaveBeenCalledWith('companyId', expect.any(Buffer));
  });

  it('checks the session id and the caller together', async () => {
    const isValid = jest.fn(async () => true);
    const { strategy } = makeStrategy(isValid);

    await strategy.validate(APP, payload());

    expect(isValid).toHaveBeenCalledWith(expect.any(Buffer), USER);
  });

  it('rejects when the session is invalid (revoked/expired) or the user is inactive', async () => {
    const { strategy } = makeStrategy(jest.fn(async () => false));

    await expect(strategy.validate(APP, payload())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token that is not an access token', async () => {
    const { strategy, isAccessValid } = makeStrategy(jest.fn(async () => true));

    await expect(strategy.validate(APP, payload({ type: 'refresh' as never }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(isAccessValid).not.toHaveBeenCalled();
  });

  it('rejects a legacy token with no session binding (sid missing)', async () => {
    const { strategy, isAccessValid } = makeStrategy(jest.fn(async () => true));

    await expect(strategy.validate(APP, payload({ sid: undefined as never }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(isAccessValid).not.toHaveBeenCalled();
  });

  it('rejects a malformed sid without hitting the database', async () => {
    const { strategy, isAccessValid } = makeStrategy(jest.fn(async () => true));

    await expect(strategy.validate(APP, payload({ sid: 'not-a-uuid' }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(isAccessValid).not.toHaveBeenCalled();
  });
});

describe('the portal cookie (0099): the portal’s routes only, and the session’s CSRF token on every unsafe request', () => {
  const cookie = (method: string, path: string, headers: Record<string, string> = {}) => ({
    method,
    originalUrl: path,
    headers: { cookie: 'erp_portal_session=x.y.z', ...headers },
  });
  const csrf = portalCsrfToken('test-secret', SID);

  it('reads the Owner’s subscription and its own session — never another tenant route, even a read', async () => {
    const { strategy } = makeStrategy(jest.fn(async () => true));
    for (const path of ['/api/v1/platform/my-subscription', '/api/v1/platform/my-subscription/trial', '/api/v1/platform/portal/session', '/api/v1/platform/payment-instructions?x=1']) {
      await expect(strategy.validate(cookie('GET', path), payload())).resolves.toMatchObject({ userId: USER });
    }
    for (const path of ['/api/v1/sales', '/api/v1/account', '/api/v1/platform/businesses', '/api/v1/platform/my-subscriptionx', '/api/v2/inventory']) {
      await expect(strategy.validate(cookie('GET', path), payload())).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });

  it('an unsafe request needs the session’s own token — absent, wrong or another session’s is refused before the session is read', async () => {
    const isAccessValid = jest.fn(async () => true);
    const { strategy } = makeStrategy(isAccessValid);
    const claim = '/api/v1/platform/my-subscription/trial/claim';
    const attempts: Record<string, string>[] = [{}, { 'x-csrf-token': 'nope' }, { 'x-csrf-token': portalCsrfToken('test-secret', binToUuid(newUuidV7Bin())) }, { 'x-csrf-token': portalCsrfToken('other-secret', SID) }];
    for (const headers of attempts) {
      const refused = await strategy.validate(cookie('POST', claim, headers), payload()).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(ForbiddenException);
      expect((refused as ForbiddenException).getResponse()).toMatchObject({ code: 'csrf_failed' });
    }
    expect(isAccessValid).not.toHaveBeenCalled();
    await expect(strategy.validate(cookie('POST', claim, { 'x-csrf-token': csrf }), payload())).resolves.toMatchObject({ userId: USER });
  });

  it('no Origin or Referer opens anything: a matching Origin without the token is still refused', async () => {
    const { strategy } = makeStrategy(jest.fn(async () => true));
    const refused = strategy.validate(
      cookie('POST', '/api/v1/platform/my-subscription/trial/claim', { origin: 'https://dukan.tsxmr.com', referer: 'https://dukan.tsxmr.com/subscription' }),
      payload(),
    );
    await expect(refused).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a bearer needs no token anywhere: nothing attaches a bearer on its own', async () => {
    const { strategy } = makeStrategy(jest.fn(async () => true));
    await expect(strategy.validate({ ...APP, headers: { ...APP.headers, cookie: 'erp_portal_session=x' } }, payload())).resolves.toMatchObject({ userId: USER });
  });
});
