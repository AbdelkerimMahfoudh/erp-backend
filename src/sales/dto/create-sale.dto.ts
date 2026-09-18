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
  MinLength,
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

/**
 * A customer typed at the counter because they are not on the list yet.
 *
 * The name is what the shop will ask for when the balance is chased, so it is
 * required. The phone is optional: plenty of customers will not give one, and
 * refusing the sale over it would only push the shop back to the notebook.
 */
export class NewCustomerDto {
  @ApiProperty({ maxLength: 160 })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name: string;

  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;
}

export class CreateSaleDto {
  @ApiProperty({ type: [SaleLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SaleLineDto)
  lines: SaleLineDto[];

  /**
   * The money received NOW. May be empty (0074): a phone handed over with
   * nothing paid is a real sale, and the whole total is then owed by the
   * debtor named below. Each entry must still be a positive amount.
   */
  @ApiProperty({ type: [PaymentInputDto], description: 'Money received now. Empty when nothing was paid at the counter.' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PaymentInputDto)
  payments: PaymentInputDto[];

  /** An existing customer. Chosen from the list, so no duplicate is created. */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  /**
   * A NEW customer who owes the balance (0074): a name, and a phone if the shop
   * has one. Never combined with `customerId` or `counterpartyId`.
   */
  @ApiPropertyOptional({ type: () => NewCustomerDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => NewCustomerDto)
  customer?: NewCustomerDto;

  /**
   * A partner store — connected or manual — that owes the balance (0074).
   * Never combined with a customer: one balance, one debtor.
   */
  @ApiPropertyOptional({ format: 'uuid', description: 'Partner store owing the balance' })
  @IsOptional()
  @IsUUID()
  counterpartyId?: string;

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

  /**
   * "Yes, I meant that" — the token the server issued with the warnings.
   *
   * Not a boolean. A flag in a body authorises nothing, because any client can
   * send one; this is signed over the exact payload and the exact warnings the
   * person was shown, so a changed price cannot reuse an old confirmation. See
   * `common/warnings/acknowledgement.ts`.
   */
  @ApiPropertyOptional({ description: 'Acknowledgement token returned with warnings_pending' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  acknowledgementToken?: string;
}
