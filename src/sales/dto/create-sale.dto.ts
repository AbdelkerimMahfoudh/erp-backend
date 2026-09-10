import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import { RETURN_WINDOW_MAX_HOURS, RETURN_WINDOW_NONE } from '../../settings/settings.constants';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsMoney } from '../../common/money/is-money.decorator';

/**
 * A sale line is EITHER a serialized unit (scan its `identifier` — IMEI or
 * serial) OR a quantity product (`productId` + `quantity`). The client learns
 * which from POST /scan; it never picks the tracking mode.
 */
export class SaleLineDto {
  @ApiPropertyOptional({ description: 'Serialized unit identifier (IMEI or serial)', example: '123456789012347' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  identifier?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;

  @ApiPropertyOptional({ minimum: 0, description: 'Overrides the default price' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsMoney({ min: 0 })
  price?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsMoney({ min: 0 })
  discount?: number;
}

export class PaymentInputDto {
  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @ApiProperty({ minimum: 0.01 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @IsMoney({ min: 0.01 })
  amount: number;

  /**
   * Which receiving account the money landed in (E-CP1).
   *
   * Money going OUT was already attributed — refunds, supplier payments and
   * expenses all name an account — but money coming IN was not, so no account
   * could have an expected balance and none could be reconciled.
   *
   * Optional, and never guessed: a non-cash payment that names no account is
   * reported honestly as unattributed rather than being assigned to whichever
   * account looks likely. Must be absent for cash, which belongs to the drawer.
   */
  @ApiPropertyOptional({ format: 'uuid', description: 'Receiving account; omit for cash' })
  @IsOptional()
  @IsUUID()
  receivingAccountId?: string;
}

export class CreateSaleDto {
  @ApiProperty({ type: [SaleLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SaleLineDto)
  lines: SaleLineDto[];

  @ApiProperty({ type: [PaymentInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PaymentInputDto)
  payments: PaymentInputDto[];

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ minimum: 0, description: 'Whole-sale discount' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsMoney({ min: 0 })
  saleDiscount?: number;

  @ApiPropertyOptional({ maxLength: 255, description: 'Required for below-cost / over-limit overrides' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  overrideReason?: string;

  /**
   * The return window THIS sale is sold under, in hours.
   *
   * Omitted, or equal to the shop's default, means the ordinary policy — the
   * Sell screen echoes what it displayed, and that must not count as an
   * override or every sale would need a reason. Anything else requires
   * `return.policy.override` and `returnPolicyReason`, and is refused rather
   * than quietly downgraded: an employee must never be told a sale succeeded
   * under a policy it does not have.
   */
  @ApiPropertyOptional({
    minimum: RETURN_WINDOW_NONE,
    maximum: RETURN_WINDOW_MAX_HOURS,
    description: 'Return window in hours for this sale. 0 = no returns. Manager/Owner only when it differs from the shop default.',
  })
  @IsOptional()
  @IsInt()
  @Min(RETURN_WINDOW_NONE)
  @Max(RETURN_WINDOW_MAX_HOURS)
  returnWindowHours?: number;

  @ApiPropertyOptional({ maxLength: 255, description: 'Why this sale has a different return policy' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  returnPolicyReason?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Offline idempotency key' })
  @IsOptional()
  @IsUUID()
  clientUuid?: string;
}
