import { checkLiveCredentials, WhatsAppLiveCheck, type LiveCheckConfig } from './whatsapp-live-check';
import { createWhatsAppChannel, sendControlsFrom } from './messaging.module';

/**
 * Live mode's start-up credential check (D181 §4): production refuses to boot in live mode unless the token is
 * permanent, valid, issued for this app, permitted to message, and able to see the sending number. Every provider
 * answer here is a fake; no request leaves the test.
 */

const TOKEN = 'EAAG-permanent-system-user-token';
const SECRET = 'app-secret-for-tests';

function graph(debug: { status?: number; data?: Record<string, unknown> } | Error, phone: { status?: number; id?: string } = {}) {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const fetchImpl = jest.fn(async (url: string, init: { headers: Record<string, string> }) => {
    urls.push(url);
    headers.push(init.headers);
    if (url.includes('/debug_token')) {
      if (debug instanceof Error) throw debug;
      return { status: debug.status ?? 200, json: async () => ({ data: debug.data }) };
    }
    return { status: phone.status ?? 200, json: async () => ({ id: phone.id ?? '1297799316760335' }) };
  });
  const cfg: LiveCheckConfig = {
    baseUrl: 'https://graph.facebook.com',
    apiVersion: 'v26.0',
    appId: '1103715978699774',
    appSecret: SECRET,
    accessToken: TOKEN,
    phoneNumberId: '1297799316760335',
    timeoutMs: 1000,
    fetchImpl: fetchImpl as never,
  };
  return { cfg, urls, headers };
}

const permanent = { is_valid: true, app_id: '1103715978699774', expires_at: 0, scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'], type: 'SYSTEM_USER' };

describe('the credential check', () => {
  it('passes a permanent, valid token of this app that can see the number', async () => {
    const { cfg, urls, headers } = graph({ data: permanent });
    expect(await checkLiveCredentials(cfg)).toEqual([]);
    expect(urls[0]).toMatch(/^https:\/\/graph\.facebook\.com\/v26\.0\/debug_token\?input_token=/);
    // The app credential travels in the header, never in a URL.
    expect(urls.join(' ')).not.toContain(SECRET);
    expect(headers[0].authorization).toBe(`Bearer 1103715978699774|${SECRET}`);
  });

  it.each([
    [{ ...permanent, expires_at: 1_790_000_000 }, /expires: live mode needs a permanent/],
    [{ ...permanent, is_valid: false }, /not valid/],
    [{ ...permanent, app_id: '999' }, /not issued for WHATSAPP_APP_ID/],
    [{ ...permanent, scopes: ['whatsapp_business_management'] }, /lacks whatsapp_business_messaging/],
  ])('refuses %p', async (data, problem) => {
    const { cfg } = graph({ data });
    expect((await checkLiveCredentials(cfg)).join('; ')).toMatch(problem);
  });

  it('refuses an expired or invalid token the provider will not describe, and a number it cannot see', async () => {
    expect((await checkLiveCredentials(graph({ status: 400 }).cfg)).join()).toMatch(/did not describe the access token \(HTTP 400\)/);
    expect((await checkLiveCredentials(graph({ data: permanent }, { status: 403 }).cfg)).join()).toMatch(/cannot see WHATSAPP_PHONE_NUMBER_ID/);
    expect((await checkLiveCredentials(graph({ data: permanent }, { id: 'other' }).cfg)).join()).toMatch(/cannot see/);
  });

  it('fails closed when the provider cannot be reached, and never repeats a credential', async () => {
    const problems = await checkLiveCredentials(graph(new Error(`connect ECONNREFUSED with ${TOKEN}`)).cfg);
    expect(problems).toEqual(['the provider could not be reached']);
    expect(JSON.stringify(problems)).not.toContain(TOKEN);
  });

  it('asks for everything it needs before calling anything', async () => {
    const { cfg, urls } = graph({ data: permanent });
    expect(await checkLiveCredentials({ ...cfg, appId: '' })).toEqual([expect.stringMatching(/all required in live mode/)]);
    expect(urls).toHaveLength(0);
  });
});

describe('at start-up', () => {
  const config = (over: Record<string, unknown>) => ({
    whatsappChannel: 'cloud',
    whatsappMode: 'live',
    whatsappApiBaseUrl: 'https://graph.facebook.com',
    whatsappApiVersion: 'v26.0',
    whatsappAppId: '',
    whatsappAppSecret: SECRET,
    whatsappAccessToken: TOKEN,
    whatsappPhoneNumberId: '1297799316760335',
    whatsappSendTimeoutMs: 1000,
    nodeEnv: 'production',
    ...over,
  });

  it('refuses the production boot in live mode on any problem', async () => {
    await expect(new WhatsAppLiveCheck(config({}) as never).onModuleInit()).rejects.toThrow(/WhatsApp live mode refused/);
  });

  it('does not run in test mode, or without the Cloud API', async () => {
    await expect(new WhatsAppLiveCheck(config({ whatsappMode: 'test' }) as never).onModuleInit()).resolves.toBeUndefined();
    await expect(new WhatsAppLiveCheck(config({ whatsappChannel: 'disabled' }) as never).onModuleInit()).resolves.toBeUndefined();
  });

  it('only warns outside production', async () => {
    await expect(new WhatsAppLiveCheck(config({ nodeEnv: 'development' }) as never).onModuleInit()).resolves.toBeUndefined();
  });
});

describe('disabled and unconfigured messaging', () => {
  it('the default channel sends nothing, honestly', async () => {
    const channel = createWhatsAppChannel({ channel: '', isProduction: true });
    expect(channel.isEnabled).toBe(false);
    expect(await channel.send({ to: '+22236963839', template: 'auth.otp', language: 'en', variables: { code: '1', ttlMinutes: '5' }, idempotencyKey: 'k' })).toMatchObject({
      status: 'failed',
      reason: 'channel_unavailable',
    });
  });

  it('"cloud" and its former name build the same adapter, and neither without credentials', () => {
    const cloudApi = { baseUrl: 'https://graph.facebook.com', apiVersion: 'v26.0', phoneNumberId: '1', accessToken: 't', timeoutMs: 1000, templateNames: {}, languageCodes: { en: 'en', fr: 'fr', ar: 'ar' } };
    expect(createWhatsAppChannel({ channel: 'cloud', isProduction: true, cloudApi }).name).toBe('cloud-api');
    expect(createWhatsAppChannel({ channel: 'cloud-api', isProduction: true, cloudApi }).name).toBe('cloud-api');
    expect(() => createWhatsAppChannel({ channel: 'cloud', isProduction: true, cloudApi: { ...cloudApi, accessToken: '' } })).toThrow(/WHATSAPP_ACCESS_TOKEN/);
  });

  it('an invalid test allowlist refuses the boot instead of being guessed at', () => {
    const config = { whatsappMode: 'test', whatsappTestRecipients: '36963839', whatsappLiveSends: false, whatsappPhoneNumberId: '1', whatsappMaxSendsPerSecond: 20, whatsappRecipientMinIntervalMs: 1000 };
    expect(() => sendControlsFrom(config as never)).toThrow(/E\.164/);
    expect(sendControlsFrom({ ...config, whatsappTestRecipients: '+22236963839' } as never).testRecipients.has('+22236963839')).toBe(true);
  });
});
