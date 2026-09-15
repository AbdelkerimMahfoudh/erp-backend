import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { InventoryService } from './inventory.service';
import { InventoryQueryDto } from './dto/inventory-query.dto';

@ApiTags('inventory')
@ApiBearerAuth()
@Controller({ version: '1' })
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('inventory')
  @ApiOperation({
    summary: 'Stock at the active branch — paginated, discriminated by `kind`',
    description:
      'Returns `{ rows, nextCursor, hasMore, totals }`. Rows carry ' +
      '`kind:"unit"` for serialized devices (identifier + status) or ' +
      '`kind:"stock"` for quantity-tracked products (count, no status). ' +
      'Quantity rows appear only when no status filter is applied or it is ' +
      '`in_stock`, since they have no lifecycle. ' +
      'Paging is keyset-based: pass `nextCursor` back verbatim. `totals` counts ' +
      'everything matching the filter, not just the returned page, so a client ' +
      'can never mistake the first page for the whole inventory.',
  })
  list(@Query() query: InventoryQueryDto) {
    return this.inventory.listStock(query);
  }

  @Get('inventory/by-model')
  @ApiOperation({
    summary: 'Stock counted by model, from the Unit rows themselves',
    description:
      'One row per product with the number of `in_stock` units in the active ' +
      'branch — "iPhone 17 Pro Max, 4 in stock". Every phone remains an ' +
      'individual Unit with its own IMEI and stays searchable by either ' +
      'identifier; this only changes how the shelf is PRESENTED. The count is ' +
      'derived on every request, never stored and never maintained by a ' +
      'client, so a sale or a transfer moves it through the existing status ' +
      'model without anything else being told.',
  })
  byModel() {
    return this.inventory.countByModel();
  }

  @Get('inventory/summary')
  @ApiOperation({
    summary: 'The Stock screen: one row per exact variant at the active branch',
    description:
      'Serialized variants with at least one `in_stock` unit, and every quantity ' +
      'stock line the branch holds. Each row carries `available` (sellable now — ' +
      'reserved quantity excluded), and `price`: the ' +
      'min/max of prices resolved through the sale’s own ladder, with priced and ' +
      'unpriced counts, or null when nothing is priced. **No cost or margin, in any ' +
      'shape.** Requires an active branch. Not paginated: it is one row per ' +
      'variant, not per unit — unit lists stay on `GET /inventory`.',
  })
  summary() {
    return this.inventory.summarizeStock();
  }

  @Get('units/:identifier')
  @ApiOperation({ summary: 'Unit detail by identifier (IMEI or serial), with audit-derived timeline' })
  byIdentifier(@Param('identifier') identifier: string) {
    return this.inventory.findByIdentifierWithTimeline(identifier);
  }

  /*
   * `POST /units` (quick add) is no longer exposed. It created sellable stock
   * with no purchase and no payment, which the first release forbids for
   * ordinary receiving: every received phone is a purchase paid in full
   * (`POST /purchases`). Opening inventory is brought in by the Owner-only
   * import. The service method remains, dormant, with its own spec.
   */

  @Post('units/:id/faulty')
  @RequirePermissions('unit.add')
  @ApiOperation({ summary: 'Mark a unit faulty' })
  markFaulty(@Param('id') id: string) {
    return this.inventory.markFaulty(id);
  }
}
