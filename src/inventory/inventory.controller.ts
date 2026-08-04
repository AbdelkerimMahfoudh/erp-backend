import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { InventoryService } from './inventory.service';
import { QuickAddUnitDto } from './dto/quick-add-unit.dto';
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

  @Get('units/:identifier')
  @ApiOperation({ summary: 'Unit detail by identifier (IMEI or serial), with audit-derived timeline' })
  byIdentifier(@Param('identifier') identifier: string) {
    return this.inventory.findByIdentifierWithTimeline(identifier);
  }

  @Post('units')
  @RequirePermissions('unit.add')
  @ApiOperation({ summary: 'Quick add a single unit to stock (no supplier)' })
  quickAdd(@Body() dto: QuickAddUnitDto) {
    return this.inventory.quickAdd(dto);
  }

  @Post('units/:id/faulty')
  @RequirePermissions('unit.add')
  @ApiOperation({ summary: 'Mark a unit faulty' })
  markFaulty(@Param('id') id: string) {
    return this.inventory.markFaulty(id);
  }
}
