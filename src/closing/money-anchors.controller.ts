import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsBoolean, IsNumber, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { IsMoney } from '../common/money/is-money.decorator';
import { ClosingService } from './closing.service';
import { MoneyTrackingStore } from './money-tracking.service';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { RecordMoneyAnchorDto } from './dto/record-money-anchor.dto';
import { MoneyAnchorsService } from './money-anchors.service';

export class SetMoneyTrackingDto {
  @IsString() @MaxLength(36) location!: string;
  @IsBoolean() on!: boolean;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @IsMoney({ min: 0 }) openingAmount?: number;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) effectiveDate?: string;
  @IsOptional() @IsNumber() expectedVersion?: number;
}

@ApiTags('money')
@ApiBearerAuth()
@Controller({ version: '1' })
export class MoneyAnchorsController {
  constructor(
    private readonly anchors: MoneyAnchorsService,
    private readonly closing: ClosingService,
    private readonly tracking: MoneyTrackingStore,
  ) {}

  /** The Owner's, as a declared balance is: which locations are dedicated, and each one's expected figure. */
  @Get('money/tracking')
  @RequirePermissions('money.anchor.record')
  @ApiOperation({ summary: 'Dedicated store balances: expected from Dukan records, never a live balance' })
  trackedBalances() {
    return this.closing.trackedBalances();
  }

  /** Anyone who reads the store's reports (Owner, Manager): this store's tracked cash only, read-only (D227 option A). */
  @Get('money/tracking/cash')
  @RequirePermissions('report.view')
  @ApiOperation({ summary: "This store's tracked cash, expected from Dukan records; nothing when cash is not tracked" })
  trackedCash() {
    return this.closing.trackedCash();
  }

  @Post('money/tracking')
  @RequirePermissions('money.anchor.record')
  async setTracking(@Body() dto: SetMoneyTrackingDto) {
    await this.tracking.set(dto);
    return this.closing.trackedBalances();
  }

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
