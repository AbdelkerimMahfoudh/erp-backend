import { Logger } from '@nestjs/common';
import {
  DeliveryFailureReason,
  DeliveryResult,
  WhatsAppChannel,
  WhatsAppMessage,
} from './whatsapp-channel';
import {
  assertLanguageSupported,
  getTemplate,
  MessageLanguage,
  validateTemplateVariables,
} from './templates';
import { maskDestination } from './channels';

/**
 * The WhatsApp Business Cloud API adapter (Meta Graph API), docs/64.
 *
 * The only place in the backend that talks to the provider. It sends approved
 * templates by name with validated variables — nothing else — and classifies
 * every failure into the small provider-neutral set the boundary defines, so a
 * vendor payload never reaches a caller, a log or an audit row.
 *
 * What never leaves this class: the access token (a request header and
 * nothing else), a code or any other template variable (never logged), and a
 * full destination number (logs carry the masked form).
 */

export interface CloudApiConfig {
  /** `https://graph.facebook.com` in every real deployment; a local mock in tests. */
  baseUrl: string;
  /** `v21.0` and the like. */
  apiVersion: string;
  /** The sending number's id at the provider. An identifier, not a secret. */
  phoneNumberId: string;
  /** A system-user token. Server-side configuration only — never a bundle, a log or a response. */
  accessToken: string;
  timeoutMs: number;
  /** Template key → the provider's approved template name. Absent = not sendable. */
  templateNames: Readonly<Record<string, string>>;
  /** App language → the provider's language code for the approved templates. */
  languageCodes: Readonly<Record<MessageLanguage, string>>;
  /** Injected in tests; `globalThis.fetch` otherwise. */
  fetchImpl?: typeof fetch;
}

interface GraphErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
  messages?: { id?: string }[];
}

/**
 * The provider's failure, in the boundary's terms.
 *
 * Only the class matters to a caller — retry, do not retry, or fix the
 * configuration — so only the class is decided here. The provider's numeric
 * code is kept in `detail` for support, and nothing else from the payload is.
 */
export function classifyGraphFailure(httpStatus: number, code?: number): DeliveryFailureReason {
  if (httpStatus === 401 || httpStatus === 403) return 'not_authorized';
  if (code !== undefined) {
    // An expired or invalid token, a missing permission.
    if (code === 190 || code === 10 || (code >= 200 && code <= 299)) return 'not_authorized';
    // Throttling and the provider's own temporary trouble.
    if ([4, 80007, 130429, 131048, 131056, 133004, 131016, 131000].includes(code)) return 'temporary';
    // Everything else the provider names is a refusal of THIS message: a number
    // that is not on WhatsApp, an unapproved or mismatched template, a parameter.
    return 'rejected';
  }
  if (httpStatus === 429 || httpStatus >= 500) return 'temporary';
  return 'rejected';
}

export class CloudApiWhatsAppChannel implements WhatsAppChannel {
  readonly name = 'cloud-api';
  readonly isEnabled = true;
  private readonly logger = new Logger(CloudApiWhatsAppChannel.name);

  constructor(private readonly cfg: CloudApiConfig) {}

  async send(message: WhatsAppMessage): Promise<DeliveryResult> {
    const template = getTemplate(message.template);
    const providerName = this.cfg.templateNames[message.template];
    if (!providerName) {
      // A configuration gap, reported as such: nothing is guessed.
      return this.failed('rejected', `No approved provider template is configured for ${message.template}`);
    }
    try {
      assertLanguageSupported(template, message.language);
      validateTemplateVariables(template, message.variables);
    } catch {
      return this.failed('rejected', `Template ${message.template} cannot be sent as requested`);
    }

    const components =
      template.providerKind === 'authentication'
        ? [
            { type: 'body', parameters: [{ type: 'text', text: message.variables.code }] },
            {
              type: 'button',
              sub_type: 'url',
              index: '0',
              parameters: [{ type: 'text', text: message.variables.code }],
            },
          ]
        : template.variables.length > 0
          ? [
              {
                type: 'body',
                parameters: template.variables.map((name) => ({ type: 'text', text: message.variables[name] })),
              },
            ]
          : [];

    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      // The provider takes the number without the plus sign.
      to: message.to.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: providerName,
        language: { code: this.cfg.languageCodes[message.language] ?? message.language },
        components,
      },
    };

    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}/${this.cfg.apiVersion}/${encodeURIComponent(this.cfg.phoneNumberId)}/messages`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    const doFetch = this.cfg.fetchImpl ?? globalThis.fetch;

    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.accessToken}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const timedOut = (e as { name?: string } | null)?.name === 'AbortError';
      this.logger.warn(
        `WhatsApp send ${timedOut ? 'timed out' : 'could not reach the provider'} for ${maskDestination(message.to)} (${message.template})`,
      );
      return this.failed(
        'temporary',
        timedOut ? 'The provider did not answer in time' : 'The provider could not be reached',
      );
    }
    clearTimeout(timer);

    let payload: GraphErrorBody = {};
    try {
      payload = (await response.json()) as GraphErrorBody;
    } catch {
      payload = {};
    }

    if (response.ok) {
      return {
        status: 'accepted',
        providerMessageId: payload.messages?.[0]?.id ?? null,
        provider: this.name,
      };
    }

    const code = payload.error?.code;
    const reason = classifyGraphFailure(response.status, code);
    this.logger.warn(
      `WhatsApp send refused for ${maskDestination(message.to)} (${message.template}): HTTP ${response.status}, provider code ${code ?? 'none'}`,
    );
    return this.failed(
      reason,
      `Provider answered HTTP ${response.status}${code !== undefined ? ` (code ${code})` : ''}`,
    );
  }

  private failed(reason: DeliveryFailureReason, detail: string): DeliveryResult {
    return { status: 'failed', reason, detail, provider: this.name };
  }
}
