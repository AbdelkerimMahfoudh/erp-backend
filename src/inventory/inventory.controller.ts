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
    summary: 'Stock at the active branch — discriminated by `kind`',
    description:
      'Returns both shapes of stock: `kind:"unit"` for serialized devices ' +
      '(identifier + status) and `kind:"stock"` for quantity-tracked products ' +
      '(count, no status). Quantity rows appear only when no status filter is ' +
      'applied or the filter is `in_stock`, since they have no lifecycle.',
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
