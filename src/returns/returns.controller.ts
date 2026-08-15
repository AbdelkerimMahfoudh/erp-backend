import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { ReturnsService } from './returns.service';
import {
  AdjustmentDto,
  ApproveReturnDto,
  CreateReturnRequestDto,
  InvestigateDto,
  ListReturnsDto,
  ReceiveCustodyDto,
  RejectReturnDto,
} from './dto/return.dto';

/**
 * The reviewed return workflow (I2).
 *
 * Every route is branch-scoped: none of these permissions is in
 * `COMPANY_PERMISSIONS`, so a caller sending another branch's header — or no
 * header — is refused while permissions are resolved, before any handler runs.
 *
 * Permissions are only the FIRST gate. The service still enforces lifecycle,
 * custody, policy, responsibility and exception rules, because "may this person
 * act at all" and "is this action legal right now" are different questions.
 */
@ApiTags('returns')
@ApiBearerAuth()
@Controller({ path: 'returns', version: '1' })
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Get()
  @RequirePermissions('return.view')
  @ApiOperation({
    summary: 'Returns at the active branch — searched and paged in SQL',
    description:
      'Keyset paging on the UUIDv7 primary key. Every total is PROVISIONAL until an approval writes the immutable reversal.',
  })
  list(@Query() query: ListReturnsDto) {
    return this.returns.list(query);
  }

  @Get(':id')
  @RequirePermissions('return.view')
  @ApiOperation({
    summary: 'One return in full — policy snapshot, custody, timeline and provisional refund',
  })
  detail(@Param('id') id: string) {
    return this.returns.detail(id);
  }

  @Post()
  @RequirePermissions('return.request')
  @ApiOperation({
    summary: 'Raise a return request against one serialized sale line',
    description:
      'Idempotent on clientUuid: the same key with the same payload returns the original request, and with a different payload returns 409. The identifier must belong to the phone on that sale line.',
  })
  create(@Body() dto: CreateReturnRequestDto) {
    return this.returns.create(dto);
  }

  /**
   * Taking the phone in. Deliberately guarded on `return.request` rather than
   * `return.review`: the employee who takes the complaint at the counter is the
   * one physically handed the phone, and making them wait for a manager to
   * record custody would either stall the customer or produce a false record.
   * It grants no review or approval authority.
   */
  @Post(':id/custody')
  @RequirePermissions('return.request')
  @ApiOperation({ summary: 'Record that the store physically received the phone' })
  receiveCustody(@Param('id') id: string, @Body() dto: ReceiveCustodyDto) {
    return this.returns.receiveCustody(id, dto);
  }

  @Patch(':id/investigation')
  @RequirePermissions('return.review')
  @ApiOperation({ summary: 'Start or update the investigation, and assign responsibility' })
  investigate(@Param('id') id: string, @Body() dto: InvestigateDto) {
    return this.returns.investigate(id, dto);
  }

  @Post(':id/adjustments')
  @RequirePermissions('return.review')
  @ApiOperation({
    summary: 'Add a draft charge withheld from the refund',
    description:
      'The server multiplies and sums; the client never sends a total. Adjustments cannot exceed the gross refund. Nothing here creates a sale, payment or accounting entry.',
  })
  addAdjustment(@Param('id') id: string, @Body() dto: AdjustmentDto) {
    return this.returns.addAdjustment(id, dto);
  }

  @Post(':id/approve')
  @RequirePermissions('return.approve')
  @ApiOperation({
    summary: 'Approve a return — creates a refund OBLIGATION, not a payment',
    description:
      'Requires store custody, a decided responsibility and the current version. An out-of-policy return or customer-caused damage additionally requires return.exception and a written reason. Refused with 409 if the approval day is already closed.',
  })
  approve(@Param('id') id: string, @Body() dto: ApproveReturnDto) {
    return this.returns.approve(id, dto);
  }

  @Post(':id/reject')
  @RequirePermissions('return.reject')
  @ApiOperation({ summary: 'Reject a return, with a mandatory reason, handing the phone back if held' })
  reject(@Param('id') id: string, @Body() dto: RejectReturnDto) {
    return this.returns.reject(id, dto);
  }

  @Delete(':id/adjustments/:adjustmentId')
  @RequirePermissions('return.review')
  @ApiOperation({ summary: 'Remove a draft adjustment while the return is still reviewable' })
  removeAdjustment(
    @Param('id') id: string,
    @Param('adjustmentId') adjustmentId: string,
    @Query('expectedVersion') expectedVersion: string,
  ) {
    return this.returns.removeAdjustment(id, adjustmentId, Number(expectedVersion));
  }
}
