import { UnauthorizedException } from '@nestjs/common';
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

    const result = await strategy.validate(payload());

    // Stage 3 added `sessionId`: device routes must be able to answer "which
    // device is this request on?" from the token, never from a client header.
    expect(result).toEqual({ userId: USER, companyId: COMPANY, sessionId: SID });
    expect(cls.set).toHaveBeenCalledWith('userId', USER);
    expect(cls.set).toHaveBeenCalledWith('companyId', expect.any(Buffer));
  });

  it('checks the session id and the caller together', async () => {
    const isValid = jest.fn(async () => true);
    const { strategy } = makeStrategy(isValid);

    await strategy.validate(payload());

    expect(isValid).toHaveBeenCalledWith(expect.any(Buffer), USER);
  });

  it('rejects when the session is invalid (revoked/expired) or the user is inactive', async () => {
    const { strategy } = makeStrategy(jest.fn(async () => false));

    await expect(strategy.validate(payload())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token that is not an access token', async () => {
    const { strategy, isAccessValid } = makeStrategy(jest.fn(async () => true));

    await expect(strategy.validate(payload({ type: 'refresh' as never }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(isAccessValid).not.toHaveBeenCalled();
  });

  it('rejects a legacy token with no session binding (sid missing)', async () => {
    const { strategy, isAccessValid } = makeStrategy(jest.fn(async () => true));

    await expect(strategy.validate(payload({ sid: undefined as never }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(isAccessValid).not.toHaveBeenCalled();
  });

  it('rejects a malformed sid without hitting the database', async () => {
    const { strategy, isAccessValid } = makeStrategy(jest.fn(async () => true));

    await expect(strategy.validate(payload({ sid: 'not-a-uuid' }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(isAccessValid).not.toHaveBeenCalled();
  });
});
