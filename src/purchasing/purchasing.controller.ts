import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { PurchasingService } from './purchasing.service';
import { CreatePurchaseDto } from './dto/create-purchase.dto';

@ApiTags('purchasing')
@ApiBearerAuth()
@Controller({ path: 'purchases', version: '1' })
export class PurchasingController {
  constructor(private readonly purchasing: PurchasingService) {}

  @Post()
  @RequirePermissions('purchase.manage', 'unit.add')
  @ApiOperation({ summary: 'Receive a purchase: create units/stock, payable, audit' })
  create(@Body() dto: CreatePurchaseDto) {
    return this.purchasing.createPurchase(dto);
  }
}
