import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { IsMoney } from '../../common/money/is-money.decorator';

/** Ask the Owner to allow one sale below the configured selling price. */
export class RequestDiscountApprovalDto {
  @ApiProperty({ description: 'The exact physical unit this is about' })
  @IsUUID()
  unitId!: string;

  @ApiProperty({ description: 'The final unit price being asked for' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsMoney({ min: 0 })
  requestedPrice!: number;

  /** Required when the price is below cost; optional otherwise. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;

  /** Retry safety, the same pair every other mutation here uses. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  clientUuid?: string;
}

export class DecideDiscountApprovalDto {
  @ApiProperty({ description: 'True to approve, false to reject' })
  @IsBoolean()
  approve!: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;

  /**
   * The version the Owner was looking at.
   *
   * Two Owners deciding at once then produce one winner and one honest
   * conflict, rather than a silent last-write.
   */
  @ApiProperty()
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}
