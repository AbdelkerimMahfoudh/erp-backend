import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { TacMappingService } from './tac-mapping.service';
import { SubmitTacMappingDto } from './dto/tac-mapping.dto';

/**
 * A company's own TAC→Product mappings (Milestone C).
 *
 * **No new permission was added, because two existing ones already say exactly
 * the right thing:**
 *
 *   `unit.add`        gates receiving, which is where an Employee meets an
 *                     unrecognised phone and proposes what it is. All three
 *                     store roles hold it.
 *   `catalog.manage`  is "manage the product catalog", and deciding which
 *                     product a code means is catalog management. Owner and
 *                     Store Manager hold it; a Store Employee does not.
 *
 * So both routes take `unit.add`, and the SERVICE decides whether a write is a
 * proposal or a confirmation by checking `catalog.manage`. Putting that check in
 * the service rather than the route is deliberate: one endpoint that behaves
 * according to who you are cannot be called with the wrong intent, and the
 * client never has to know which it is allowed to do.
 *
 * Neither route can touch the global `tac_catalog`. That table is
 * platform-controlled and holds generic manufacturer and model only.
 */
@ApiTags('scanner')
@ApiBearerAuth()
@Controller({ path: 'tac-mappings', version: '1' })
export class TacMappingController {
  constructor(private readonly mappings: TacMappingService) {}

  @Get(':tac')
  @RequirePermissions('unit.add')
  @ApiOperation({
    summary: 'What this company knows about a TAC',
    description:
      'Runs the deterministic ladder: a confirmed company mapping wins; a pending proposal is shown but never auto-selected; otherwise the global catalogue gives manufacturer and model only; otherwise unknown. Storage, colour, condition, cost and price are never inferred.',
  })
  resolve(@Param('tac') tac: string) {
    return this.mappings.resolve(tac);
  }

  @Post()
  @RequirePermissions('unit.add')
  @ApiOperation({
    summary: 'Propose or confirm a TAC→Product mapping',
    description:
      'An Employee’s submission is recorded as a PROPOSAL and changes no suggestion anybody acts on. An Owner or Store Manager (holding catalog.manage) CONFIRMS. Replacing an existing confirmation requires the version that was read, so two managers deciding at once produce one winner.',
  })
  submit(@Body() dto: SubmitTacMappingDto) {
    return this.mappings.submit(dto);
  }
}
