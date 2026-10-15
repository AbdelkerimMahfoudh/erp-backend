import { scrubHeaders, scrubQuery, scrubUrl, REDACTED } from './log-scrub';

/**
 * The portal-handoff ticket must not reach a log file.
 *
 * This is a regression test for something found live, not a hypothetical: the
 * CP8 staging acceptance grepped one run's API log and found the ticket twelve
 * times, in full, because `autoLogging` writes the request URL and
 * `redact.paths` cannot see inside one.
 */
describe('log scrubbing of credential-bearing query parameters', () => {
  it('redacts the portal handoff ticket', () => {
    expect(scrubUrl('/api/v1/platform/portal-session?t=jChEZYMOfcBtyJqsupz6BiXm')).toBe(
      `/api/v1/platform/portal-session?t=${REDACTED}`,
    );
  });

  it('redacts the other credentials that travel in a URL', () => {
    for (const key of ['token', 'code', 'continuation', 'secret']) {
      expect(scrubUrl(`/x?${key}=abcdef123456`)).toBe(`/x?${key}=${REDACTED}`);
    }
  });

  it('is case-insensitive about the parameter name', () => {
    expect(scrubUrl('/x?T=abcdef123456')).toBe(`/x?T=${REDACTED}`);
  });

  it('keeps the path and every innocent parameter, so a request is still followable', () => {
    expect(scrubUrl('/api/v1/platform/portal-session?page=2&t=secret-ticket&sort=name')).toBe(
      `/api/v1/platform/portal-session?page=2&t=${REDACTED}&sort=name`,
    );
  });

  it('leaves a URL with nothing to hide exactly as it was', () => {
    // Identity, not merely equality: an untouched URL must not be re-encoded.
    const url = '/api/v1/sales?branch=main&from=2026-01-01';
    expect(scrubUrl(url)).toBe(url);
    expect(scrubUrl('/api/v1/health')).toBe('/api/v1/health');
  });

  it('survives what a logger will actually hand it', () => {
    expect(scrubUrl(undefined)).toBeUndefined();
    expect(scrubUrl(null)).toBeNull();
    expect(scrubUrl(42)).toBe(42);
    expect(scrubUrl('/x?')).toBe('/x?');
    expect(scrubUrl('/x?t=')).toBe(`/x?t=${REDACTED}`);
  });

  it('redacts the parsed query object too', () => {
    // pino-http logs `req.query` alongside `req.url`; redacting one is half a fix.
    expect(scrubQuery({ t: 'secret-ticket', page: '2' })).toEqual({ t: REDACTED, page: '2' });
  });

  it('returns an innocent query object unchanged', () => {
    const q = { page: '2' };
    expect(scrubQuery(q)).toBe(q);
    expect(scrubQuery(undefined)).toBeUndefined();
    expect(scrubQuery(null)).toBeNull();
  });
});

describe('log scrubbing of what a person searched for (privacy correction, 2026-10-12)', () => {
  it('a customer, a business or a number typed into a search never reaches a log line', () => {
    expect(scrubUrl('/api/v1/customers?search=Aminetou%2036123456&page=2')).toBe(`/api/v1/customers?search=${REDACTED}&page=2`);
    expect(scrubUrl('/api/v1/platform/businesses?q=Boutique')).toBe(`/api/v1/platform/businesses?q=${REDACTED}`);
    expect(scrubUrl('/api/v1/connections?q=36123456')).toBe(`/api/v1/connections?q=${REDACTED}`);
    expect(scrubQuery({ search: 'Aminetou', page: '2' })).toEqual({ search: REDACTED, page: '2' });
    expect(scrubUrl('/api/v1/sales?page=2')).toBe('/api/v1/sales?page=2');
  });
});

describe('log scrubbing of every other credential a request may carry (C16)', () => {
  it('the WhatsApp webhook’s verify token, on its own subscription check', () => {
    expect(scrubUrl('/api/v1/messaging/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=s3cr3t-verify&hub.challenge=42')).toBe(
      `/api/v1/messaging/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${REDACTED}&hub.challenge=42`,
    );
    expect(scrubQuery({ 'hub.mode': 'subscribe', 'hub.verify_token': 's3cr3t-verify' })).toEqual({ 'hub.mode': 'subscribe', 'hub.verify_token': REDACTED });
  });

  it('a credential this API takes in a body, sent in a URL by mistake', () => {
    for (const key of ['password', 'confirmPassword', 'currentPassword', 'refreshToken', 'access_token', 'recoveryCode', 'enrolmentToken', 'deviceSecret', 'pin']) {
      expect(scrubUrl(`/x?${key}=abcdef123456&page=2`)).toBe(`/x?${key}=${REDACTED}&page=2`);
    }
  });

  it('a Referer is a URL like any other: the page’s query is scrubbed, every other header left as it is', () => {
    const headers = { referer: 'https://dukan.example.test/account/trial?t=abc_DEF-123', 'user-agent': 'Mozilla/5.0', 'x-request-id': 'r-1' };
    expect(scrubHeaders(headers)).toEqual({ ...headers, referer: `https://dukan.example.test/account/trial?t=${REDACTED}` });
    const innocent = { 'user-agent': 'Dukan/1.0' };
    expect(scrubHeaders(innocent)).toBe(innocent);
    expect(scrubHeaders(undefined)).toBeUndefined();
  });
});
