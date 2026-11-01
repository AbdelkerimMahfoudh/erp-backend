import { Controller, Get, GoneException, Headers, NotFoundException, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

/** What an old build shows if someone tries to set a goal, in the language it asked for. */
const UNAVAILABLE: Record<'en' | 'fr' | 'ar', string> = {
  en: 'This feature is currently unavailable.',
  fr: 'Cette fonctionnalité est actuellement indisponible.',
  ar: 'هذه الميزة غير متاحة حاليًا.',
};

function unavailable(acceptLanguage?: string): GoneException {
  const language = (['ar', 'fr'] as const).find((l) => acceptLanguage?.toLowerCase().startsWith(l)) ?? 'en';
  return new GoneException({ code: 'feature_unavailable', message: UNAVAILABLE[language] });
}

/**
 * DEPRECATED AND DORMANT (D227): Goals are out of the product. These routes exist only for builds up to 1.0.0 (3), whose
 * Goals screen calls them; remove them once those builds are gone.
 *
 * Nothing here reads or writes the `goals` table, which is kept untouched for a possible redesign. Nothing is evaluated,
 * no notification is sent, and no figure anywhere depends on a goal.
 */
@ApiTags('goals')
@ApiBearerAuth()
@Controller({ version: '1' })
export class GoalsController {
  @Get('goals')
  @ApiOperation({ deprecated: true, summary: 'Dormant: always an empty list' })
  list() {
    return [];
  }

  @Get('goals/:id')
  @ApiOperation({ deprecated: true, summary: 'Dormant: no goal is ever found' })
  get() {
    throw new NotFoundException({ code: 'feature_unavailable', message: UNAVAILABLE.en });
  }

  @Post('goals')
  @ApiOperation({ deprecated: true, summary: 'Dormant: refused with feature_unavailable' })
  create(@Headers('accept-language') language?: string) {
    throw unavailable(language);
  }

  @Post('goals/:id/archive')
  @ApiOperation({ deprecated: true, summary: 'Dormant: refused with feature_unavailable' })
  archive(@Headers('accept-language') language?: string) {
    throw unavailable(language);
  }
}
