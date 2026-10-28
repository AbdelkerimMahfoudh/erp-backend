import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CostCompletionService } from './cost-completion.service';
import { CompleteCostDto } from './dto/complete-cost.dto';

/** Entering a buying cost that was not known when the stock was received (0107). Owner and Store Manager. */
@ApiTags('inventory')
@ApiBearerAuth()
@Controller({ version: '1' })
export class CostCompletionController {
  constructor(private readonly costs: CostCompletionService) {}

  @Post('units/:id/cost')
  @RequirePermissions('cost.complete', 'cost.view')
  @ApiOperation({ summary: 'Enter the missing buying cost of one item (IMEI or serial)' })
  completeUnit(@Param('id') id: string, @Body() dto: CompleteCostDto) {
    return this.costs.completeUnit(id, dto);
  }

  @Get('inventory/stock/:productId/missing-costs')
  @RequirePermissions('cost.complete', 'cost.view')
  @ApiOperation({ summary: 'The received lines of a counted product whose buying cost is not known yet' })
  missingStockLines(@Param('productId') productId: string) {
    return this.costs.missingStockLines(productId);
  }

  @Post('purchase-items/:id/cost')
  @RequirePermissions('cost.complete', 'cost.view')
  @ApiOperation({ summary: 'Enter the missing buying cost of a counted received line' })
  completeStockLine(@Param('id') id: string, @Body() dto: CompleteCostDto) {
    return this.costs.completeStockLine(id, dto);
  }
}
