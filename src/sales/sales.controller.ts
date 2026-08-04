import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { SalesService } from './sales.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import { ReturnSaleDto } from './dto/return-sale.dto';

@ApiTags('sales')
@ApiBearerAuth()
@Controller({ path: 'sales', version: '1' })
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Get()
  @ApiOperation({ summary: 'List recent sales at the active branch' })
  list() {
    return this.sales.list();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Sale detail (items, payments, returns)' })
  get(@Param('id') id: string) {
    return this.sales.getById(id);
  }

  @Post()
  @RequirePermissions('sale.create')
  @ApiOperation({ summary: 'Sell (one atomic transaction): units, profit, audit, notification' })
  create(@Body() dto: CreateSaleDto) {
    return this.sales.createSale(dto);
  }

  @Post(':id/returns')
  @RequirePermissions('sale.return')
  @ApiOperation({ summary: 'Return a sold unit (reverse line, restock, refund)' })
  returnUnit(@Param('id') id: string, @Body() dto: ReturnSaleDto) {
    return this.sales.returnUnit(id, dto);
  }
}
