import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { ConsignmentsService } from './consignments.service';
import { CreateConsignmentDto, CustodyDto, DecideConsignmentDto } from './dto/consignment.dto';

@ApiTags('consignments')
@ApiBearerAuth()
@Controller({ version: '1' })
export class ConsignmentsController {
  constructor(private readonly consignments: ConsignmentsService) {}

  @Get('consignments')
  @RequirePermissions('consignment.view')
  @ApiQuery({ name: 'group', required: false, enum: ['pending', 'accepted', 'confirmed'] })
  @ApiOperation({ summary: 'Consignments this shop is part of, either side' })
  list(@Query('group') group?: 'pending' | 'accepted' | 'confirmed') {
    return this.consignments.list(group);
  }

  @Get('consignments/:id')
  @RequirePermissions('consignment.view')
  @ApiOperation({ summary: 'One consignment, its phones and its money' })
  get(@Param('id') id: string) {
    return this.consignments.get(id);
  }

  @Post('consignments')
  @RequirePermissions('consignment.request')
  @ApiOperation({ summary: 'Propose sending phones to another store' })
  create(@Body() dto: CreateConsignmentDto) {
    return this.consignments.create(dto);
  }

  @Post('consignments/:id/decide')
  @RequirePermissions('consignment.review')
  @ApiOperation({ summary: 'Accept, counter, dispute, reject or cancel a proposal' })
  decide(@Param('id') id: string, @Body() dto: DecideConsignmentDto) {
    return this.consignments.decide(id, dto);
  }

  /**
   * Two acts, two permissions, one route.
   *
   * `send` is the source handing over and `confirm` is the destination
   * receiving. The service asserts which side may do which, so holding both
   * keys still does not let one company do both halves of a two-party
   * hand-over.
   */
  @Post('consignments/:id/custody')
  @RequirePermissions('consignment.custody.send', 'consignment.custody.receive')
  @ApiOperation({ summary: 'Record handing phones over, or confirm receiving them' })
  custody(@Param('id') id: string, @Body() dto: CustodyDto) {
    return this.consignments.custody(id, dto);
  }
}
