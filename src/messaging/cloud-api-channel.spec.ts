import { Logger } from '@nestjs/common';
import { CloudApiConfig, CloudApiWhatsAppChannel, classifyGraphFailure } from './cloud-api-channel';
import { ACCOUNT_DELETION_TEMPLATE, AUTH_OTP_TEMPLATE, TRIAL_SETUP_TEMPLATE } from './templates';

/**
 * The Cloud API adapter (docs/64 §3).
 *
 * What is proven here, against a recorded fetch: the request the provider
 * receives (template name from configuration, language code, the number
 * without its plus sign, the token in a header and nowhere else), and the
 * classification of every answer the provider can give — accepted with a
 * message id, refused, throttled, unauthorised, unreachable, too slow. Nothing
 * here reaches a network.
 */

type Call = { url: string; init: RequestInit };

function fakeFetch(
  respond: (call: Call) => Promise<Response> | Response,
): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function config(overrides: Partial<CloudApiConfig> = {}): CloudApiConfig {
  return {
    baseUrl: 'https://graph.example.test/',
    apiVersion: 'v21.0',
    phoneNumberId: '1234567890',
    accessToken: 'EAAB-secret-token',
    timeoutMs: 200,
    templateNames: {
      [AUTH_OTP_TEMPLATE.key]: 'erp_auth_code',
      [ACCOUNT_DELETION_TEMPLATE.key]: 'erp_delete_code',
      [TRIAL_SETUP_TEMPLATE.key]: 'erp_trial_setup',
    },
    languageCodes: { en: 'en', fr: 'fr', ar: 'ar' },
    ...overrides,
  };
}

const otp = {
  to: '+22231234567',
  template: AUTH_OTP_TEMPLATE.key,
  language: 'fr' as const,
  variables: { code: '482913', ttlMinutes: '5' },
  idempotencyKey: 'k1',
};

describe('the request the provider receives', () => {
  it('names the approved template from configuration, never the internal key', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json(200, { messages: [{ id: 'wamid.1' }] }));
    const channel = new CloudApiWhatsAppChannel(config({ fetchImpl }));

    const result = await channel.send(otp);

    expect(result).toEqual({ status: 'accepted', providerMessageId: 'wamid.1', provider: 'cloud-api' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://graph.example.test/v21.0/1234567890/messages');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.template.name).toBe('erp_auth_code');
    expect(body.template.language).toEqual({ code: 'fr' });
    expect(body.to).toBe('22231234567');
    expect(body.messaging_product).toBe('whatsapp');
    expect(JSON.stringify(body)).not.toContain('auth.otp');
  });

  it('fills an authentication template with the code in the body and the copy button', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json(200, { messages: [{ id: 'wamid.2' }] }));
    await new CloudApiWhatsAppChannel(config({ fetchImpl })).send(otp);

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: '482913' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '482913' }] },
    ]);
    // The expiry wording is part of the approved authentication text, so it is
    // validated but not a parameter.
    expect(JSON.stringify(body.template.components)).not.toContain('"5"');
  });

  it('fills a utility template with its declared variables in order', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json(200, { messages: [{ id: 'wamid.3' }] }));
    await new CloudApiWhatsAppChannel(config({ fetchImpl })).send({
      ...otp,
      template: ACCOUNT_DELETION_TEMPLATE.key,
      language: 'ar',
      variables: { code: '111222', ttlMinutes: '10' },
    });

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.template.name).toBe('erp_delete_code');
    expect(body.template.language).toEqual({ code: 'ar' });
    expect(body.template.components).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: '111222' },
          { type: 'text', text: '10' },
        ],
      },
    ]);
  });

  it('fills a URL-button template: the body without the button variable, the button with it alone (0095)', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json(200, { messages: [{ id: 'wamid.5' }] }));
    const token = 'Zp3k9QeR7xVb2LmN8sTq4WyH6jUc1AfD0gKoEiPrS5v';
    const result = await new CloudApiWhatsAppChannel(config({ fetchImpl })).send({
      ...otp,
      template: TRIAL_SETUP_TEMPLATE.key,
      language: 'ar',
      variables: { business: 'Boutique Aicha', token },
    });

    expect(result).toEqual({ status: 'accepted', providerMessageId: 'wamid.5', provider: 'cloud-api' });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.template.name).toBe('erp_trial_setup');
    expect(body.template.language).toEqual({ code: 'ar' });
    expect(body.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Boutique Aicha' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: token }] },
    ]);
    // The token is the button's suffix and nothing else: never a body parameter, never in the address.
    expect(JSON.stringify(body.template.components[0])).not.toContain(token);
    expect(JSON.stringify(body).split(token)).toHaveLength(2);
    expect(calls[0].url).not.toContain(token);
  });

  it('refuses a URL-button template sent without its button variable, without a network call', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json(200, {}));
    const result = await new CloudApiWhatsAppChannel(config({ fetchImpl })).send({
      ...otp,
      template: TRIAL_SETUP_TEMPLATE.key,
      variables: { business: 'Boutique Aicha' },
    });
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ status: 'failed', reason: 'rejected' });
  });

  it('carries the token as a bearer header and nowhere else', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json(200, { messages: [{ id: 'wamid.4' }] }));
    await new CloudApiWhatsAppChannel(config({ fetchImpl })).send(otp);

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer EAAB-secret-token');
    expect(calls[0].url).not.toContain('EAAB-secret-token');
    expect(String(calls[0].init.body)).not.toContain('EAAB-secret-token');
  });

  it('uses the configured language code for each app language', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json(200, { messages: [{ id: 'x' }] }));
    const channel = new CloudApiWhatsAppChannel(
      config({ fetchImpl, languageCodes: { en: 'en_US', fr: 'fr', ar: 'ar' } }),
    );
    await channel.send({ ...otp, language: 'en' });
    expect(JSON.parse(String(calls[0].init.body)).template.language).toEqual({ code: 'en_US' });
  });
});

describe('what never reaches the provider', () => {
  it('refuses a template with no approved name, without a network call', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json(200, {}));
    const channel = new CloudApiWhatsAppChannel(config({ fetchImpl, templateNames: {} }));

    const result = await channel.send(otp);

    expect(calls).toHaveLength(0);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('rejected');
      expect(result.detail).toMatch(/no approved provider template/i);
    }
  });

  it('refuses a language the template does not declare', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json(200, {}));
    const channel = new CloudApiWhatsAppChannel(config({ fetchImpl }));

    const result = await channel.send({ ...otp, language: 'de' as never });

    expect(calls).toHaveLength(0);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toBe('rejected');
  });

  it('refuses a missing variable rather than sending a blank code', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json(200, {}));
    const channel = new CloudApiWhatsAppChannel(config({ fetchImpl }));

    const result = await channel.send({ ...otp, variables: { code: '', ttlMinutes: '5' } });

    expect(calls).toHaveLength(0);
    expect(result.status).toBe('failed');
  });
});

describe('what the provider answers', () => {
  it('classifies an invalid token as not_authorized', async () => {
    const { fetchImpl } = fakeFetch(() => json(401, { error: { message: 'Invalid OAuth', code: 190 } }));
    const result = await new CloudApiWhatsAppChannel(config({ fetchImpl })).send(otp);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('not_authorized');
      expect(result.detail).toBe('Provider answered HTTP 401 (code 190): the access token is invalid');
    }
  });

  it('classifies a refused message as rejected', async () => {
    // 131026: message undeliverable — the number is not on WhatsApp.
    const { fetchImpl } = fakeFetch(() => json(400, { error: { message: 'Undeliverable', code: 131026 } }));
    const result = await new CloudApiWhatsAppChannel(config({ fetchImpl })).send(otp);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toBe('rejected');
  });

  it('classifies throttling as temporary', async () => {
    const { fetchImpl } = fakeFetch(() => json(429, { error: { message: 'Too many', code: 130429 } }));
    const result = await new CloudApiWhatsAppChannel(config({ fetchImpl })).send(otp);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toBe('temporary');
  });

  it('classifies a provider outage as temporary', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
    const result = await new CloudApiWhatsAppChannel(config({ fetchImpl })).send(otp);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('temporary');
      expect(result.detail).toBe('Provider answered HTTP 502');
    }
  });

  it('classifies an unreachable provider as temporary', async () => {
    const { fetchImpl } = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const result = await new CloudApiWhatsAppChannel(config({ fetchImpl })).send(otp);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('temporary');
      expect(result.detail).toMatch(/could not be reached/);
    }
  });

  it('gives up after the configured timeout', async () => {
    const fetchImpl = ((_: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      })) as typeof fetch;
    const result = await new CloudApiWhatsAppChannel(config({ fetchImpl, timeoutMs: 20 })).send(otp);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('temporary');
      expect(result.detail).toMatch(/did not answer in time/);
    }
  });

  it('accepts a 200 even when the provider gives no message id', async () => {
    const { fetchImpl } = fakeFetch(() => json(200, {}));
    const result = await new CloudApiWhatsAppChannel(config({ fetchImpl })).send(otp);
    expect(result).toEqual({ status: 'accepted', providerMessageId: null, provider: 'cloud-api' });
  });
});

describe('what reaches the log', () => {
  it('never the code, never the token, never the full number', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { fetchImpl } = fakeFetch(() => json(400, { error: { message: 'code 482913 leaked?', code: 131026 } }));

    await new CloudApiWhatsAppChannel(config({ fetchImpl })).send(otp);

    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('482913');
    expect(logged).not.toContain('EAAB-secret-token');
    expect(logged).not.toContain('31234567');
    expect(logged).toContain('+222***67');
    warn.mockRestore();
  });

  it('never the setup token of a refused setup message', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const token = 'Zp3k9QeR7xVb2LmN8sTq4WyH6jUc1AfD0gKoEiPrS5v';
    const { fetchImpl } = fakeFetch(() => json(400, { error: { message: `bad parameter ${token}`, code: 132000 } }));

    const result = await new CloudApiWhatsAppChannel(config({ fetchImpl })).send({
      ...otp,
      template: TRIAL_SETUP_TEMPLATE.key,
      variables: { business: 'Boutique Aicha', token },
    });

    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain(token);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.detail).not.toContain(token);
    warn.mockRestore();
  });

  it('keeps the provider message out of the result detail', async () => {
    const { fetchImpl } = fakeFetch(() => json(400, { error: { message: 'Parameter 482913 invalid', code: 100 } }));
    const result = await new CloudApiWhatsAppChannel(config({ fetchImpl })).send(otp);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.detail).not.toContain('482913');
  });
});

describe('classification table', () => {
  it.each([
    [401, undefined, 'not_authorized'],
    [403, undefined, 'not_authorized'],
    [400, 190, 'not_authorized'],
    [400, 10, 'not_authorized'],
    [400, 200, 'not_authorized'],
    [400, 4, 'temporary'],
    [400, 80007, 'temporary'],
    [400, 131048, 'temporary'],
    [400, 131026, 'rejected'],
    [400, 132001, 'rejected'],
    [400, 100, 'rejected'],
    [429, undefined, 'temporary'],
    [500, undefined, 'temporary'],
    [503, undefined, 'temporary'],
    [400, undefined, 'rejected'],
  ])('HTTP %s with provider code %s → %s', (http, code, expected) => {
    expect(classifyGraphFailure(http, code)).toBe(expected);
  });
});

describe('the provider codes D181 names', () => {
  it.each([
    [401, 190, 463, 'not_authorized', /expired/],
    [401, 190, 467, 'not_authorized', /no longer valid/],
    [403, 10, undefined, 'not_authorized', /permission is missing/],
    [400, 131047, undefined, 'rejected', /24-hour customer-service window/],
    [400, 131026, undefined, 'rejected', /cannot receive this message/],
    [400, 131056, undefined, 'temporary', /too many messages to this number/],
    [429, 130429, undefined, 'temporary', /throttling/],
  ])('HTTP %i code %i/%p is %s, with the code kept as a number and no provider text', async (status, code, subcode, reason, detail) => {
    const { fetchImpl } = fakeFetch(() => json(status, { error: { message: 'echo +22236963839 482913', code, error_subcode: subcode } }));
    const result = await new CloudApiWhatsAppChannel(config({ fetchImpl })).send(otp);
    expect(result).toMatchObject({ status: 'failed', reason, providerCode: code });
    if (result.status === 'failed') {
      expect(result.detail).toMatch(detail);
      expect(result.detail).not.toMatch(/echo|482913|36963839/);
    }
  });
});
