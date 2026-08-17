import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { ConsignmentsService } from './consignments.service';
import {
  ConsignmentPaymentDto,
  CreateConsignmentDto,
  CustodyDto,
  DecideConsignmentDto,
  ForgiveDto,
  ReportSoldDto,
  ReturnDto,
} from './dto/consignment.dto';

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

  /**
   * Report that a consigned phone sold.
   *
   * This is where the source's profit is recognised, once. Store 1 learns that
   * it sold and nothing else — not the customer, not the resale price, not
   * Store 2's margin.
   */
  @Post('consignments/:id/sold')
  @RequirePermissions('consignment.sell')
  @ApiOperation({ summary: 'Report that a consigned phone was sold' })
  reportSold(@Param('id') id: string, @Body() dto: ReportSoldDto) {
    return this.consignments.reportSold(id, dto);
  }

  /**
   * Report a payment, or confirm one arrived.
   *
   * Both keys are required at the route; the service decides which side may do
   * which, so holding both still does not let one company report and confirm
   * its own payment.
   */
  @Post('consignments/:id/payment')
  @RequirePermissions('consignment.payment.report', 'consignment.payment.confirm')
  @ApiOperation({ summary: 'Report a consignment payment, or confirm one arrived' })
  payment(@Param('id') id: string, @Body() dto: ConsignmentPaymentDto) {
    return this.consignments.payment(id, dto);
  }

  /** Creditor's Owner only. Reduces the receivable and is never cash. */
  @Post('consignments/:id/forgive')
  @RequirePermissions('consignment.forgive')
  @ApiOperation({ summary: 'Write off part or all of what is owed' })
  forgive(@Param('id') id: string, @Body() dto: ForgiveDto) {
    return this.consignments.forgive(id, dto);
  }

  /**
   * Send an unsold phone back, and accept it.
   *
   * The unit returns to stock only when the OWNER confirms physical receipt —
   * a phone marked available while still in transit is one the shop will try to
   * sell twice.
   */
  @Post('consignments/:id/return')
  @RequirePermissions('consignment.return.confirm')
  @ApiOperation({ summary: 'Start, ship, or confirm a return' })
  returnFlow(@Param('id') id: string, @Body() dto: ReturnDto) {
    return this.consignments.returnFlow(id, dto);
  }
}
