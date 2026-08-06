import { Global, Module } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service';
import { WHATSAPP_CHANNEL, WhatsAppChannel } from './whatsapp-channel';
import {
  DevelopmentLogWhatsAppChannel,
  DisabledWhatsAppChannel,
} from './channels';

/**
 * Chooses the messaging adapter (F1 Stage 4A).
 *
 * The selection is the whole security control here. `disabled` is the default
 * and the only value production accepts; anything else in production is a fatal
 * startup error rather than a warning, because a deployment that silently falls
 * back to a log channel is a deployment printing one-time codes to a log file.
 *
 * The test channel is never registered here at all — tests inject it directly,
 * so there is no code path that could put it in a running server.
 */

export function createWhatsAppChannel(config: {
  channel: string;
  isProduction: boolean;
}): WhatsAppChannel {
  const choice = (config.channel || 'disabled').trim().toLowerCase();

  if (choice === 'disabled') return new DisabledWhatsAppChannel();

  if (choice === 'development-log') {
    if (config.isProduction) {
      throw new Error(
        'WHATSAPP_CHANNEL=development-log is not permitted in production. ' +
          'It writes one-time codes to a local development sink. Use "disabled" ' +
          'until a real provider adapter is configured.',
      );
    }
    return new DevelopmentLogWhatsAppChannel();
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
    `Unknown WHATSAPP_CHANNEL "${config.channel}". No provider adapter exists yet ` +
      '(Stage 4B). Valid values: disabled, development-log (non-production only).',
  );
}

@Global()
@Module({
  providers: [
    {
      provide: WHATSAPP_CHANNEL,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        createWhatsAppChannel({
          channel: config.whatsappChannel,
          isProduction: config.nodeEnv === 'production',
        }),
    },
  ],
  exports: [WHATSAPP_CHANNEL],
})
export class MessagingModule {}
