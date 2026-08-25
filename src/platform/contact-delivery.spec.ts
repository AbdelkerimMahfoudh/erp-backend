import { codeMayBeReturned, outboxAllowed } from './contact-delivery';

/**
 * Which environment may use the outbox, and which may see a code.
 *
 * Two separate gates on purpose, and the difference matters: staging USES the
 * outbox but must never return a code in a response, because a code in a
 * response body makes the whole verification meaningless.
 */
describe('the outbox is an explicit opt-in', () => {
  it('production never gets it, whatever else is set', () => {
    expect(outboxAllowed({ APP_ENV: 'production', NODE_ENV: 'production' })).toBe(false);
    // Even if somebody sets the staging flag by accident.
    expect(
      outboxAllowed({ APP_ENV: 'production', STAGING_CONTACT_OUTBOX: 'enabled' } as never),
    ).toBe(false);
    expect(outboxAllowed({ NODE_ENV: 'production' })).toBe(false);
  });

  it('staging gets it only when it says so deliberately', () => {
    /*
      Staging runs with NODE_ENV=production so it exercises production code
      paths. Without its own flag it would inherit the refusal — and with the
      OLD rule ("anything not production") any unlabelled environment would
      have silently got an outbox standing in for a real provider.
    */
    expect(outboxAllowed({ APP_ENV: 'staging', NODE_ENV: 'production' })).toBe(false);
    expect(
      outboxAllowed({
        APP_ENV: 'staging',
        NODE_ENV: 'production',
        STAGING_CONTACT_OUTBOX: 'enabled',
      } as never),
    ).toBe(true);
  });

  it('ordinary local development gets it without ceremony', () => {
    expect(outboxAllowed({ NODE_ENV: 'development' })).toBe(true);
    expect(outboxAllowed({})).toBe(true);
  });
});

describe('a code may be returned in a response only in development', () => {
  it('never in staging, even though staging uses the outbox', () => {
    expect(
      codeMayBeReturned({
        APP_ENV: 'staging',
        NODE_ENV: 'production',
        STAGING_CONTACT_OUTBOX: 'enabled',
      } as never),
    ).toBe(false);
  });

  it('never in production', () => {
    expect(codeMayBeReturned({ APP_ENV: 'production' })).toBe(false);
    expect(codeMayBeReturned({ NODE_ENV: 'production' })).toBe(false);
  });

  it('but yes in local development, where it is a convenience', () => {
    expect(codeMayBeReturned({ NODE_ENV: 'development' })).toBe(true);
  });

  it('and it is strictly stricter than the outbox gate', () => {
    // Anywhere a code may be returned, the outbox must also be allowed —
    // otherwise there would be no code to return.
    const envs = [
      { NODE_ENV: 'development' },
      { APP_ENV: 'staging', NODE_ENV: 'production', STAGING_CONTACT_OUTBOX: 'enabled' },
      { APP_ENV: 'production' },
      { NODE_ENV: 'production' },
    ];
    for (const e of envs) {
      if (codeMayBeReturned(e as never)) expect(outboxAllowed(e as never)).toBe(true);
    }
  });
});
