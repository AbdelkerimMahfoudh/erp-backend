import { Global, Module } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { WHATSAPP_CHANNEL, WhatsAppChannel } from './whatsapp-channel';
import { DevelopmentLogWhatsAppChannel, DisabledWhatsAppChannel } from './channels';
import { CloudApiConfig, CloudApiWhatsAppChannel } from './cloud-api-channel';
import { ALL_TEMPLATES } from './templates';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';
import { WhatsAppWebhookWorker } from './whatsapp-webhook.worker';
import { WhatsAppConsentController } from './whatsapp-consent.controller';
import { ProvenWhatsAppChannel, WhatsAppReadiness } from './delivery-readiness';
import { createEmailChannel, EMAIL_CHANNEL, EmailChannel, senderFor } from './email-channel';
import { LoggedEmailChannel } from './email-log';
import { RecipientHasher } from './recipient-hash';
import { WhatsAppRecords } from './whatsapp-records';
import { GovernedWhatsAppChannel, parseTestRecipients, type WhatsAppSendControls } from './whatsapp-policy';
import { WhatsAppLiveCheck } from './whatsapp-live-check';

/** The provider adapter itself, before any policy. Injected by nothing but this module. */
export const WHATSAPP_RAW_CHANNEL = Symbol('WHATSAPP_RAW_CHANNEL');

/**
 * The configured channel under the send policy (test/live, allowlist, opt-out, consent, pacing, records — D181 §4),
 * before the production proof gate. Injected ONLY by the operator's `whatsapp:prove` command, which is how the proof
 * gets made — in test mode, to allowlisted numbers; every other caller gets {@link WHATSAPP_CHANNEL}.
 */
export const WHATSAPP_GOVERNED_CHANNEL = Symbol('WHATSAPP_GOVERNED_CHANNEL');

/**
 * Chooses the messaging adapter (F1 Stage 4A; the Cloud API since 2026-09-30).
 *
 * The selection is the whole security control here. `disabled` is the default;
 * `development-log` is refused in production as a fatal startup error rather
 * than a warning, because a deployment that silently falls back to a log
 * channel is a deployment printing one-time codes to a log file; `cloud`
 * (formerly `cloud-api`) refuses to build without its credentials, because a channel that claims to
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

  if (choice === 'cloud' || choice === 'cloud-api') {
    const c = config.cloudApi;
    if (!c || !c.phoneNumberId.trim() || !c.accessToken.trim()) {
      throw new Error(
        'WHATSAPP_CHANNEL=cloud needs WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN. ' +
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
      'Valid values: disabled, development-log (non-production only), cloud.',
  );
}

/** Whether the configured channel is the Cloud API (`cloud`, or its former name `cloud-api`). */
export function isCloudChannel(channel: string): boolean {
  const choice = channel.trim().toLowerCase();
  return choice === 'cloud' || choice === 'cloud-api';
}

/** The send controls from the environment (D181 §4). An invalid allowlist refuses the boot. */
export function sendControlsFrom(config: AppConfigService): WhatsAppSendControls {
  return {
    mode: config.whatsappMode,
    testRecipients: new Set(parseTestRecipients(config.whatsappTestRecipients)),
    liveSends: config.whatsappLiveSends,
    phoneNumberId: config.whatsappPhoneNumberId,
    maxPerSecond: config.whatsappMaxSendsPerSecond,
    recipientMinIntervalMs: config.whatsappRecipientMinIntervalMs,
  };
}

/** The Cloud API configuration from the environment, or null when the channel is not the Cloud API. */
export function cloudApiConfigFrom(config: AppConfigService): CloudApiConfig | null {
  if (!isCloudChannel(config.whatsappChannel)) return null;
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
  controllers: [WhatsAppWebhookController, WhatsAppConsentController],
  providers: [
    WhatsAppReadiness,
    RecipientHasher,
    WhatsAppRecords,
    WhatsAppWebhookWorker,
    // Production live mode: the token is checked with the provider at start-up, and the boot refused on any doubt.
    WhatsAppLiveCheck,
    {
      provide: WHATSAPP_RAW_CHANNEL,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        createWhatsAppChannel({
          channel: config.whatsappChannel,
          isProduction: config.nodeEnv === 'production',
          cloudApi: cloudApiConfigFrom(config),
        }),
    },
    {
      /*
       * The Cloud API always goes through the send policy (D181 §4): test mode reaches the allowlist only, live mode
       * nothing until live sends are enabled, and every send honours the person's opt-out and is recorded. The
       * development log and the disabled channel send nothing, so there is nothing to govern.
       */
      provide: WHATSAPP_GOVERNED_CHANNEL,
      inject: [AppConfigService, WHATSAPP_RAW_CHANNEL, WhatsAppRecords],
      useFactory: (config: AppConfigService, raw: WhatsAppChannel, records: WhatsAppRecords): WhatsAppChannel =>
        raw instanceof CloudApiWhatsAppChannel ? new GovernedWhatsAppChannel(raw, sendControlsFrom(config), records) : raw,
    },
    {
      /*
       * In production a real channel stays closed until its delivery is proven on this deployment and for this
       * sending number (docs/64, 0098): no code, no deletion code, no invitation is claimed before then. Outside
       * production the governed channel is used as it is.
       */
      provide: WHATSAPP_CHANNEL,
      inject: [AppConfigService, WHATSAPP_RAW_CHANNEL, WHATSAPP_GOVERNED_CHANNEL, WhatsAppReadiness],
      useFactory: (config: AppConfigService, raw: WhatsAppChannel, governed: WhatsAppChannel, readiness: WhatsAppReadiness): WhatsAppChannel =>
        config.nodeEnv === 'production' && raw.isEnabled ? new ProvenWhatsAppChannel(governed, readiness) : governed,
    },
    {
      /*
       * A real provider (SMTP or the dormant Resend) is always recorded and limited (`email-log.ts`); the disabled
       * and development channels send nothing.
       */
      provide: EMAIL_CHANNEL,
      inject: [AppConfigService, PrismaService, RecipientHasher],
      useFactory: (config: AppConfigService, prisma: PrismaService, hasher: RecipientHasher): EmailChannel => {
        const choice = config.emailChannel.trim().toLowerCase();
        const senders = config.emailSenders;
        const raw = createEmailChannel({
          channel: config.emailChannel,
          isProduction: config.nodeEnv === 'production',
          resend:
            choice === 'resend'
              ? {
                  baseUrl: config.resendApiBaseUrl,
                  apiKey: config.resendApiKey,
                  from: config.emailFrom,
                  replyTo: config.emailReplyTo,
                  timeoutMs: config.emailSendTimeoutMs,
                }
              : null,
          smtp:
            choice === 'smtp'
              ? {
                  host: config.smtpHost,
                  port: config.smtpPort,
                  username: config.smtpUsername,
                  password: config.smtpPassword,
                  senders,
                  replyTo: config.emailReplyTo,
                  timeouts: config.smtpTimeouts,
                }
              : null,
        });
        if (choice !== 'smtp' && choice !== 'resend') return raw;
        return new LoggedEmailChannel(
          raw,
          prisma,
          hasher,
          {
            dailyLimit: config.emailDailySafetyLimit,
            dailyReserve: config.emailDailyReserve,
            recipientDailyLimit: config.emailRecipientDailyLimit,
          },
          (template) => (choice === 'smtp' ? senderFor(template, senders) : config.emailFrom),
        );
      },
    },
  ],
  exports: [WHATSAPP_CHANNEL, WHATSAPP_GOVERNED_CHANNEL, WhatsAppReadiness, WhatsAppRecords, RecipientHasher, EMAIL_CHANNEL],
})
export class MessagingModule {}
