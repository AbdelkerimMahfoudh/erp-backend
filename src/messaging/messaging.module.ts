import { Global, Module } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service';
import { WHATSAPP_CHANNEL, WhatsAppChannel } from './whatsapp-channel';
import { DevelopmentLogWhatsAppChannel, DisabledWhatsAppChannel } from './channels';
import { CloudApiConfig, CloudApiWhatsAppChannel } from './cloud-api-channel';
import { ALL_TEMPLATES } from './templates';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';

/**
 * Chooses the messaging adapter (F1 Stage 4A; the Cloud API since 2026-09-30).
 *
 * The selection is the whole security control here. `disabled` is the default;
 * `development-log` is refused in production as a fatal startup error rather
 * than a warning, because a deployment that silently falls back to a log
 * channel is a deployment printing one-time codes to a log file; `cloud-api`
 * refuses to build without its credentials, because a channel that claims to
 * be real and sends nothing is the failure this whole seam exists to prevent.
 *
 * The test channel is never registered here at all — tests inject it directly,
 * so there is no code path that could put it in a running server.
 */

export interface ChannelSelection {
  channel: string;
  isProduction: boolean;
  /** Present only when the operator configured the Cloud API. */
  cloudApi?: CloudApiConfig | null;
}

export function createWhatsAppChannel(config: ChannelSelection): WhatsAppChannel {
  const choice = (config.channel || 'disabled').trim().toLowerCase();

  if (choice === 'disabled') return new DisabledWhatsAppChannel();

  if (choice === 'development-log') {
    if (config.isProduction) {
      throw new Error(
        'WHATSAPP_CHANNEL=development-log is not permitted in production. ' +
          'It writes one-time codes to a local development sink. Use "cloud-api" with ' +
          'real credentials, or "disabled".',
      );
    }
    return new DevelopmentLogWhatsAppChannel();
  }

  if (choice === 'cloud-api') {
    const c = config.cloudApi;
    if (!c || !c.phoneNumberId.trim() || !c.accessToken.trim()) {
      throw new Error(
        'WHATSAPP_CHANNEL=cloud-api needs WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN. ' +
          'Nothing is faked: set them, or set WHATSAPP_CHANNEL=disabled.',
      );
    }
    if (config.isProduction && !/^https:\/\//i.test(c.baseUrl)) {
      throw new Error('WHATSAPP_API_BASE_URL must be an https:// address in production.');
    }
    return new CloudApiWhatsAppChannel(c);
  }

  if (choice === 'test') {
    // The test channel keeps plaintext codes in memory for assertions. It is
    // injected directly by tests and must never be selectable by configuration.
    throw new Error(
      'WHATSAPP_CHANNEL=test is not selectable by configuration. Inject ' +
        'TestWhatsAppChannel in a test instead.',
    );
  }

  throw new Error(
    `Unknown WHATSAPP_CHANNEL "${config.channel}". ` +
      'Valid values: disabled, development-log (non-production only), cloud-api.',
  );
}

/** The Cloud API configuration from the environment, or null when the channel is not `cloud-api`. */
export function cloudApiConfigFrom(config: AppConfigService): CloudApiConfig | null {
  if (config.whatsappChannel.trim().toLowerCase() !== 'cloud-api') return null;
  const templateNames: Record<string, string> = {};
  for (const template of ALL_TEMPLATES) {
    const name = config.whatsappTemplateName(template.configKey);
    if (name) templateNames[template.key] = name;
  }
  return {
    baseUrl: config.whatsappApiBaseUrl,
    apiVersion: config.whatsappApiVersion,
    phoneNumberId: config.whatsappPhoneNumberId,
    accessToken: config.whatsappAccessToken,
    timeoutMs: config.whatsappSendTimeoutMs,
    templateNames,
    languageCodes: config.whatsappLanguageCodes,
  };
}

@Global()
@Module({
  controllers: [WhatsAppWebhookController],
  providers: [
    {
      provide: WHATSAPP_CHANNEL,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        createWhatsAppChannel({
          channel: config.whatsappChannel,
          isProduction: config.nodeEnv === 'production',
          cloudApi: cloudApiConfigFrom(config),
        }),
    },
  ],
  exports: [WHATSAPP_CHANNEL],
})
export class MessagingModule {}
