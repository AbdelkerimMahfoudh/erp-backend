import { cookieSecure } from './cookies';

/**
 * A `Secure` cookie on a plain-HTTP origin is not a stricter cookie. It is no
 * cookie at all: the browser discards it without a word, and the only visible
 * symptom is that the user is asked to sign in again.
 *
 * Found live during the CP8 acceptance. The same handoff landed signed in on
 * `http://localhost:8088` and landed on a password form on
 * `http://192.168.100.3:8088`, because browsers treat localhost as trustworthy
 * and every other plain-HTTP origin as not.
 */
describe('when session cookies are marked Secure', () => {
  it('is on in production by default', () => {
    expect(cookieSecure({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('is off outside production by default', () => {
    expect(cookieSecure({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(false);
    expect(cookieSecure({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('lets a plain-HTTP staging host turn it off without pretending not to be production', () => {
    // `.env.staging` deliberately sets NODE_ENV=production for a production-like
    // build. That must not decide a transport question.
    const env = { NODE_ENV: 'production', COOKIE_SECURE: 'false' } as NodeJS.ProcessEnv;
    expect(cookieSecure(env)).toBe(false);
  });

  it('lets a TLS-terminated non-production host turn it on', () => {
    expect(cookieSecure({ NODE_ENV: 'development', COOKIE_SECURE: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('accepts 1 and 0, and is not case- or space-sensitive', () => {
    expect(cookieSecure({ COOKIE_SECURE: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(cookieSecure({ COOKIE_SECURE: '0', NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(false);
    expect(cookieSecure({ COOKIE_SECURE: ' TRUE ' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('falls back to NODE_ENV rather than guessing at a value it does not understand', () => {
    // "yes" is not a value this accepts, and quietly reading it as false would
    // turn Secure OFF in production on a typo.
    const env = { NODE_ENV: 'production', COOKIE_SECURE: 'yes' } as NodeJS.ProcessEnv;
    expect(cookieSecure(env)).toBe(true);
  });
});
