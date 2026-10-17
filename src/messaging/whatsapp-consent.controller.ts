import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { consentCopy, type ConsentCopy } from './whatsapp-consent';
import type { MessageLanguage } from './whatsapp-channel';

/**
 * The WhatsApp consent copy, public because registration shows it before any account exists (D181 §5). A client
 * displays exactly this text and sends back its `version`; the server refuses any other version.
 */
@ApiTags('messaging')
@Public()
@Controller({ path: 'messaging/whatsapp', version: '1' })
export class WhatsAppConsentController {
  @Get('consent')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'The current WhatsApp consent copy (EN/FR/AR), its version and purposes' })
  copy(@Query('language') language?: string): ConsentCopy {
    const lang: MessageLanguage = language === 'fr' || language === 'ar' ? language : 'en';
    return consentCopy(lang);
  }
}
