import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DeviceCatalogueService } from './device-catalogue.service';

/**
 * The phone brand and model catalogue.
 *
 * Authenticated, and that is all. No permission gate: this is reference data
 * every signed-in user needs in order to *describe* a phone, and gating it
 * behind `catalog.manage` would stop a Store Employee receiving stock — which
 * is exactly the person most likely to be holding an unfamiliar handset.
 *
 * There is no write surface here on purpose. The catalogue is corrected through
 * guarded reference-data tooling, not through the tenant API, so one shop's
 * opinion can never become everybody's catalogue. A company's own belief about
 * a code has a home already: `ProductRecognition`, via `/tac-mappings`.
 */
@ApiTags('catalog')
@ApiBearerAuth()
@Controller({ path: 'device-catalogue', version: '1' })
export class DeviceCatalogueController {
  constructor(private readonly catalogue: DeviceCatalogueService) {}

  @Get('brands')
  @ApiOperation({
    summary: 'Phone brands, in display order',
    description:
      'Includes `Other brand`, which is an ordinary row rather than a client-side special case. `manufacturerKey` records that Redmi and POCO are Xiaomi’s without hiding them under it.',
  })
  brands(@Query('q') q?: string) {
    return this.catalogue.brands(q);
  }

  @Get('brands/:brandKey/models')
  @ApiOperation({
    summary: 'The models of one brand, newest first',
    description:
      'Commercial names only. Storage, colour and condition are product and unit attributes and are never folded into a model name. An unknown brand returns an empty list rather than an error, because typing the model by hand is a supported outcome.',
  })
  models(@Param('brandKey') brandKey: string, @Query('q') q?: string) {
    return this.catalogue.models(brandKey, q);
  }

  @Get('version')
  @ApiOperation({
    summary: 'Whether a cached catalogue is stale',
    description:
      'Row counts and the newest change. `complete` is always false: this is a curated starter catalogue, not an exhaustive device database, and a client that believed otherwise would stop offering manual entry.',
  })
  version() {
    return this.catalogue.version();
  }
}
