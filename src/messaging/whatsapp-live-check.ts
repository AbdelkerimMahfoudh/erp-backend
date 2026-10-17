import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service';

/**
 * Live mode's credential check (D181 §4): production refuses to boot in `live` mode unless the access token is a
 * permanent one, valid, issued for this app, with the messaging permission, and able to see the configured sending
 * number. The static half (channel, templates, webhook, the live-send switch) is `production-guard.ts`; this is the
 * half only the provider can answer, asked once at start-up.
 *
 * Fails closed: an answer that cannot be obtained (no network, the provider down) refuses the boot too, because a
 * live deployment that cannot tell whether its token works would otherwise claim deliveries it cannot make. To boot
 * without the provider, use `WHATSAPP_MODE=test` or `WHATSAPP_CHANNEL=disabled`.
 *
 * The token travels in the provider's documented `debug_token` query, over HTTPS, to the provider only; the app
 * token goes in the Authorization header. Neither is ever logged, and no answer from the provider is echoed.
 */

export interface LiveCheckConfig {
  baseUrl: string;
  apiVersion: string;
  appId: string;
  appSecret: string;
  accessToken: string;
  phoneNumberId: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

interface DebugTokenBody {
  data?: { is_valid?: boolean; app_id?: string; expires_at?: number; scopes?: string[]; type?: string };
}

async function getJson(url: string, bearer: string, cfg: LiveCheckConfig): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await (cfg.fetchImpl ?? globalThis.fetch)(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${bearer}` },
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** The problems, in words safe for a log: empty when live sending may start. */
export async function checkLiveCredentials(cfg: LiveCheckConfig): Promise<string[]> {
  if (!cfg.appId || !cfg.appSecret || !cfg.accessToken || !cfg.phoneNumberId) {
    return ['WHATSAPP_APP_ID, WHATSAPP_APP_SECRET, WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID are all required in live mode'];
  }
  const base = `${cfg.baseUrl.replace(/\/+$/, '')}/${cfg.apiVersion}`;
  const problems: string[] = [];
  try {
    const debug = await getJson(
      `${base}/debug_token?input_token=${encodeURIComponent(cfg.accessToken)}`,
      `${cfg.appId}|${cfg.appSecret}`,
      cfg,
    );
    const data = (debug.body as DebugTokenBody | null)?.data;
    if (debug.status !== 200 || !data) {
      problems.push(`the provider did not describe the access token (HTTP ${debug.status})`);
    } else {
      if (data.is_valid !== true) problems.push('the access token is not valid');
      if (data.app_id !== cfg.appId) problems.push('the access token was not issued for WHATSAPP_APP_ID');
      if (data.expires_at !== 0) problems.push('the access token expires: live mode needs a permanent system-user token');
      if (!data.scopes?.includes('whatsapp_business_messaging')) problems.push('the access token lacks whatsapp_business_messaging');
    }
    const number = await getJson(`${base}/${encodeURIComponent(cfg.phoneNumberId)}?fields=id`, cfg.accessToken, cfg);
    const id = (number.body as { id?: unknown } | null)?.id;
    if (number.status !== 200 || id !== cfg.phoneNumberId) {
      problems.push(`the access token cannot see WHATSAPP_PHONE_NUMBER_ID (HTTP ${number.status})`);
    }
  } catch (e) {
    const timedOut = (e as { name?: string } | null)?.name === 'AbortError';
    problems.push(timedOut ? 'the provider did not answer in time' : 'the provider could not be reached');
  }
  return problems;
}

/** Runs the check at start-up in production live mode, and refuses the boot on any problem. */
@Injectable()
export class WhatsAppLiveCheck implements OnModuleInit {
  private readonly logger = new Logger(WhatsAppLiveCheck.name);

  constructor(private readonly config: AppConfigService) {}

  get applies(): boolean {
    const channel = this.config.whatsappChannel.trim().toLowerCase();
    return (channel === 'cloud' || channel === 'cloud-api') && this.config.whatsappMode === 'live';
  }

  async onModuleInit(): Promise<void> {
    if (!this.applies) return;
    const problems = await checkLiveCredentials({
      baseUrl: this.config.whatsappApiBaseUrl,
      apiVersion: this.config.whatsappApiVersion,
      appId: this.config.whatsappAppId,
      appSecret: this.config.whatsappAppSecret,
      accessToken: this.config.whatsappAccessToken,
      phoneNumberId: this.config.whatsappPhoneNumberId,
      timeoutMs: this.config.whatsappSendTimeoutMs,
    });
    if (problems.length === 0) {
      this.logger.log('WhatsApp live mode: the access token is permanent and valid for the configured number');
      return;
    }
    const message = `WhatsApp live mode refused: ${problems.join('; ')}.`;
    if (this.config.nodeEnv === 'production') throw new Error(message);
    this.logger.warn(`${message} (not production: starting anyway; live sends stay governed by WHATSAPP_LIVE_SENDS)`);
  }
}
