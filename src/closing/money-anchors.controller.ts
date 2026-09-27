import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { RecordMoneyAnchorDto } from './dto/record-money-anchor.dto';
import { MoneyAnchorsService } from './money-anchors.service';

@ApiTags('money')
@ApiBearerAuth()
@Controller({ version: '1' })
export class MoneyAnchorsController {
  constructor(private readonly anchors: MoneyAnchorsService) {}

  /**
   * Record what a receiving account holds now (docs/60). The Owner's alone and
   * never delegated: from this moment the account's tracked position is this
   * amount plus what moves after it. Recorded at the branch in context, like
   * every other money record.
   */
  @Post('money/anchors')
  @RequirePermissions('money.anchor.record')
  @ApiOperation({ summary: 'Record the amount a receiving account holds now (Owner)' })
  record(@Body() dto: RecordMoneyAnchorDto) {
    return this.anchors.record(dto);
  }
}
