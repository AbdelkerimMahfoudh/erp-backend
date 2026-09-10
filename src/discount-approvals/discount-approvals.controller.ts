import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DiscountApprovalStatus } from '@prisma/client';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { DiscountApprovalsService } from './discount-approvals.service';
import { DecideDiscountApprovalDto, RequestDiscountApprovalDto } from './dto/discount-approval.dto';

/**
 * Asking to sell below the configured price, and the Owner's answer (A2).
 *
 * Requesting needs `sale.create` — the same permission as making the sale it is
 * for. Deciding needs `discount.override`, which A2 made **Owner-only**: it is
 * no longer a bypass its holder can use to sell below the floor directly.
 *
 * An Owner holds both, and may therefore approve their own request. That is
 * deliberate: it routes their exception through the same audited workflow as
 * everybody else's rather than letting it happen invisibly.
 */
@ApiTags('discount-approvals')
@Controller('discount-approvals')
export class DiscountApprovalsController {
  constructor(private readonly approvals: DiscountApprovalsService) {}

  @Post()
  @RequirePermissions('sale.create')
  @ApiOperation({ summary: 'Ask the Owner to allow one sale below the set price' })
  request(@Body() dto: RequestDiscountApprovalDto) {
    return this.approvals.request(dto);
  }

  @Get()
  @RequirePermissions('sale.create')
  @ApiOperation({ summary: 'Requests in this company, newest first' })
  list(@Query('status') status?: DiscountApprovalStatus) {
    return this.approvals.list(status);
  }

  @Post(':id/decide')
  @RequirePermissions('discount.override')
  @ApiOperation({ summary: 'Approve or reject one request (Owner only)' })
  decide(@Param('id') id: string, @Body() dto: DecideDiscountApprovalDto) {
    return this.approvals.decide(id, dto);
  }

  @Post(':id/cancel')
  @RequirePermissions('sale.create')
  @ApiOperation({ summary: 'Withdraw your own pending request' })
  cancel(@Param('id') id: string) {
    return this.approvals.cancel(id);
  }
}
