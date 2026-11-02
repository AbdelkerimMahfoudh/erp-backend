import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
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

class CartApprovalLineDto {
  @IsOptional() @IsString() @MaxLength(64) identifier?: string;
  @IsOptional() @IsUUID() productId?: string;
  @IsOptional() @IsInt() @Min(1) quantity?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @IsMoney({ min: 0 }) price?: number;
}

/** The lines exactly as the sale will send them: the server works out the cart's hash from them. */
export class RequestCartApprovalDto {
  @IsUUID() clientUuid!: string;
  @IsString() @MaxLength(255) reason!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => CartApprovalLineDto) lines!: CartApprovalLineDto[];
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @IsMoney({ min: 0 }) saleDiscount?: number;
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
